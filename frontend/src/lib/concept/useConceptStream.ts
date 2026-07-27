"use client";

// Concept-stream controller: drives Nodi's SSE /chat/stream through the concept
// parser into a canvas of concept cards. Rehydrates deterministically from
// persisted session nodes on load. (D94: EBS 영상·SVG 아트 추천 및
// /art/search 임베딩 그룹핑 제거 — 클러스터링은 useTagLayout 자유 태그가 소유.)
//
// 배치: 카드 좌표는 프론트 d3-force sim(useTagLayout)이 소유한다. 여기서 부여하는
//   좌표는 CENTER 기본값일 뿐이며, 서버 place/near/place_hint는 무시한다(서버는
//   여전히 전송하지만 프론트가 위치에 쓰지 않는다). send는 SSE 전 POST /retrieve로
//   figure만 받고, pending 플레이스홀더를 CENTER에 표시한다. 카메라는 focusSignal의
//   id로 sim 위치를 추종한다. 리프(figure)는 앵커 곁 오프셋 후보 위치를 쓴다.
// 영속(§8, C5): done 후 서버 done 훅이 retrieve 결과(figures)를 attachments.canvas에
//   저장(단일 writer). 카드 좌표는 저장/재적용하지 않는다(sim이 매 로드 재배치).
// 재수화: replay로 카드 내용만 복원하고, 좌표는 CENTER 기본값(sim이 배치).
//   attachments.canvas.figures로 figure 리프를 전부 재생성한다(D95: figureId
//   중복 제거 — 같은 figure는 최고 스코어 턴의 개념에 앵커).

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  getFigure,
  retrieve,
  streamChat,
  type SpaceTarget,
} from "@/lib/api";
import { sessionsKey, useSessionDetail } from "@/lib/queries";
import { CARD_MARGIN, CARD_W, CENTER } from "./curriculumTags";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { ChatDoneEvent, NodeRow } from "@/lib/types";
import { createConceptParser } from "./conceptParser";
import {
  cardRect,
  leafRect,
  LEAF_DIMS,
  placeLeafClear,
  type Rect,
} from "./leafPlacement";
import type { CanvasLeafNode, Concept, ParserEvent } from "./types";

// 09: 리프(figure) 선호 오프셋 — 앵커 카드 오른쪽 옆(CARD_W + MARGIN). 이 값은
// "선호 위치"일 뿐, placeLeafClear가 카드/다른 리프와 겹치지 않는 가장 가까운 빈
// 자리로 확정한다(요구: figure ↔ 카드 무겹침).
const LEAF_OFFSET_X = CARD_W + CARD_MARGIN; // 460

// C5: nodes.attachments.canvas 스키마(백엔드 병행 구축 — 계약 기준, 방어적 파싱).
// D94: ebs/art 키 제거 — 구 노드에 잔존해도 읽지 않는다.
interface PersistedCanvas {
  // D87: figure는 url 제외 영속 — 재수화 시 getFigure로 fresh signed URL 재발급.
  figures?: Array<{
    figure_id?: string;
    file_id?: string;
    page?: number;
    caption?: string;
    score?: number;
  }>;
}
type NodeRowWithAttachments = NodeRow & {
  attachments?: { canvas?: PersistedCanvas | null } | null;
};

function updateLast(list: Concept[], fn: (c: Concept) => Concept): Concept[] {
  if (!list.length) return list;
  const next = list.slice();
  next[next.length - 1] = fn(next[next.length - 1]);
  return next;
}

