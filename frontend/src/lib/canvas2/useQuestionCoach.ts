"use client";

/**
 * 질문 방향성 코치의 화면 쪽 배선 (D194).
 *
 * ## 왜 훅으로 빼는가
 *
 * `CanvasWorkspace`는 이미 1,900줄이 넘고, **오늘 병렬 세션과 충돌한 파일이
 * 바로 이것**이다(2026-08-07 회수 작업). 여기서 하는 일은 "언제 물을지 정하고 ·
 * 결과를 카드에 붙이고 · 어디에 띄울지 계산"뿐이라 워크스페이스의 다른 관심사와
 * 얽히는 데가 없다 — 얽히지 않는 것은 나가야 다음 사람이 읽을 수 있다.
 *
 * 판정 규칙 자체는 `questionCoach.ts`(순수 함수)에, 문구는 서버에 있다. 이
 * 파일은 셋을 잇기만 한다.
 */

import { useMemo } from "react";
import { askQuestionDirections, getCoachSettings } from "@/lib/api";
import { ITEM_W } from "./layout";
import { chainForCoach, decideCoach, type CoachItem } from "./questionCoach";
import type { CanvasItem } from "./types";
import { useEventCallback } from "./useEventCallback";

/** 말풍선이 붙을 자리 — 그 카드의 실측 상자(월드 좌표). */
export interface CoachBox {
  x: number;
  y: number;
  w: number;
}

interface Options {
  /** 화면에 있는 아이템 전부(= store.items). */
  items: readonly CanvasItem[];
  /** 배치 결과 — 말풍선을 카드 옆에 붙이는 데 쓴다. */
  positions: ReadonlyMap<string, { x: number; y: number }>;
  sizes: ReadonlyMap<string, { w: number; h: number }>;
  /** 지금 초점(누른 카드). 입력창 위 문구는 이 카드일 때만 뜬다. */
  pickedId: string | null;
  /** 카드 하나를 고친다(useCanvasItems.patch). */
  patch: (id: string, patch: Partial<CanvasItem>) => void;
}

export interface QuestionCoach {
  /** 한 턴이 끝난 뒤 호출한다 — 말을 걸지 정하고, 걸면 카드에 붙인다. */
  run: (created: readonly CanvasItem[]) => Promise<void>;
  /** 지금 띄울 말풍선의 카드. 없으면 null. */
  card: CanvasItem | null;
  /** 그 카드의 상자. 배치 전이면 null(좌표 없이 그리면 구석에 떴다 튄다). */
  box: CoachBox | null;
  /** 입력창 위 한 줄. 없으면 null. */
  hint: string | null;
  /** 말풍선 닫기 — 입력창 문구도 함께 사라진다. */
  dismiss: (id: string) => void;
}

export function useQuestionCoach({
  items,
  positions,
  sizes,
  pickedId,
  patch,
}: Options): QuestionCoach {
  /**
   * 이 턴의 카드가 브랜치를 n+1로 만들었나 (D194).
   *
   * ## 턴을 막지 않는다
   *
   * 답이 다 나온 **뒤에** 따로 돈다. 실패하면 조용히 아무 일도 안 한다 —
   * 코치는 곁들이고, "RAG는 채팅을 절대 막지 않는다"와 같은 성질이다.
   */
  const run = useEventCallback(async (created: readonly CanvasItem[]) => {
    if (!created.length) return;
    /**
     * ⚠️ **방금 만든 카드를 store에서 되찾지 않는다.**
     *
     * 처음에는 id만 받아 store에서 찾았다. 그런데 이 함수는 저장이 끝난 직후에
     * 도는데, 그때 store에는 아직 **서버 id로 바뀐 행이 커밋되기 전**이다 —
     * 조회가 빈손이라 코치가 조용히 되돌아 나갔고, 화면에는 "그냥 말을 안 거는
     * 것"으로만 보였다(실측 2026-08-07, e2e가 잡았다: `/coach/settings`조차
     * 안 나갔다). 그래서 `send`가 실체를 돌려준다.
     */
    const fresh = created.filter((i) => i.kind === "concept" && i.source === "ai");
    if (!fresh.length) return;
    // 이 턴에 생긴 것 중 **마지막** 카드가 사슬의 끝이다(한 턴의 같은 태그는
    // 사슬로 이어진다 — D151).
    const head = fresh[fresh.length - 1];

    let minCards: number;
    try {
      const cfg = await getCoachSettings();
      if (!cfg.enabled) return;
      minCards = cfg.min_cards;
    } catch {
      return; // 설정을 못 읽으면 조용히 넘어간다
    }

    // 화면이 자기 상수로 n을 들고 있으면 관리자가 콘솔에서 바꿔도 안 따라간다
    // (D192에서 노브 여덟 개가 그 상태였다).
    //
    // 사슬의 **조상**은 store가 안다(이미 커밋된 옛 카드들). **이번 턴**은
    // store가 아직 모를 수 있으므로 위와 같은 이유로 `created`가 이긴다.
    const merged = new Map<string, CanvasItem>();
    for (const i of items) merged.set(i.id, i);
    for (const i of created) merged.set(i.id, i);
    const all: CoachItem[] = [...merged.values()].map((i) => ({
      id: i.id,
      parentItemId: i.parentItemId,
      kind: i.kind,
      source: i.source,
      seq: i.seq,
    }));
    // 이미 말을 건 카드들 — 중단한 경우도 포함한다. 중단도 "이 브랜치는 봤다"라
    // 바로 다시 물으면 LLM만 태운다.
    const spokenAt = new Set(items.filter((i) => i.data.coach).map((i) => i.id));

    if (!decideCoach(all, head.id, minCards, spokenAt).should) return;

    let advice = null;
    try {
      advice = await askQuestionDirections(chainForCoach(all, head.id));
    } catch {
      return; // 판정 실패는 아무 말도 안 하는 것과 같다
    }
    // **중단도 기록한다** — advice가 null이어도 `coach`를 남겨야 이 브랜치를
    // 다시 묻지 않는다.
    patch(head.id, { data: { ...head.data, coach: { advice } } });
  });

  /** 말풍선을 닫는다 — 입력창 위 문구도 함께 사라진다(권유이지 강요가 아니다). */
  const dismiss = useEventCallback((id: string) => {
    const it = items.find((i) => i.id === id);
    if (!it?.data.coach) return;
    patch(id, { data: { ...it.data, coach: { ...it.data.coach, dismissed: true } } });
  });

  /** 지금 띄울 말풍선 — 닫지 않았고 판정이 있는 것 하나. */
  const card = useMemo(
    () => items.find((i) => i.data.coach?.advice && !i.data.coach.dismissed) ?? null,
    [items],
  );

  const box = useMemo<CoachBox | null>(() => {
    if (!card) return null;
    const at = positions.get(card.id);
    if (!at) return null; // 아직 배치 전 — 좌표 없이 그리면 구석에 떴다 튄다
    return { x: at.x, y: at.y, w: sizes.get(card.id)?.w ?? ITEM_W };
  }, [card, positions, sizes]);

  /**
   * 입력창 위에 뜨는 방향 문구 (D194).
   *
   * **누른 카드가 그 카드일 때만** 뜬다(사용자 지시). 말풍선을 끄면 `dismissed`가
   * 붙어 함께 사라진다 — 권유이지 강요가 아니다.
   */
  const hint = useMemo(() => {
    if (!pickedId) return null;
    const c = items.find((i) => i.id === pickedId)?.data.coach;
    if (!c?.advice || c.dismissed) return null;
    return c.advice.hint;
  }, [items, pickedId]);

  return { run, card, box, hint, dismiss };
}
