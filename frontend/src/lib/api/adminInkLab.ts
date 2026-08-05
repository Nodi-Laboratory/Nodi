/**
 * 펜 표시 실험실이 쓰는 관리자 창구 (D178).
 *
 * 실험실 캔버스에 얹을 **실제 도판** 하나를 받아 온다. 붙박이 그림을 쓰면
 * `/files/figures/{id}/raw`(캔버스 오염 회피)와 `object-contain` 레터박스
 * 좌표 변환이 시험에서 빠진다 — 정작 눈으로 못 잡는 두 곳이 그것이다.
 *
 * 도판이 없는 기계면 `figure_id: null`이고, 그때 실험실은 **주소 없는 도판**
 * (D167) 상태를 그대로 시험한다. 오류가 아니다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface LabFigure {
  figure_id: string | null;
  caption: string;
  page: number | null;
}

export async function anyFigureForLab(): Promise<LabFigure> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/ink-lab/figure`, {
      headers: await authHeaders(),
    }),
  );
  return (await res.json()) as LabFigure;
}

/** 실험실이 SOLAR까지 태워 보기 위한 입력. */
export interface LabAnswerInput {
  question: string;
  marksNote: string;
  cards: Array<{ n: number; title: string; body: string }>;
}

export interface LabAnswer {
  ok: boolean;
  error: string;
  ms: number;
  answer: string;
  /** SOLAR가 실제로 받은 표시 블록 — 무엇을 보고 답했는지가 요점이다. */
  ink_block: string;
  system_prompt: string;
}

/**
 * 표시 맥락을 얹어 SOLAR에게 한 번 물어본다 (D178, 실험실 전용).
 *
 * 실험실 카드는 붙박이라 DB에 없어서 채팅 창구를 그대로 쓸 수 없다. 대신
 * **프롬프트 조립은 채팅과 같은 함수**를 태운다(`compose_system_structured`).
 */
export async function askLabSolar(input: LabAnswerInput): Promise<LabAnswer> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/ink-lab/answer`, {
      method: "POST",
      headers: { ...(await authHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({
        question: input.question,
        marks_note: input.marksNote,
        cards: input.cards,
      }),
    }),
  );
  return (await res.json()) as LabAnswer;
}