// Single source of truth for concept reduction (used live AND during rehydration).
// cstart 배치 계산 제거 — 리듀서는 콘텐츠(제목/블록/related/done)만 처리하고,
// 좌표는 호출부가 CENTER 기본값으로 부여한다(실제 위치는 d3-force sim이 소유).
function reduceConcept(
  list: Concept[],
  ev: ParserEvent,
  defaultXY?: { x: number; y: number },
): Concept[] {
  switch (ev.t) {
    case "cstart": {
      const id = "c" + (list.length + 1);
      const title = ev.concept.title ?? "";
      const cluster = ev.concept.cluster ?? "";
      // 좌표는 호출부(applyEvent or replayNodes)가 defaultXY로 주입.
      // 없으면 (40,40) 기본값(결코 노출되지 않아야 하지만 타입 안전 폴백).
      const x = defaultXY?.x ?? 40;
      const y = defaultXY?.y ?? 40;
      return [
        ...list,
        {
          id,
          title,
          cluster,
          blocks: [],
          related: [],
          x,
          y,
          done: false,
        },
      ];
    }
    case "bstart":
      return updateLast(list, (c) => ({
        ...c,
        blocks: [...c.blocks, { type: "p", tokens: [], typing: true }],
      }));
    case "delta":
      return updateLast(list, (c) => {
        const blocks = c.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last) return c;
        blocks[blocks.length - 1] = {
          ...last,
          tokens: [...last.tokens, { ch: ev.ch, b: !!ev.b, h: !!ev.h }],
        };
        return { ...c, blocks };
      });
    case "bend":
      return updateLast(list, (c) => {
        const blocks = c.blocks.slice();
        const last = blocks[blocks.length - 1];
        if (!last) return c;
        blocks[blocks.length - 1] = { ...last, typing: false };
        return { ...c, blocks };
      });
    case "related":
      return updateLast(list, (c) => ({ ...c, related: ev.titles }));
    case "cend":
      return updateLast(list, (c) => ({ ...c, done: true }));
    default:
      return list; // reply-*, done: no concept mutation
  }
}

// Parse a full node answer into concepts synchronously (rehydration replay).
// firstIdxByNode: 노드 id → 그 답변이 만든 FIRST 개념의 전역 인덱스.
function replayNodes(reals: NodeRow[]): {
  concepts: Concept[];
  firstIdxByNode: Map<string, number>;
} {
  let built: Concept[] = [];
  const firstIdxByNode = new Map<string, number>();
  for (const n of reals) {
    const before = built.length;
    const parser = createConceptParser((ev) => {
      // 좌표는 CENTER 기본값으로 생성 — 실제 위치는 d3-force sim이 소유한다.
      built = reduceConcept(built, ev, { x: CENTER.x, y: CENTER.y });
    });
    parser.push(n.answer || "");
    parser.end();
    if (built.length > before) {
      firstIdxByNode.set(n.id, before);
      // D74: 노드(턴) 단위 출처는 그 답변의 첫 개념에만 부착(칩 푸터).
      if (n.rag_sources?.length) {
        built[before] = { ...built[before], sources: n.rag_sources };
      }
    }
  }
  return { concepts: built, firstIdxByNode };
}

export interface ConceptStream {
  concepts: Concept[];
  leafNodes: CanvasLeafNode[];
  reply: string;
  busy: boolean;
  loading: boolean;
  /** 답변당 첫 개념. id로 그 개념의 sim 위치를 추적(카메라 추종). key는 send마다 증가. */
  focusSignal: { x: number; y: number; key: number; id: string } | null;
  send: (question: string) => Promise<void>;
  /** D83 부속: 활성 세션이 없으면 createSession 후 store에 set하고 세션 id 반환.
   *  프롬프트 창 첨부가 신규 진입(세션 0개)에서 세션을 자동 생성할 때 재사용. */
  ensureSession: () => Promise<string | null>;
}

