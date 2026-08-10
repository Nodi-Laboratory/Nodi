/**
 * 지도 노드 색 — **파스텔 한 벌** (사용자 지시 2026-08-09).
 *
 * ## 왜 한곳에 두나
 *
 * 지도가 셋이다: 홈 개념 지도 · 캔버스 미니맵 · 지도 모달. 색을 각자 갖고
 * 있으면 같은 분류가 화면마다 다른 색으로 뜬다 — 학생 눈에는 서로 다른
 * 것으로 읽힌다. 한 벌을 셋이 나눠 쓴다.
 *
 * ## 왜 파스텔인가
 *
 * 홈 지도는 이제 **베이지 덮개 아래**에 깔린다(배경이다). 진한 색은 그 위에
 * 뜬 글씨와 다투고, 점 수십 개가 화면을 시끄럽게 만든다. 파스텔은 배경으로
 * 물러나면서도 무리가 갈리는 것은 보여 준다.
 *
 * ## 색은 이름으로 정한다
 *
 * 분류 이름을 해시해 이 목록에서 고른다 — **같은 분류는 어느 화면에서나 같은
 * 색**이고, 목록이 유한하므로 서로 구분되는 색만 쓴다(연속 hue는 이웃한 두
 * 분류가 사실상 같은 색으로 뽑히는 일이 생긴다).
 */

/**
 * 파스텔 여섯. 색상환을 고르게 돌되 **초록 대역은 비운다** — 브랜드 초록
 * (`--accent`)과 겹치면 "AI가 만든 것"이라는 신호(D120의 오커·틸 구분)와
 * 섞인다.
 */
export const PASTEL_COLORS = [
  "#a8c8e8", // 하늘
  "#b8b0e0", // 라벤더
  "#d0a8d8", // 연보라
  "#e8b8b0", // 살구
  "#e0cba0", // 모래
  "#a8d0c0", // 민트
] as const;

/** 분류가 없는 점. 있는 것과 확실히 구분되는 흐린 중립색이다. */
export const PASTEL_NEUTRAL = "#cfd0c8";

/** 문자열 → 0..1. `conceptLayout.hash01`과 같은 규칙이어야 색이 안 흔들린다. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** 분류 이름 → 파스텔 한 가지. 이름이 없으면 중립색. */
export function pastelForTag(tag: string | null | undefined): string {
  const t = (tag ?? "").trim();
  if (!t) return PASTEL_NEUTRAL;
  return PASTEL_COLORS[Math.floor(hash01(t) * PASTEL_COLORS.length) % PASTEL_COLORS.length];
}

