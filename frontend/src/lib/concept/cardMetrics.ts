// 개념 카드 치수 상수 — 단일 진실의 원천(SSOT). 여러 곳(ConceptCard 렌더,
// leafPlacement 충돌 회피, 미니맵/워크스페이스 중심 계산)에서 재사용한다.
// 백엔드 config(card_h_min/max/per_line)·estimate_card_height와 반드시 일치.

import { CARD_W } from "./curriculumTags";

// 카드 중심 x 오프셋(카드 폭의 절반) — top-left 좌표를 중심으로 옮길 때 사용.
export const CARD_CX = CARD_W / 2; // 210

// 본문량 기반 동적 높이 폴백(px). 서버 estimate_card_height(body_lines) =
// clamp(H_MIN + lines*PER_LINE, H_MIN, H_MAX)와 동일. 서버 저장 concept.h가
// 있으면 그 값을 신뢰하고, 없을 때만 이 폴백을 쓴다.
export const CARD_H_MIN = 160;
export const CARD_H_MAX = 560;
export const CARD_H_PER_LINE = 28;
// 스트리밍/pending 기본: 서버가 좌표 예약에 쓰는 estimate_card_height(2) 기준.
export const CARD_H_STREAM_LINES = 2;
