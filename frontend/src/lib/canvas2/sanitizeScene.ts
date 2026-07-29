/**
 * 저장된 그림 씬을 Excalidraw에 넘기기 전에 거른다.
 *
 * ## 왜 필요한가 (실측)
 *
 * `points`가 없는 freedraw 요소 하나가 DB에 있으면 Excalidraw의 `restore`가
 * `isInvisiblySmallElement`에서 터지고 **캔버스 전체가 뜨지 않는다.** 요소
 * 하나 때문에 학생의 글까지 전부 사라진다.
 *
 * 서버에서 막지 않는 이유: Excalidraw의 요소 스키마를 백엔드가 알면 버전을
 * 올릴 때마다 양쪽을 맞춰야 한다. 신뢰 경계는 "우리 DB"가 아니라 "Excalidraw에
 * 넘기기 직전"이 맞다.
 *
 * 관대하게 거른다 — 타입별 필수 필드만 본다. 나머지 검증은 Excalidraw가 한다.
 */

const NUM = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);

/** 좌표 배열을 쓰는 타입. 이게 없으면 restore가 죽는다. */
const POINT_TYPES = new Set(["freedraw", "line", "arrow"]);

function ok(el: unknown): boolean {
  if (!el || typeof el !== "object") return false;
  const e = el as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return false;
  if (typeof e.type !== "string") return false;
  if (!NUM(e.x) || !NUM(e.y)) return false;

  if (POINT_TYPES.has(e.type)) {
    if (!Array.isArray(e.points)) return false;
    // 점 하나하나가 [x, y]여야 한다. 하나만 깨져도 렌더가 죽는다.
    if (!e.points.every((p) => Array.isArray(p) && NUM(p[0]) && NUM(p[1]))) return false;
  }
  if (e.type === "text" && typeof e.text !== "string") return false;
  return true;
}

export interface SanitizeResult {
  elements: unknown[];
  /** 버린 개수. 0이 아니면 사용자에게 알린다. */
  dropped: number;
}

export function sanitizeScene(elements: unknown): SanitizeResult {
  if (!Array.isArray(elements)) return { elements: [], dropped: 0 };
  const kept = elements.filter(ok);
  return { elements: kept, dropped: elements.length - kept.length };
}