export function useConceptStream(target: SpaceTarget): ConceptStream {
  const queryClient = useQueryClient();
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);

  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [leafNodes, setLeafNodes] = useState<CanvasLeafNode[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusSignal, setFocusSignal] = useState<
    { x: number; y: number; key: number; id: string } | null
  >(null);

  const conceptsRef = useRef<Concept[]>([]);
  const leafNodesRef = useRef<CanvasLeafNode[]>([]);
  const headRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 이번 send의 pending 플레이스홀더 id — 첫 cstart에서 승격되며 null로 소거.
  const pendingIdRef = useRef<string | null>(null);
  // 자동 포커싱 트리거 카운터(Date.now 금지 — 결정론). send마다 ++.
  const focusKeyRef = useRef(0);
  // 리프 계단식 스폰 타이머(언마운트 시 일괄 취소).
  const spawnTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(
    () => () => {
      abortRef.current?.abort();
      for (const t of spawnTimersRef.current) clearTimeout(t);
      spawnTimersRef.current.clear();
    },
    [],
  );

  // conceptsRef is the SYNCHRONOUS source of truth; setConcepts just mirrors it
  // to trigger a render. Updating the ref inline (not via a setState updater)
  // keeps it correct even when several parser events fire within one token chunk.
  const commitConcepts = useCallback((next: Concept[]) => {
    conceptsRef.current = next;
    setConcepts(next);
  }, []);

  const commitLeafNodes = useCallback((next: CanvasLeafNode[]) => {
    leafNodesRef.current = next;
    setLeafNodes(next);
  }, []);

  const applyEvent = useCallback(
    (ev: ParserEvent) => {
      if (ev.t === "reply-start" || ev.t === "reply" || ev.t === "cstart") {
        setLoading(false);
      }
      if (ev.t === "reply-start") {
        setReply("");
        return;
      }
      if (ev.t === "reply") {
        setReply((r) => r + ev.ch);
        return;
      }
      if (ev.t === "done") return;

      // 첫 cstart: 플레이스홀더 승격.
      // 좌표는 항상 CENTER 기본값으로 주입 — 실제 위치는 d3-force sim이 소유한다.
      // 같은 id → React가 DOM을 재사용 → left/top 트랜지션으로 정착 애니메이션.
      if (ev.t === "cstart" && pendingIdRef.current) {
        const pid = pendingIdRef.current;
        pendingIdRef.current = null;
        const rest = conceptsRef.current.filter((c) => c.id !== pid);

        const xy = { x: CENTER.x, y: CENTER.y };
        const appended = reduceConcept(rest, ev, xy);
        const settled = appended[appended.length - 1];
        commitConcepts([
          ...appended.slice(0, -1),
          {
            ...settled,
            x: xy.x,
            y: xy.y,
            pending: false,
          },
        ]);
        return;
      }

      // 이후 cstart(concept_index ≥ 1): 좌표는 CENTER 기본값 — sim이 실제 배치.
      if (ev.t === "cstart") {
        const next = reduceConcept(conceptsRef.current, ev, {
          x: CENTER.x,
          y: CENTER.y,
        });
        commitConcepts(next);
        return;
      }

      const next = reduceConcept(conceptsRef.current, ev);
      commitConcepts(next);
    },
    [commitConcepts],
  );

  const ensureSession = useCallback(async (): Promise<string | null> => {
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current) return current;
    try {
      const session = await createSession(target);
      await queryClient.invalidateQueries({ queryKey: sessionsKey(target) });
      setActiveSession(session.id);
      return session.id;
    } catch {
      return null;
    }
  }, [target, queryClient, setActiveSession]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busyRef.current) return;
      const sid = await ensureSession();
      if (!sid) return;

      setReply("");
      setBusy(true);
      busyRef.current = true;
      setLoading(true);

      // (a) SSE 전 선행 검색 — retrieve는 4s 타임아웃 포함, 절대 reject하지 않음.
      // 09: session_id 전달 필수(서버 kNN 유사도 계산).
      const r = await retrieve(q, sid);

      let placeholderId: string | null = null;

      // (b) 잠정 플레이스홀더 — 항상 표시. 좌표는 CENTER 기본값일 뿐이며, 실제
      // 위치는 d3-force sim이 소유한다(카메라는 focusSignal의 id로 sim 위치 추종).
      const nearXY = { x: CENTER.x, y: CENTER.y };

      const pid = "c" + (conceptsRef.current.length + 1);
      placeholderId = pid;
      pendingIdRef.current = pid;
      commitConcepts([
        ...conceptsRef.current,
        {
          id: pid,
          title: "",
          cluster: "",
          blocks: [],
          related: [],
          x: nearXY.x,
          y: nearXY.y,
          done: false,
          pending: true,
        },
      ]);
      // 자동 포커싱: 이번 답변 첫 개념(pid). 워크스페이스가 이 id의 sim 위치를 추종한다.
      setFocusSignal({ x: nearXY.x, y: nearXY.y, key: ++focusKeyRef.current, id: pid });

      // (c) D95: 교과서 figure 다중 표시 — 이번 턴 히트(게이트 통과분)를 전부
      // 배치하되 figureId로 중복 제거(이미 캔버스에 있는 figure는 다시 놓지
      // 않는다 — 세션 동안 누적). 스트림 실패 시 되돌리기 위한 스냅샷.
      const leafSnapshot = leafNodesRef.current;
      const placedIds = new Set(
        leafNodesRef.current
          .map((n) => n.figure?.figureId)
          .filter((v): v is string => !!v),
      );
      for (const f of r.figures) {
        if (placedIds.has(f.figureId)) continue;
        placedIds.add(f.figureId);
        const d = LEAF_DIMS.figure;
        const obstacles: Rect[] = [
          ...conceptsRef.current.map(cardRect),
          ...leafNodesRef.current.map(leafRect),
        ];
        const { x, y } = placeLeafClear(
          nearXY.x + LEAF_OFFSET_X,
          nearXY.y,
          d.w,
          d.h,
          obstacles,
        );
        commitLeafNodes([
          ...leafNodesRef.current,
          {
            id: `figure-${f.figureId}`,
            type: "figure",
            x,
            y,
            conceptId: pid,
            figure: {
              figureId: f.figureId,
              url: f.url,
              caption: f.caption,
              page: f.page,
            },
          },
        ]);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const parser = createConceptParser(applyEvent);
      // 클로저 대입 변수의 TS 내로잉 회피용 ref-형 로컬.
      const doneBox: { current: ChatDoneEvent | null } = { current: null };

      await streamChat(
        {
          session_id: sid,
          question: q,
          parent_node_id: headRef.current ?? undefined,
          // 09 단일 writer: figures를 서버에 전달해 done 훅이 단일 PATCH로 저장.
          retrieved: r.figures.length > 0 ? {
            // D87: figure는 url 제외(signed·만료) — 재수화 시 getFigure로 재발급.
            figures: r.figures.map((f) => ({
              figure_id: f.figureId,
              file_id: f.fileId,
              page: f.page,
              caption: f.caption,
              score: f.score,
            })),
          } : null,
        },
        {
          onToken: (delta) => parser.push(delta),
          onDone: (data: ChatDoneEvent) => {
            parser.end();
            doneBox.current = data;
            headRef.current = data.current_head_id ?? headRef.current;
          },
          onError: (msg) => {
            setReply(msg || "앗, 문제가 생겼어요. 다시 시도해 주세요.");
          },
        },
        controller.signal,
      );

      // (d) cstart 없이 끝났으면(오류/중단/개념 없는 답) 플레이스홀더 회수.
      if (placeholderId && pendingIdRef.current === placeholderId) {
        pendingIdRef.current = null;
        commitConcepts(
          conceptsRef.current.filter((c) => c.id !== placeholderId),
        );
      }
      // (d-2) D74: 이번 턴 RAG 출처를 승격된 첫 개념에 부착 — 승격이 id를
      // 보존하므로 placeholderId로 찾는다(개념이 안 만들어졌으면 no-op).
      const ragSources = doneBox.current?.node?.rag_sources;
      if (ragSources?.length && placeholderId) {
        commitConcepts(
          conceptsRef.current.map((c) =>
            c.id === placeholderId ? { ...c, sources: ragSources } : c,
          ),
        );
      }
      // 스트림 실패(done 미수신) 시 이번 send의 figure 배치를 되돌린다.
      if (!doneBox.current) {
        commitLeafNodes(leafSnapshot);
      }

      // (f) done: sessionsKey invalidate(제목 갱신). figures 영속은 서버 done
      // 훅이 단일 PATCH로 처리(09 단일 writer 계약).
      if (doneBox.current?.node?.id) {
        // 09 회귀 수정: done 후 sessionKey(sid) invalidate를 하지 않는다.
        // 좌표는 서버 done 훅이 fire-and-forget으로 늦게 저장하므로, 여기서
        // 재수화를 트리거하면 아직 concepts 좌표가 없는 스냅샷으로 라이브 place
        // 좌표를 폴백((40,40)부터 순차)으로 덮어써 카드가 점프/중복된다.
        // 라이브 상태가 진실의 원천 — 새로고침/세션전환 시 useSessionDetail이
        // 자연히 fresh fetch해 저장된 좌표로 재수화한다(§5-3 경로 보존).
        // sessionsKey(목록) invalidate만 유지 — 세션 제목/updated_at 갱신용.
        void queryClient.invalidateQueries({ queryKey: sessionsKey(target) });
      }

      setBusy(false);
      busyRef.current = false;
      setLoading(false);
    },
    [
      ensureSession,
      applyEvent,
      queryClient,
      target,
      commitConcepts,
      commitLeafNodes,
    ],
  );

  // ── Rehydration from persisted nodes ──────────────────────────────────
  // replay는 카드 내용 복원용 — 좌표는 CENTER 기본값(d3-force sim이 배치).
  // 리프(figure)는 attachments.canvas.figures로 재생성.
  const { data: detail } = useSessionDetail(activeSessionId);
  useEffect(() => {
    if (busyRef.current) return; // never clobber a live stream
    // replay가 리프를 통째로 대체하므로 잔여 스폰 타이머는 취소(중복 id 방지).
    for (const t of spawnTimersRef.current) clearTimeout(t);
    spawnTimersRef.current.clear();
    const reals = detail?.nodes ?? [];
    headRef.current = detail?.session?.current_head_id ?? null;

    const { concepts: built, firstIdxByNode } = replayNodes(reals);

    // 좌표는 저장/적용하지 않는다 — built 개념은 CENTER 기본값을 유지하고
    // 실제 위치는 d3-force sim이 배치한다(서버 place/near 의존 제거).

    // attachments.canvas → 리프 재생성. 좌표 전부 확정된 재수화 시점이므로 여기서
    // 무겹침을 확정한다: 앵커 오른쪽 스택을 선호 위치로, 모든 카드 + 앞서 놓은
    // 리프를 장애물로 삼아 placeLeafClear가 카드와 겹치지 않는 자리로 배치한다.
    // D95: 전 노드의 figures를 figureId로 중복 제거해 **전부** 복원한다 — 같은
    // figure를 여러 턴이 히트했으면 최고 스코어 턴의 개념을 앵커로 쓴다.
    const byFigureId = new Map<
      string,
      { score: number; nodeId: string; f: NonNullable<PersistedCanvas["figures"]>[number] }
    >();
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas) continue;
      // D87: 방어 파싱(구 노드엔 figures 없음).
      for (const f of canvas.figures ?? []) {
        if (!f?.figure_id || typeof f.score !== "number") continue;
        const cur = byFigureId.get(f.figure_id);
        if (!cur || f.score > cur.score) {
          byFigureId.set(f.figure_id, { score: f.score, nodeId: n.id, f });
        }
      }
    }
    const leaves: CanvasLeafNode[] = [];
    const obstacles: Rect[] = built.map(cardRect);
    const anchorXY = (nodeId: string) => {
      const idx = firstIdxByNode.get(nodeId);
      const anchor = idx == null ? undefined : built[idx];
      return anchor ? { x: anchor.x, y: anchor.y, id: anchor.id } : { x: 40, y: 40, id: undefined };
    };
    // D87: figure는 url 비영속 — 좌표(장애물)만 먼저 확정해 url=""(스켈레톤)로
    // 배치하고, getFigure로 fresh signed URL을 비동기 재발급해 리프를 갱신한다
    // (비동기 후처리 패턴). 실패 시 해당 리프만 제거(best-effort). 리프 id가
    // figureId를 포함하므로(figure-{id}) 스테일 응답이 남의 슬롯을 건드릴 수 없다.
    for (const { nodeId, f } of byFigureId.values()) {
      const base = anchorXY(nodeId);
      const d = LEAF_DIMS.figure;
      const { x, y } = placeLeafClear(base.x + LEAF_OFFSET_X, base.y, d.w, d.h, obstacles);
      obstacles.push({ x, y, w: d.w, h: d.h });
      const figureId = String(f.figure_id);
      const leafId = `figure-${figureId}`;
      leaves.push({
        id: leafId, type: "figure", x, y, conceptId: base.id,
        figure: {
          figureId,
          url: "", // getFigure로 재발급(아래) 전까지 스켈레톤.
          caption: f.caption ?? "",
          page: typeof f.page === "number" ? f.page : undefined,
        },
      });
      void getFigure(figureId)
        .then((fresh) => {
          if (!fresh.url) throw new Error("빈 URL");
          commitLeafNodes(
            leafNodesRef.current.map((n) =>
              n.id === leafId && n.figure
                ? { ...n, figure: { ...n.figure, url: fresh.url } }
                : n,
            ),
          );
        })
        .catch(() => {
          commitLeafNodes(leafNodesRef.current.filter((n) => n.id !== leafId));
        });
    }

    commitConcepts(built);
    commitLeafNodes(leaves);
    setReply("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  return {
    concepts,
    leafNodes,
    reply,
    busy,
    loading,
    focusSignal,
    send,
    ensureSession,
  };
}
