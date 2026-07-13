"use client";

// Concept-stream controller: drives Nodi's SSE /chat/stream through the concept
// parser into a canvas of concept cards, resolves an illustration per concept via
// /art/search, and clusters concepts into the semantic-similarity tree. Rehydrates
// deterministically from persisted session nodes on load.
//
// 09 배치: 좌표는 서버 place 이벤트가 유일 소스(프론트 격자 계산 제거).
//   send는 SSE 전에 POST /retrieve를 선행(≤4s) — 서버가 계산한 near.{x,y}에
//   pending 플레이스홀더를 표시한다. SSE 중 `place`(is_final=false)를 받을 때마다
//   pendingCoords에 기록하고 cstart 승격 시 그 좌표를 사용한다(없으면 첫 개념 곁
//   near 승계). done 후 서버가 같은 concept_index를 is_final=true로 재전송하면
//   해당 개념 좌표를 최종값으로 갱신 → 카드가 CSS 트랜지션으로 안착(settle).
//   리프(영상/삽화)는 개념 좌표 곁 단순 오프셋(오른쪽·순번마다 아래로).
// 영속(§8, C5): done 후 PATCH /nodes/{id}에 retrieve 결과(ebs/art)를
//   fire-and-forget 저장. 좌표는 서버 done 훅이 canvas_cards upsert로 저장.
// 재수화: 노드별 attachments.canvas.concepts[{i,x,y,h}]로 좌표·높이 적용
//   (격자 폴백 제거; 좌표 미저장 구 노드는 near 중앙 폴백).

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  retrieve,
  searchArt,
  streamChat,
  type ArtSearchResult,
  type PlaceEvent,
  type SpaceTarget,
} from "@/lib/api";
import { sessionsKey, useSessionDetail } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { ChatDoneEvent, NodeRow } from "@/lib/types";
import { createConceptParser } from "./conceptParser";
import { LAYOUT } from "./layout";
import { buildGroups } from "./grouping";
import {
  cardRect,
  leafRect,
  LEAF_DIMS,
  placeLeafClear,
  type Rect,
} from "./leafPlacement";
import type { CanvasLeafNode, Concept, ConceptGroup, ParserEvent } from "./types";

// 09: 리프(영상/삽화) 선호 오프셋 — 앵커 카드 오른쪽 옆(CARD_W + MARGIN). 이 값은
// "선호 위치"일 뿐, placeLeafClear가 카드/다른 리프와 겹치지 않는 가장 가까운 빈
// 자리로 확정한다(요구: 영상/삽화 ↔ 카드 무겹침).
const LEAF_OFFSET_X = LAYOUT.CARD_W + LAYOUT.MARGIN; // 460

// Cross-render/session cache of art-search results, keyed by concept title, so a
// reload (which re-resolves every concept) hits the cache instead of the network.
const ART_CACHE = new Map<string, ArtSearchResult>();
async function cachedSearchArt(title: string): Promise<ArtSearchResult> {
  const key = title.trim();
  if (!key) return { art: null, embedding: null };
  const hit = ART_CACHE.get(key);
  if (hit) return hit;
  const res = await searchArt(key);
  // Only cache positive/embedding results — let bare failures retry later.
  if (res.embedding || res.art) ART_CACHE.set(key, res);
  return res;
}

// C5: nodes.attachments.canvas 스키마(백엔드 병행 구축 — 계약 기준, 방어적 파싱).
interface PersistedCanvas {
  ebs?: Array<{ video_id?: string; title?: string; thumb?: string; score?: number }>;
  art?: Array<{ slug?: string; url?: string; title?: string; score?: number }>;
  /** 09: place 이벤트로 확정된 개념별 좌표. i = 답변 내 0-based 로컬 인덱스. h = 카드 높이. */
  concepts?: Array<{ i?: number; x?: number; y?: number; h?: number; tag?: string }>;
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
// 09: cstart 배치 계산 제거 — 좌표는 place 맵 또는 리플레이 attachments에서만 온다.
// 리듀서는 콘텐츠(제목/블록/related/done)만 처리하고, 좌표는 호출부가 부여한다.
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
          art: null,
          embedding: null,
          groupId: null,
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
      // 리플레이 시 좌표는 attachments.canvas.concepts에서 가져오므로
      // 여기선 임시 폴백(40,40)으로 생성 후 아래에서 override.
      built = reduceConcept(built, ev, { x: 40, y: 40 });
    });
    parser.push(n.answer || "");
    parser.end();
    if (built.length > before) firstIdxByNode.set(n.id, before);
  }
  return { concepts: built, firstIdxByNode };
}

