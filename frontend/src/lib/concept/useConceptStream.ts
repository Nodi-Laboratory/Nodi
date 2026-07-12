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
import type { CanvasLeafNode, Concept, ConceptGroup, ParserEvent } from "./types";

// 리프 스폰 계단식 삽입 간격(ms) — 위치는 즉시 확정(결정적), 삽입만 지연.
const LEAF_SPAWN_STAGGER_MS = 250;

// 09: 리프(영상/삽화) 배치 오프셋 — 격자 계산 대신 개념 좌표 곁 단순 오프셋.
// x: 카드 오른쪽 옆(CARD_W + MARGIN), y: 리프 순번마다 아래로 누적.
const LEAF_OFFSET_X = LAYOUT.CARD_W + LAYOUT.MARGIN; // 460
const LEAF_OFFSET_Y = 240;

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
  concepts?: Array<{ i?: number; x?: number; y?: number; h?: number }>;
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

  const conceptsRef = useRef<Concept[]>([]);
  const leafNodesRef = useRef<CanvasLeafNode[]>([]);
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
      const spawnedLeafIds = new Set<string>();
      const localTimers: Array<ReturnType<typeof setTimeout>> = [];

      // (b) 잠정 플레이스홀더 — 항상 표시(degraded여도 near 폴백 좌표로).
      // retrieve 자체 실패(r.near.x===0, r.near.y===0)면 로컬 폴백.
      let nearXY: { x: number; y: number };
      if (r.degraded && r.near.x === 0 && r.near.y === 0) {
        // retrieve 자체가 실패했을 때 로컬 폴백(격자 계산 없음):
        // 카드가 있으면 마지막 카드 곁 단순 오프셋, 없으면 (40,40).
        // 서버 place(is_final)가 done 후 최종 위치로 재정착시킨다.
        if (conceptsRef.current.length > 0) {
          const last = conceptsRef.current[conceptsRef.current.length - 1];
          nearXY = { x: last.x + LEAF_OFFSET_X, y: last.y };
        } else {
          nearXY = { x: 40, y: 40 };
        }
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

      // (c) 리프 노드(영상/삽화) — retrieve 성공(ebs/art 있을 때)만 스폰.
      // 09: 격자 계산 대신 잠정 위치(nearXY) 곁 단순 오프셋(개념 오른쪽, 순번마다 아래로).
      const batch: CanvasLeafNode[] = [];
      let seq = leafNodesRef.current.length;
      let leafOrder = 0;
      for (const e of r.ebs) {
        const lid = "l" + ++seq;
        batch.push({
          id: lid,
          type: "video",
          x: nearXY.x + LEAF_OFFSET_X,
          y: nearXY.y + leafOrder++ * LEAF_OFFSET_Y,
          conceptId: pid,
          video: { videoId: e.videoId, title: e.title, thumb: e.thumb },
        });
      }
      for (const a of r.art) {
        const lid = "l" + ++seq;
        batch.push({
          id: lid,
          type: "art",
          x: nearXY.x + LEAF_OFFSET_X,
          y: nearXY.y + leafOrder++ * LEAF_OFFSET_Y,
          conceptId: pid,
          art: { slug: a.slug, url: a.url, title: a.title },
        });
      }
      batch.forEach((leaf, i) => {
        spawnedLeafIds.add(leaf.id);
        const timer = setTimeout(() => {
          spawnTimersRef.current.delete(timer);
          commitLeafNodes([...leafNodesRef.current, leaf]);
        }, i * LEAF_SPAWN_STAGGER_MS);
        spawnTimersRef.current.add(timer);
        localTimers.push(timer);
      });

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
      // 스트림 실패(done 미수신) 시 이번 send가 스폰한 리프 + 대기 타이머 회수.
      if (!doneBox.current && spawnedLeafIds.size) {
        for (const t of localTimers) {
          clearTimeout(t);
          spawnTimersRef.current.delete(t);
        }
        commitLeafNodes(
          leafNodesRef.current.filter((n) => !spawnedLeafIds.has(n.id)),
        );
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

    // attachments.canvas → 리프 재생성(격자 계산 대신 개념 곁 단순 오프셋).
    // 앵커 개념 오른쪽(LEAF_OFFSET_X), 노드별 리프 순번마다 아래로 누적.
    const leaves: CanvasLeafNode[] = [];
    for (const n of reals) {
      const canvas = (n as NodeRowWithAttachments).attachments?.canvas;
      if (!canvas) continue;
      const idx = firstIdxByNode.get(n.id);
      const anchor = idx == null ? undefined : built[idx];
      const baseXY = anchor ? { x: anchor.x, y: anchor.y } : { x: 40, y: 40 };
      let leafOrder = 0;
      for (const e of canvas.ebs ?? []) {
        if (!e?.video_id) continue;
        const lid = "l" + (leaves.length + 1);
        leaves.push({
          id: lid,
          type: "video",
          x: baseXY.x + LEAF_OFFSET_X,
          y: baseXY.y + leafOrder++ * LEAF_OFFSET_Y,
          conceptId: anchor?.id,
          video: {
            videoId: String(e.video_id),
            title: e.title ?? "",
            thumb:
              e.thumb ?? `https://i.ytimg.com/vi/${e.video_id}/hqdefault.jpg`,
          },
        });
      }
      for (const a of canvas.art ?? []) {
        if (!a?.slug) continue;
        const lid = "l" + (leaves.length + 1);
        leaves.push({
          id: lid,
          type: "art",
          x: baseXY.x + LEAF_OFFSET_X,
          y: baseXY.y + leafOrder++ * LEAF_OFFSET_Y,
          conceptId: anchor?.id,
          art: {
            slug: String(a.slug),
            url: a.url ?? `/art/${a.slug}.svg`,
            title: a.title ?? "",
          },
        });
      }
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

  return { concepts, groups, leafNodes, reply, busy, loading, send };
}
