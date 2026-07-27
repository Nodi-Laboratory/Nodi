"use client";

// Concept-card canvas workspace — replaces the 3-panel tree workspace on the
// space route. Owns camera / tree-open / drawer / highlight; delegates streaming
// + rehydration to useConceptStream. Ported from Nodi-figma/app/page.js and wired
// to Nodi's session/space lifecycle (mirrors WorkspaceInner).

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { spaceTargetFromId, uploadFile } from "@/lib/api";
import { CARD_CX, cardHeight } from "@/lib/concept/cardMetrics";
import { useConceptStream } from "@/lib/concept/useConceptStream";
import { useTagLayout } from "@/lib/concept/useTagLayout";
import type { CanvasLeafNode, Concept } from "@/lib/concept/types";
import { sessionFilesKey } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import NoteCanvas, { focusCamera, type Camera } from "./NoteCanvas";
import MapLoadingIndicator from "./MapLoadingIndicator";
import ConceptCard from "./ConceptCard";
import TagMarker from "./TagMarker";
import FigureNode from "./FigureNode";
import ConceptTreePanel from "./ConceptTreePanel";
import TopBar from "./TopBar";
import BottomBar from "./BottomBar";
import SessionFilesBar from "./SessionFilesBar";
import SessionDrawer from "./SessionDrawer";

// Card center offset for focus/centering (CARD_CX = 카드 폭 절반, cardMetrics SSOT).
const CARD_CY = 200;
const INITIAL_CAMERA: Camera = { x: 120, y: 80, scale: 1 };

// 미분류 개념의 폴백 태그(useTagLayout 시드/tagAnchor와 일치).
const DEFAULT_TAG = "기타";

// 카메라 추종: 이만큼 움직여야 카메라를 다시 옮긴다(px). sim이 수렴할 때의
// 미세 진동으로 카메라가 떨리지 않게 하는 문턱값.
const FOLLOW_EPS_PX = 0.5;
// 움직임 없는 프레임이 이만큼 이어지면 추종을 끝낸다(≈0.5초).
const FOLLOW_SETTLE_FRAMES = 30;

// 리프 노드를 앵커 개념의 sim 좌표로 재앵커한다: 앵커가 스트림 좌표에서 sim 좌표로
// 이동한 만큼(Δ) 리프도 함께 옮겨 상대 오프셋을 보존한다. 앵커 sim 위치가 없으면
// 기존 좌표를 그대로 유지(best-effort 오버레이).
function reanchorLeaf(
  node: CanvasLeafNode,
  concepts: Concept[],
  positions: Map<string, { x: number; y: number }>,
): CanvasLeafNode {
  const anchor = node.conceptId
    ? concepts.find((c) => c.id === node.conceptId)
    : undefined;
  const anchorPos = anchor ? positions.get(anchor.id) : undefined;
  if (!anchor || !anchorPos) return node;
  return {
    ...node,
    x: anchorPos.x + (node.x - anchor.x),
    y: anchorPos.y + (node.y - anchor.y),
  };
}

// 태그 마커의 y = 그 태그에 속한(비-pending) 카드들의 최상단 sim y. 배치된 카드가
// 없으면 fallback(무게중심 y)을 쓴다.
function tagMarkerTopY(
  tag: string,
  concepts: Concept[],
  positions: Map<string, { x: number; y: number }>,
  fallbackY: number,
): number {
  let topY = Infinity;
  for (const con of concepts) {
    if (con.pending || (con.cluster || DEFAULT_TAG) !== tag) continue;
    const p = positions.get(con.id);
    if (p) topY = Math.min(topY, p.y);
  }
  return Number.isFinite(topY) ? topY : fallbackY;
}

