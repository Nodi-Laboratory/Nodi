// 카드 치수 상수 — 단일 진실의 원천(SSOT).
//
// 높이 정책(사용자 결정 2026-07-23): 카드에 최소/최대 높이 클램프를 두지 않고,
// 본문 바이트 수에 따라 카드가 그대로 늘어나고 줄어든다. 실제 DOM 카드는
// height:auto 로 "내용에 딱 맞게"(ConceptCard·ConceptCard.module.css) 렌더되므로,
// 아래 cardHeight()는 **레이아웃 충돌 회피(leafPlacement·useTagLayout)용 높이
// 추정치**로만 쓰인다 — DOM 렌더 높이를 직접 정하지 않는다. 추정이라 실제와
// 약간 어긋날 수 있으나 useTagLayout의 COLLIDE_GAP 여백이 이를 흡수한다.
// (2026-07-14 백엔드 포지셔닝 제거로 concept.h는 서버가 채우지 않으므로,
// 아래 바이트 기반 추정이 사실상 유일한 높이 산출 경로다.)

import { CARD_W } from "./curriculumTags";
import type { Block, Concept } from "./types";

// 카드 중심 x 오프셋(카드 폭의 절반) — top-left 좌표를 중심으로 옮길 때 사용.
export const CARD_CX = CARD_W / 2; // 210

// 본문 외 고정 세로 높이(px) — 제목 + 상하 패딩 등 "chrome". 본문이 0이어도
// 카드는 이만큼은 차지한다(클램프가 아니라 구조상 고정 요소의 실측 근사).
export const CARD_CHROME_H = 116;
// 본문 한 줄당 높이(px) — 본문 폰트 21px * line-height 1.6 ≈ 34.
export const CARD_H_PER_LINE = 34;
// 카드 폭 기준 한 줄에 들어가는 본문 UTF-8 바이트 수. 한글 ~18자 * 3B ≈ 54를
// 조금 낮게(과대추정=카드가 살짝 큼 쪽) 잡는다 — 충돌 여백은 넉넉한 편이 안전.
export const CARD_BYTES_PER_LINE = 50;
// 스트리밍/pending: 첫 문단이 도착하기 전 예약해두는 줄 수.
export const CARD_STREAM_LINES = 2;
// D74: 출처 칩 푸터가 있으면 그만큼 세로를 더 잡는다(충돌 추정 보정).
export const SOURCES_EXTRA_H = 36;

// UTF-8 바이트 길이. 한글은 글자당 3바이트라 "글자 수"가 아니라 "바이트 수"로
// 재야 실제 텍스트 분량(카드 크기)에 비례한다.
const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

// 본문 "p" 블록들의 바이트 수 기준 줄 수 추정. 각 문단은 최소 1줄이고, 문단
// 바이트를 한 줄 바이트로 나눠 올림 → 문단별로 줄바꿈 잔여분까지 반영한다.
export function estimateBodyLines(blocks: Pick<Block, "type" | "tokens">[] = []): number {
  let lines = 0;
  for (const b of blocks) {
    if (b.type !== "p") continue;
    const text = (b.tokens ?? []).map((t) => t.ch).join("");
    const bytes = byteLength(text);
    lines += Math.max(1, Math.ceil(bytes / CARD_BYTES_PER_LINE));
  }
  return lines;
}

// 카드 충돌 회피용 높이 추정(px). 최소/최대 클램프 없음 — 본문 바이트만큼
// 선형으로 늘어난다. concept.h(서버 저장값)가 있으면 그 값을 신뢰한다.
export function cardHeight(
  concept: Pick<Concept, "h" | "pending" | "blocks">,
  hasSources = false,
): number {
  const extra = hasSources ? SOURCES_EXTRA_H : 0;
  if (typeof concept.h === "number" && concept.h > 0) return concept.h + extra;
  const lines = concept.pending
    ? CARD_STREAM_LINES
    : estimateBodyLines(concept.blocks ?? []);
  return CARD_CHROME_H + Math.max(0, lines) * CARD_H_PER_LINE + extra;
}