export interface ConceptStream {
  concepts: Concept[];
  groups: ConceptGroup[];
  leafNodes: CanvasLeafNode[];
  reply: string;
  busy: boolean;
  loading: boolean;
  /** 답변당 첫 개념 생성 좌표(top-left). key는 send마다 증가 — 같은 좌표라도 effect 재발화. */
  focusSignal: { x: number; y: number; key: number } | null;
  send: (question: string) => Promise<void>;
}

export function useConceptStream(target: SpaceTarget): ConceptStream {
  const queryClient = useQueryClient();
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);

  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [groups, setGroups] = useState<ConceptGroup[]>([]);
  const [leafNodes, setLeafNodes] = useState<CanvasLeafNode[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [focusSignal, setFocusSignal] = useState<
    { x: number; y: number; key: number } | null
  >(null);

  const conceptsRef = useRef<Concept[]>([]);
  const leafNodesRef = useRef<CanvasLeafNode[]>([]);
  // Part B: 맵당 영상 1·삽화 1 — 현재 대표의 최고 스코어(교체 판정 기준선).
  // 세션 동안 유지, 재수화 시 로드된 대표 스코어로 재설정.
  const mapVideoScoreRef = useRef<number>(-Infinity);
  const mapArtScoreRef = useRef<number>(-Infinity);
  const headRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 이번 send의 pending 플레이스홀더 id — 첫 cstart에서 승격되며 null로 소거.
  const pendingIdRef = useRef<string | null>(null);
  // 09: place 이벤트로 수신한 concept_index별 좌표 맵.
  // cstart가 place보다 먼저 파싱될 수 있으므로 맵에 저장 후 cstart 시 조회.
  const pendingCoordsRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // 이번 send에서 생성된 개념의 전역 시작 인덱스(place concept_index → 전역 인덱스 변환).
  const baseConceptIdxRef = useRef<number>(0);
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

  // Rebuild all groups from the current concepts, in order — deterministic and
  // identical for a live turn and a reload (same order + cached embeddings).
  // pending 플레이스홀더(제목 없음)는 그룹 대상에서 제외.
  const rebuildGroups = useCallback(() => {
    const g = buildGroups(
      conceptsRef.current
        .filter((c) => !c.pending)
        .map((c) => ({
          id: c.id,
          title: c.title,
          embedding: c.embedding ?? null,
        })),
    );
    setGroups(g);
  }, []);

  // Resolve one concept's illustration + embedding, then regroup.
  const resolveArt = useCallback(
    async (conceptId: string) => {
      const c = conceptsRef.current.find((x) => x.id === conceptId);
      if (!c) return;
      const res = await cachedSearchArt(c.title);
      commitConcepts(
        conceptsRef.current.map((x) =>
          x.id === conceptId
            ? {
                ...x,
                art: res.art ?? null,
                embedding: res.embedding ?? x.embedding ?? null,
              }
            : x,
        ),
      );
      rebuildGroups();
    },
    [commitConcepts, rebuildGroups],
  );

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
      // 09: 좌표는 pendingCoordsRef[0](place 이벤트)에서, 없으면 플레이스홀더 좌표 승계.
      // 같은 id → React가 DOM을 재사용 → left/top 트랜지션으로 정착 애니메이션.
      if (ev.t === "cstart" && pendingIdRef.current) {
        const pid = pendingIdRef.current;
        pendingIdRef.current = null;
        const pendingConcept = conceptsRef.current.find((c) => c.id === pid);
        const rest = conceptsRef.current.filter((c) => c.id !== pid);

        // concept_index 0 = 이번 send의 첫 개념
        const placeCoord = pendingCoordsRef.current.get(0);
        // place 좌표 > 플레이스홀더 좌표(retrieve near) > 폴백(40,40) 순으로 사용
        const xy = placeCoord ?? (pendingConcept ? { x: pendingConcept.x, y: pendingConcept.y } : { x: 40, y: 40 });

        const appended = reduceConcept(rest, ev, xy);
        const settled = appended[appended.length - 1];
        commitConcepts([
          ...appended.slice(0, -1),
          {
            ...settled,
            // 카메라가 보는 자리에 정착 — 좌표 이미 xy로 설정됨.
            x: xy.x,
            y: xy.y,
            pending: false,
          },
        ]);
        return;
      }

      // 이후 cstart(concept_index ≥ 1): 좌표는 place 맵(서버)이 유일 소스.
      // 아직 place가 안 왔으면 이번 send 첫 개념 곁 near 좌표를 승계(격자 계산 없음).
      // settle(is_final) place가 done 후 최종 위치로 재정착시킨다.
      if (ev.t === "cstart") {
        // 이번 답변 내 개념 인덱스 = 현재 concepts 수 - baseConceptIdx
        const localIdx = conceptsRef.current.length - baseConceptIdxRef.current;
        const placeCoord = pendingCoordsRef.current.get(localIdx);
        const firstConcept = conceptsRef.current[baseConceptIdxRef.current];
        const near = firstConcept
          ? { x: firstConcept.x, y: firstConcept.y }
          : { x: 40, y: 40 };
        const xy = placeCoord ?? near;
        const next = reduceConcept(conceptsRef.current, ev, xy);
        commitConcepts(next);
        return;
      }

      const next = reduceConcept(conceptsRef.current, ev);
      commitConcepts(next);
      if (ev.t === "cend") {
        const last = next[next.length - 1];
        if (last) void resolveArt(last.id);
      }
    },
    [commitConcepts, resolveArt],
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

      // 09: place 맵 초기화, 이번 답변의 FIRST 개념 전역 인덱스 기록
      pendingCoordsRef.current = new Map();
      baseConceptIdxRef.current = conceptsRef.current.length;

      // (a) SSE 전 선행 검색 — retrieve는 4s 타임아웃 포함, 절대 reject하지 않음.
      // 09: session_id 전달 필수(서버 kNN 유사도 계산).
      const r = await retrieve(q, sid);

      let placeholderId: string | null = null;

      // (b) 잠정 플레이스홀더 — 항상 표시. degraded(유사도 계산 불가)면 서버 near가
      // 늘 캔버스 중앙을 반환하므로, 이미 카드가 있으면 로컬로 마지막 카드 곁에
      // 오프셋해 중앙에 겹쳐 쌓이는 것을 막는다(격자 계산 없음). 카드가 없으면
      // 서버 중앙 좌표를 그대로 쓴다. 서버 place(is_final)가 done 후 최종 위치로
      // 재정착시키므로 이 값은 잠정 표시일 뿐이다.
      let nearXY: { x: number; y: number };
      if (r.degraded && conceptsRef.current.length > 0) {
        const last = conceptsRef.current[conceptsRef.current.length - 1];
        nearXY = { x: last.x + LEAF_OFFSET_X, y: last.y };
      } else {
        nearXY = { x: r.near.x, y: r.near.y };
      }

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
          art: null,
          embedding: null,
          groupId: null,
          pending: true,
        },
      ]);
      // 자동 포커싱: 이번 답변 첫 개념(플레이스홀더) 생성 지점으로 카메라를 옮기게 신호.
      setFocusSignal({ x: nearXY.x, y: nearXY.y, key: ++focusKeyRef.current });

      // (c) Part B: 맵당 영상 1·삽화 1 — 최고 스코어 후보만 대표로 유지/교체.
      // 스트림 실패 시 되돌리기 위한 스냅샷.
      const leafSnapshot = leafNodesRef.current;
      const scoreSnapshot = {
        v: mapVideoScoreRef.current,
        a: mapArtScoreRef.current,
      };
      const placeRep = (
        id: "map-video" | "map-art",
        type: CanvasLeafNode["type"],
        extra: Partial<CanvasLeafNode>,
      ) => {
        const d = LEAF_DIMS[type];
        const others = leafNodesRef.current.filter((n) => n.id !== id);
        const obstacles: Rect[] = [
          ...conceptsRef.current.map(cardRect),
          ...others.map(leafRect),
        ];
        const { x, y } = placeLeafClear(
          nearXY.x + LEAF_OFFSET_X,
          nearXY.y,
          d.w,
          d.h,
          obstacles,
        );
        commitLeafNodes([...others, { id, type, x, y, conceptId: pid, ...extra }]);
      };
      const repVideo = r.ebs[0];
      if (repVideo && typeof repVideo.score === "number" && repVideo.score > mapVideoScoreRef.current) {
        mapVideoScoreRef.current = repVideo.score;
        placeRep("map-video", "video", {
          video: { videoId: repVideo.videoId, title: repVideo.title, thumb: repVideo.thumb },
        });
      }
      const repArt = r.art[0];
      if (repArt && typeof repArt.score === "number" && repArt.score > mapArtScoreRef.current) {
        mapArtScoreRef.current = repArt.score;
        placeRep("map-art", "art", {
          art: { slug: repArt.slug, url: repArt.url, title: repArt.title },
        });
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
          // 09: retrieve near 좌표 릴레이 — 서버가 place_hint로 첫 개념 배치.
          place_hint: { x: nearXY.x, y: nearXY.y },
          // 09 단일 writer: ebs/art를 서버에 전달해 done 훅이 단일 PATCH로 통합 저장.
          retrieved: (r.ebs.length > 0 || r.art.length > 0) ? {
            ebs: r.ebs.map((e) => ({
              video_id: e.videoId,
              title: e.title,
              thumb: e.thumb,
              score: e.score,
            })),
            art: r.art.map((a) => ({
              slug: a.slug,
              url: a.url,
              title: a.title,
              score: a.score,
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
          // 09: place 이벤트 수신 — 좌표는 서버가 유일하게 결정한다.
          //   is_final=false: 스트리밍 중 추정 위치 → pendingCoords에 기록(cstart 승계용).
          //     concept_index 0이면 플레이스홀더 좌표도 즉시 이동(이동 트랜지션).
          //   is_final=true: done 후 settle 재전송 → 해당 개념(전역 인덱스)을 최종값으로
          //     갱신해 카드가 최종 위치로 CSS 트랜지션.
          onPlace: (p: PlaceEvent) => {
            const localIdx = p.concept_index;
            pendingCoordsRef.current.set(localIdx, { x: p.x, y: p.y });
            if (!p.is_final && localIdx === 0) {
              // 태그 앵커로 카드가 이동 → 카메라도 그 지점으로 재포커스(near=중앙 폴백 보정).
              setFocusSignal({ x: p.x, y: p.y, key: ++focusKeyRef.current });
            }
            if (p.is_final) {
              const globalIdx = baseConceptIdxRef.current + localIdx;
              commitConcepts(
                conceptsRef.current.map((c, i) =>
                  i === globalIdx ? { ...c, x: p.x, y: p.y } : c,
                ),
              );
              return;
            }
            if (localIdx === 0 && pendingIdRef.current) {
              // 플레이스홀더 좌표를 서버 확정 좌표로 이동(CSS 트랜지션이 애니메이트).
              commitConcepts(
                conceptsRef.current.map((c) =>
                  c.id === pendingIdRef.current ? { ...c, x: p.x, y: p.y } : c,
                ),
              );
            }
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
      // 스트림 실패(done 미수신) 시 이번 send의 대표 교체를 되돌린다.
      if (!doneBox.current) {
        commitLeafNodes(leafSnapshot);
        mapVideoScoreRef.current = scoreSnapshot.v;
        mapArtScoreRef.current = scoreSnapshot.a;
      }

      // (f) done: sessionsKey invalidate(제목 갱신). ebs/art 영속은 서버 done
      // 훅이 concepts + ebs/art를 단일 PATCH로 처리(09 단일 writer 계약).
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
  // 09: 좌표는 nodes.attachments.canvas.concepts[{i,x,y}]에서 복원.
  // replay는 카드 내용 복원용 — 좌표 재계산 로직 제거.
  const { data: detail } = useSessionDetail(activeSessionId);
  useEffect(() => {
    if (busyRef.current) return; // never clobber a live stream
    // replay가 리프를 통째로 대체하므로 잔여 스폰 타이머는 취소(중복 id 방지).
    for (const t of spawnTimersRef.current) clearTimeout(t);
    spawnTimersRef.current.clear();
    const nodes = detail?.nodes ?? [];
    const reals = nodes.filter((n) => !n.is_navigator);
    headRef.current = detail?.session?.current_head_id ?? null;

    const { concepts: built, firstIdxByNode } = replayNodes(reals);

    // 09: attachments.canvas.concepts[{i,x,y,h}]로 좌표 적용(서버 place가 유일 소스).
    // i = 답변 내 0-based 로컬 인덱스 → 노드의 FIRST 개념 전역 인덱스에 더해
    // built[] 전역 인덱스로 변환(firstIdxByNode). 범위 밖 인덱스는 무시(방어).
    // h = 카드 높이(Task 8 ConceptCard가 우선 사용) — 개념 객체에 실어 전달.
    const coordMap = new Map<number, { x: number; y: number; h?: number }>();
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas?.concepts) continue;
      const base = firstIdxByNode.get(n.id);
      if (base == null) continue; // 이 답변이 만든 개념 없음 → 좌표 적용 대상 없음
      for (const c of canvas.concepts) {
        if (typeof c.i === "number" && typeof c.x === "number" && typeof c.y === "number") {
          coordMap.set(base + c.i, {
            x: c.x,
            y: c.y,
            h: typeof c.h === "number" ? c.h : undefined,
          });
        }
      }
    }

    // 좌표 맵으로 built 배열 좌표 override(격자 계산 제거).
    // 맵에 없는 인덱스(좌표 미저장 구 노드): near 중앙 폴백으로 단순 배치.
    for (let i = 0; i < built.length; i++) {
      const coord = coordMap.get(i);
      if (coord) {
        built[i] = { ...built[i], x: coord.x, y: coord.y, h: coord.h };
      } else {
        // 폴백(구 노드): 직전 카드 곁 단순 오프셋, 없으면 near 중앙(40,40).
        const prev = i > 0 ? built[i - 1] : undefined;
        const xy = prev ? { x: prev.x + LEAF_OFFSET_X, y: prev.y } : { x: 40, y: 40 };
        built[i] = { ...built[i], x: xy.x, y: xy.y };
      }
    }

    // attachments.canvas → 리프 재생성. 좌표 전부 확정된 재수화 시점이므로 여기서
    // 무겹침을 확정한다: 앵커 오른쪽 스택을 선호 위치로, 모든 카드 + 앞서 놓은
    // 리프를 장애물로 삼아 placeLeafClear가 카드와 겹치지 않는 자리로 배치한다.
    // Part B: 전 노드 후보 중 최고 스코어로 영상 1·삽화 1 결정(argmax, 동점=첫 노드).
    let bestVideo: { score: number; nodeId: string; e: NonNullable<PersistedCanvas["ebs"]>[number] } | null = null;
    let bestArt: { score: number; nodeId: string; a: NonNullable<PersistedCanvas["art"]>[number] } | null = null;
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas) continue;
      for (const e of canvas.ebs ?? []) {
        if (!e?.video_id || typeof e.score !== "number") continue;
        if (!bestVideo || e.score > bestVideo.score) bestVideo = { score: e.score, nodeId: n.id, e };
      }
      for (const a of canvas.art ?? []) {
        if (!a?.slug || typeof a.score !== "number") continue;
        if (!bestArt || a.score > bestArt.score) bestArt = { score: a.score, nodeId: n.id, a };
      }
    }
    const leaves: CanvasLeafNode[] = [];
    const obstacles: Rect[] = built.map(cardRect);
    const anchorXY = (nodeId: string) => {
      const idx = firstIdxByNode.get(nodeId);
      const anchor = idx == null ? undefined : built[idx];
      return anchor ? { x: anchor.x, y: anchor.y, id: anchor.id } : { x: 40, y: 40, id: undefined };
    };
    if (bestVideo) {
      const base = anchorXY(bestVideo.nodeId);
      const d = LEAF_DIMS.video;
      const { x, y } = placeLeafClear(base.x + LEAF_OFFSET_X, base.y, d.w, d.h, obstacles);
      obstacles.push({ x, y, w: d.w, h: d.h });
      leaves.push({
        id: "map-video", type: "video", x, y, conceptId: base.id,
        video: {
          videoId: String(bestVideo.e.video_id),
          title: bestVideo.e.title ?? "",
          thumb: bestVideo.e.thumb ?? `https://i.ytimg.com/vi/${bestVideo.e.video_id}/hqdefault.jpg`,
        },
      });
      mapVideoScoreRef.current = bestVideo.score;
    } else {
      mapVideoScoreRef.current = -Infinity;
    }
    if (bestArt) {
      const base = anchorXY(bestArt.nodeId);
      const d = LEAF_DIMS.art;
      const { x, y } = placeLeafClear(base.x + LEAF_OFFSET_X, base.y, d.w, d.h, obstacles);
      obstacles.push({ x, y, w: d.w, h: d.h });
      leaves.push({
        id: "map-art", type: "art", x, y, conceptId: base.id,
        art: {
          slug: String(bestArt.a.slug),
          url: bestArt.a.url ?? `/art/${bestArt.a.slug}.svg`,
          title: bestArt.a.title ?? "",
        },
      });
      mapArtScoreRef.current = bestArt.score;
    } else {
      mapArtScoreRef.current = -Infinity;
    }

    commitConcepts(built);
    commitLeafNodes(leaves);
    setReply("");
    // title-fallback groups immediately; refine with embeddings as art resolves.
    setGroups(
      buildGroups(built.map((c) => ({ id: c.id, title: c.title, embedding: null }))),
    );
    for (const c of built) void resolveArt(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  return { concepts, groups, leafNodes, reply, busy, loading, focusSignal, send };
}