export function ConceptCanvasWorkspace({ spaceId }: { spaceId: string }) {
  const target = spaceTargetFromId(spaceId);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const reset = useWorkspaceStore((s) => s.reset);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pendingSession = useWorkspaceStore((s) => s.pendingSession);
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  const { concepts, leafNodes, reply, busy, loading, focusSignal, send, ensureSession } =
    useConceptStream(target);

  // D83 부속: 프롬프트 창(BottomBar) 첨부 소유 — 세션이 없으면 먼저 만들고(첫
  // 질문과 동일 흐름) 그 세션의 컨텍스트로 업로드한다. RAG 미구축은 백엔드 워커가
  // 보장. 오류는 SessionFilesBar에 사유로 표시(화면을 깨뜨리지 않음).
  const queryClient = useQueryClient();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const attach = useMutation({
    mutationFn: async (file: File) => {
      const sid = await ensureSession();
      if (!sid) throw new Error("세션을 만들지 못했습니다.");
      return uploadFile(target, file, { session_id: sid });
    },
    onSuccess: (row) => {
      setUploadError(null);
      queryClient.invalidateQueries({
        queryKey: sessionFilesKey(row.session_id ?? null),
      });
    },
    onError: (e: Error) => setUploadError(e.message),
  });

  // 태그 클러스터 d3-force 레이아웃(비-pending 개념만). positions로 카드/리프 좌표를
  // 오버레이하고, tagCentroids로 태그 마커를 무게중심에 렌더한다.
  const layoutItems = concepts
    .filter((c) => !c.pending)
    .map((c) => ({
      id: c.id,
      tag: c.cluster || DEFAULT_TAG,
      h: cardHeight(c, !!c.sources && c.sources.length > 0),
    }));
  const { positions, tagCentroids, positionsRef } = useTagLayout(layoutItems);

  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [treeOpen, setTreeOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 클러스터 클릭은 팬 전용(하이라이트 없음).
  const didInitFocus = useRef(false);

  // Container viewport (canvas fills <main>, which is width minus the icon rail).
  const vp = useCallback(() => {
    const el = rootRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }
    return { w: window.innerWidth, h: window.innerHeight };
  }, []);

  // Space entry: clear selection + record active space (mirrors WorkspaceInner).
  useEffect(() => {
    reset();
    setActiveSpace(spaceId);
  }, [reset, setActiveSpace, spaceId]);

  // Consume a pending session handed off from Home (select + optional seed).
  useEffect(() => {
    if (!pendingSession || pendingSession.spaceId !== spaceId) return;
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current !== pendingSession.sessionId) {
      setActiveSession(pendingSession.sessionId);
      return;
    }
    if (pendingSession.seed) {
      if (busy) return;
      const seed = pendingSession.seed;
      setPendingSession(null);
      void send(seed);
    } else {
      setPendingSession(null);
    }
  }, [
    pendingSession,
    spaceId,
    activeSessionId,
    busy,
    send,
    setActiveSession,
    setPendingSession,
  ]);

  // Re-arm the initial auto-focus when the session changes.
  useEffect(() => {
    didInitFocus.current = false;
  }, [activeSessionId]);

  // 초기 포커스(재수화 등): 첫 카드의 sim 위치가 정해지면 1회 팬. sim이 배치할 때까지 대기.
  useEffect(() => {
    if (didInitFocus.current || concepts.length === 0) return;
    const c = concepts[0];
    const p = positions.get(c.id);
    if (!p) return;
    didInitFocus.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCamera(focusCamera(vp(), { x: p.x + CARD_CX, y: p.y + CARD_CY }, 1));
  }, [concepts, positions, vp]);

  // 생성 지점 자동 포커싱: 새 답변 첫 개념(focusSignal.id)의 sim 위치를 추종한다.
  // 카드가 d3-force로 자기 태그 앵커로 이동하는 동안 카메라도 함께 이동하고,
  // 시뮬이 수렴하면 추종을 멈춘다. 배율은 유지.
  //
  // **positions 상태에 의존하지 않는다**(2026-07-27). 예전에는 deps에 positions가
  // 있었는데, 그 Map은 sim 틱마다 새로 만들어진다 → 틱 → 렌더 → 이 이펙트 →
  // setCamera → 커밋 → 다음 틱 …이 매 프레임 연쇄해 React가 중첩 업데이트
  // 한도(50)를 넘겼다("Maximum update depth exceeded", 질문 1회당 3~4건).
  // 대신 rAF 루프가 positionsRef에서 최신 좌표를 직접 읽는다 — 커밋 단계 밖에서
  // 갱신되므로 사슬이 끊긴다.
  useEffect(() => {
    const id = focusSignal?.id;
    if (!id) return;
    let raf = 0;
    let last: { x: number; y: number } | null = null;
    let still = 0; // 움직임 없는 연속 프레임 수
    const follow = () => {
      const p = positionsRef.current.get(id);
      if (p) {
        const moved =
          !last || Math.hypot(p.x - last.x, p.y - last.y) > FOLLOW_EPS_PX;
        if (moved) {
          still = 0;
          last = { x: p.x, y: p.y };
          setCamera((prev) =>
            focusCamera(vp(), { x: p.x + CARD_CX, y: p.y + CARD_CY }, prev.scale),
          );
        } else if (++still >= FOLLOW_SETTLE_FRAMES) {
          return; // 수렴 — rAF를 더 돌리지 않는다(빈 루프가 남지 않게).
        }
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [focusSignal, positionsRef, vp]);

  const zoomBy = useCallback(
    (factor: number) => {
      setCamera((prev) => {
        const { w, h } = vp();
        const cx = (w / 2 - prev.x) / prev.scale;
        const cy = (h / 2 - prev.y) / prev.scale;
        return focusCamera({ w, h }, { x: cx, y: cy }, prev.scale * factor);
      });
    },
    [vp],
  );

  const resetCamera = useCallback(() => {
    const c0 = concepts[0];
    if (c0) {
      const p = positions.get(c0.id) ?? { x: c0.x, y: c0.y };
      setCamera(focusCamera(vp(), { x: p.x + CARD_CX, y: p.y + CARD_CY }, 1));
    } else {
      setCamera(INITIAL_CAMERA);
    }
  }, [concepts, positions, vp]);

  return (
    <div
      ref={rootRef}
      className="nodi-canvas relative h-full w-full overflow-hidden"
      style={{ background: "var(--bg)" }}
    >
      <TopBar
        zoom={camera.scale * 100}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onReset={resetCamera}
        onMenu={() => setDrawerOpen(true)}
        treeOpen={treeOpen}
        onToggleTree={() => setTreeOpen((v) => !v)}
      />

      {/* D100: Welcome을 NoteCanvas(팬/줌 변환 평면) 밖으로 뺐다. 캔버스 좌표
          left:240/top:130에 고정돼 있어 뷰포트 중앙이 아니었고, 좁은 화면에서는
          우측으로 밀려 잘렸다(768px 실측). 카메라를 따라 움직일 이유도 없는
          정적 인사말이다. */}
      {concepts.length === 0 && !loading && <Welcome />}

      <NoteCanvas camera={camera} onCameraChange={setCamera}>
        {concepts.map((c) => {
          // sim 좌표 우선, 아직 배치 전이면 기존 좌표 폴백.
          const p = positions.get(c.id);
          const laid = p ? { ...c, x: p.x, y: p.y } : c;
          return <ConceptCard key={c.id} concept={laid} />;
        })}
        {/* 리프 노드(figure) — 개념 다음에 렌더(스폰 애니메이션은 .nodi-spawn).
            앵커 개념의 sim 좌표로 리프를 재앵커(anchor의 스트림 좌표 대비 오프셋 유지).
            앵커 sim 위치가 없으면 기존 좌표 유지(best-effort 오버레이). */}
        {leafNodes.map((n) => {
          const laid = reanchorLeaf(n, concepts, positions);
          return <FigureNode key={n.id} node={laid} />;
        })}
        {/* 태그 마커 — 클러스터 위(최상단 카드보다 위)로 띄워 카드와 안 겹침 + zIndex. */}
        {[...tagCentroids.entries()].map(([tag, c]) => {
          const markerY = tagMarkerTopY(tag, concepts, positions, c.y);
          return <TagMarker key={tag} tag={tag} x={c.x} y={markerY} count={c.count} />;
        })}
        {/* 맵 앵커 로딩 — 생성 지점 버블(추종 카드의 sim 위치, 없으면 near 폴백). */}
        {focusSignal && (
          <MapLoadingIndicator
            x={positions.get(focusSignal.id)?.x ?? focusSignal.x}
            y={positions.get(focusSignal.id)?.y ?? focusSignal.y}
            visible={loading}
          />
        )}
      </NoteCanvas>

      <ConceptTreePanel
        open={treeOpen}
        onToggle={() => setTreeOpen((v) => !v)}
        tagNodes={[...tagCentroids.entries()].map(([tag, c]) => ({
          tag,
          x: c.x,
          y: c.y,
          count: c.count,
        }))}
        onFocus={(target) =>
          setCamera(focusCamera(vp(), { x: target.x, y: target.y }, 1))
        }
      />

      <SessionFilesBar sessionId={activeSessionId} uploadError={uploadError} />

      <BottomBar
        onSend={send}
        busy={busy}
        reply={reply}
        onAttach={(file) => attach.mutate(file)}
        attachBusy={attach.isPending}
      />

      <SessionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        target={target}
      />
    </div>
  );
}

function Welcome() {
  return (
    <div
      data-testid="welcome"
      style={{
        // 뷰포트 중앙 정렬. 하단 바(약 112px)와 상단 바만큼 여백을 둬 시각
        // 중심이 아래로 치우치지 않게 한다.
        position: "absolute",
        inset: 0,
        paddingTop: 64,
        paddingBottom: 112,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 10,
        pointerEvents: "none",
        userSelect: "none",
        // 카드가 아직 없을 때만 뜨므로 겹칠 대상은 없지만, 상/하단 바보다는 아래.
        zIndex: 1,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/nodi-mascot.png"
        alt="노디 마스코트"
        style={{
          height: 220,
          width: "auto",
          marginBottom: 4,
          // D100: mixBlendMode:"multiply" + borderRadius 제거. 마스코트 PNG에
          // 흰 배경이 구워져 있어 multiply로 지우고 있었는데, 이 방식은 뒤
          // 배경이 균일할 때만 통한다 — 캔버스에는 방사형 글로우가 깔려 있어
          // 흰 사각형 경계가 그대로 드러났다. PNG 자체를 투명 배경으로 바꿨다.
          //
          // 원본 아트워크가 몸통 아래를 잘라 끝내서 투명 전환 후 직선 절단면이
          // 보인다. 하단만 부드럽게 페이드해 캔버스에 잠기는 것처럼 만든다.
          maskImage: "linear-gradient(to bottom, #000 84%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, #000 84%, transparent 100%)",
        }}
      />
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-title)",
          fontSize: 40,
          lineHeight: 1.1,
          color: "var(--ink)",
        }}
      >
        안녕! 나는 노디야
      </p>
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-body)",
          fontSize: 19,
          color: "var(--ink)",
          opacity: 0.68,
        }}
      >
        아래 입력창에 궁금한 개념을 물어봐
      </p>
    </div>
  );
}
