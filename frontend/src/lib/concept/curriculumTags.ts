// 고2 지구과학 7개 고정 태그 → 지도 고정 앵커(칠각형). EXAONE 프롬프트의 분류 문자열과
// 반드시 정확히 일치해야 한다(모델 출력 → 앵커 매핑). 미지/"기타"는 중앙 폴백.

export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CENTER = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

// 순서 = 칠각형 인덱스. 백엔드 CONCEPT_CARD_SYSTEM_PROMPT와 글자까지 동일.
export const CURRICULUM_TAGS = [
  "해수의 운동과 순환",
  "지구의 형성과 역장",
  "지구 구성 물질과 자원",
  "한반도의 지질",
  "대기의 운동과 순환",
  "행성의 운동",
  "우리은하와 우주의 구조",
] as const;

const R = 1400; // 칠각형 반경(px) — 클러스터 간 분리
const _ANCHORS = new Map<string, { x: number; y: number }>();
CURRICULUM_TAGS.forEach((t, i) => {
  const th = -Math.PI / 2 + (i * 2 * Math.PI) / CURRICULUM_TAGS.length;
  _ANCHORS.set(t, { x: CENTER.x + R * Math.cos(th), y: CENTER.y + R * Math.sin(th) });
});

// 태그 → 고정 앵커. 7개 밖/"기타"/미지 → 중앙.
export function tagAnchor(tag: string): { x: number; y: number } {
  return _ANCHORS.get(tag) ?? CENTER;
}
