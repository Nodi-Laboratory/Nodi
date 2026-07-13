"use client";

// Concept-card canvas workspace — replaces the 3-panel tree workspace on the
// space route. Owns camera / tree-open / drawer / highlight; delegates streaming
// + rehydration to useConceptStream. Ported from Nodi-figma/app/page.js and wired
// to Nodi's session/space lifecycle (mirrors WorkspaceInner).

import { useCallback, useEffect, useRef, useState } from "react";
import { spaceTargetFromId } from "@/lib/api";
import { useConceptStream } from "@/lib/concept/useConceptStream";
import { useTagLayout } from "@/lib/concept/useTagLayout";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import NoteCanvas, { focusCamera, type Camera } from "./NoteCanvas";
import MapLoadingIndicator from "./MapLoadingIndicator";
import ConceptCard from "./ConceptCard";
import TagMarker from "./TagMarker";
import VideoNode from "./VideoNode";
import ArtNode from "./ArtNode";
import ConceptTreePanel from "./ConceptTreePanel";
import TopBar from "./TopBar";
import BottomBar from "./BottomBar";
import SessionDrawer from "./SessionDrawer";

// Card center offset (card ~420 wide) for focus/centering.
const CARD_CX = 210;
const CARD_CY = 200;
const INITIAL_CAMERA: Camera = { x: 120, y: 80, scale: 1 };

export function ConceptCanvasWorkspace({ spaceId }: { spaceId: string }) {
  const target = spaceTargetFromId(spaceId);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const reset = useWorkspaceStore((s) => s.reset);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pendingSession = useWorkspaceStore((s) => s.pendingSession);
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  const { concepts, leafNodes, reply, busy, loading, focusSignal, send } =
    useConceptStream(target);

  // 태그 클러스터 d3-force 레이아웃(비-pending 개념만). positions로 카드/리프 좌표를
  // 오버레이하고, tagCentroids로 태그 마커를 무게중심에 렌더한다.
  const layoutItems = concepts
    .filter((c) => !c.pending)
    .map((c) => ({ id: c.id, tag: c.cluster || "기타", h: c.h ?? 216 }));
  const { positions, tagCentroids } = useTagLayout(layoutItems);

  const [camera, setCamera] = useState<Camera>(INITIAL_CAMERA);
  const [treeOpen, setTreeOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 클러스터 클릭은 팬 전용(하이라이트 없음). activeId는 여전히 ConceptCard에 전달되나
  // 현재 세터가 없어 null 유지 — 향후 하이라이트 재도입 시 setter를 다시 추가한다.
  const [activeId] = useState<string | null>(null);
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

  // 미니맵 카메라 사각형용 렌더-세이프 뷰포트 크기(ref를 렌더 중 읽지 않도록 상태로 추적).
  const [vpSize, setVpSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const sync = () => setVpSize(vp());
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vp]);

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

  // Focus the first card once it exists.
  useEffect(() => {
    if (didInitFocus.current || concepts.length === 0) return;
    didInitFocus.current = true;
    const c = concepts[0];
    setCamera(focusCamera(vp(), { x: c.x + CARD_CX, y: c.y + CARD_CY }, 1));
  }, [concepts, vp]);

  // 생성 지점 자동 포커싱: 새 답변의 첫 개념 좌표로 부드럽게 1회 팬(NoteCanvas 0.7s 트랜지션).
  // focusSignal.key가 매 send 증가 → 같은 좌표라도 재발화. 재수화는 focusSignal=null이라 무동작.
  useEffect(() => {
    if (!focusSignal) return;
    // 카메라(외부 뷰포트)를 신호에 동기화하는 1회 side-effect — 파생 렌더 상태가 아니라
    // 규칙 예외가 정당(위 초기 포커스 effect와 동일 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCamera(
      focusCamera(vp(), { x: focusSignal.x + CARD_CX, y: focusSignal.y + CARD_CY }, 1),
    );
  }, [focusSignal, vp]);

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
      setCamera(focusCamera(vp(), { x: c0.x + CARD_CX, y: c0.y + CARD_CY }, 1));
    } else {
      setCamera(INITIAL_CAMERA);
    }
  }, [concepts, vp]);

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

      <NoteCanvas camera={camera} onCameraChange={setCamera}>
        {concepts.length === 0 && !loading && <Welcome />}
        {/* 태그 마커 — 무게중심에(카드 아래 레이어). */}
        {[...tagCentroids.entries()].map(([tag, c]) => (
          <TagMarker key={tag} tag={tag} x={c.x} y={c.y} count={c.count} />
        ))}
        {concepts.map((c) => {
          // sim 좌표 우선, 아직 배치 전이면 기존 좌표 폴백.
          const p = positions.get(c.id);
          const laid = p ? { ...c, x: p.x, y: p.y } : c;
          return (
            <ConceptCard
              key={c.id}
              concept={laid}
              highlighted={c.id === activeId}
            />
          );
        })}
        {/* 리프 노드(영상/삽화) — 개념 다음에 렌더(스폰 애니메이션은 .nodi-spawn).
            앵커 개념의 sim 좌표로 리프를 재앵커(anchor의 스트림 좌표 대비 오프셋 유지).
            앵커 sim 위치가 없으면 기존 좌표 유지(best-effort 오버레이). */}
        {leafNodes.map((n) => {
          const anchor = n.conceptId
            ? concepts.find((c) => c.id === n.conceptId)
            : undefined;
          const ap = anchor ? positions.get(anchor.id) : undefined;
          const laid =
            anchor && ap
              ? { ...n, x: ap.x + (n.x - anchor.x), y: ap.y + (n.y - anchor.y) }
              : n;
          return n.type === "video" ? (
            <VideoNode key={n.id} node={laid} />
          ) : (
            <ArtNode key={n.id} node={laid} />
          );
        })}
        {/* 맵 앵커 로딩 — 생성 지점 위 버블(맵과 함께 팬/줌). */}
        {focusSignal && (
          <MapLoadingIndicator
            x={focusSignal.x}
            y={focusSignal.y}
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
        camera={camera}
        viewport={vpSize}
        onFocus={(target) =>
          setCamera(focusCamera(vp(), { x: target.x, y: target.y }, 1))
        }
      />

      <BottomBar onSend={send} busy={busy} reply={reply} />

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
        position: "absolute",
        left: 240,
        top: 130,
        width: 460,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 10,
        pointerEvents: "none",
        userSelect: "none",
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
          mixBlendMode: "multiply",
          borderRadius: 16,
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
