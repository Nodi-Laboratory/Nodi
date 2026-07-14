// 미니맵 순수 레이아웃 — 클러스터 공간 centroid, 월드→미니맵 픽셀 매핑(종횡비 보존),
// 카메라 가시영역→미니맵 사각형. DOM/React 독립(테스트·재사용). d3 미의존(순수 산술);
// d3.scaleLinear 사용은 렌더 컴포넌트(ConceptMinimap)에서 이 Fit로 구성한다.

import { CARD_CX } from "./cardMetrics";
import type { Concept, ConceptGroup } from "./types";

const CARD_H_FALLBACK = 200; // 높이 미상 시 근사(중심 계산용)

export interface MiniCentroid {
  id: string;
  label: string;
  count: number;
  repConceptId: string;
  wx: number;
  wy: number;
}
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Fit {
  s: number;
  ox: number;
  oy: number;
}

// 그룹별 멤버 카드 "중심"의 월드 평균. 좌표 없는 멤버 제외, 유효 멤버 0이면 그룹 스킵.
export function groupCentroids(
  groups: ConceptGroup[],
  concepts: Concept[],
): MiniCentroid[] {
  const byId = new Map<string, Concept>();
  for (const c of concepts) byId.set(c.id, c);
  const out: MiniCentroid[] = [];
  for (const g of groups) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const mid of g.memberIds) {
      const c = byId.get(mid);
      if (!c || typeof c.x !== "number" || typeof c.y !== "number") continue;
      const h = typeof c.h === "number" && c.h > 0 ? c.h : CARD_H_FALLBACK;
      sx += c.x + CARD_CX;
      sy += c.y + h / 2;
      n += 1;
    }
    if (n === 0) continue;
    out.push({
      id: g.id,
      label: g.label,
      count: g.memberIds.length,
      repConceptId: g.repConceptId,
      wx: sx / n,
      wy: sy / n,
    });
  }
  return out;
}

export function worldBBox(pts: Array<{ wx: number; wy: number }>): BBox | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.wx < minX) minX = p.wx;
    if (p.wx > maxX) maxX = p.wx;
    if (p.wy < minY) minY = p.wy;
    if (p.wy > maxY) maxY = p.wy;
  }
  return { minX, minY, maxX, maxY };
}

// bbox를 (width×height) 안에 pad 여백으로, 단일 배율 s=min(sx,sy)로 종횡비 보존 매핑.
// cx = ox + wx*s, cy = oy + wy*s. 폭 0(단일/동일 좌표)이면 s를 상한으로 클램프.
export function fitTransform(bbox: BBox, width: number, height: number, pad: number): Fit {
  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  const availW = width - 2 * pad;
  const availH = height - 2 * pad;
  const sX = bw > 0 ? availW / bw : Infinity;
  const sY = bh > 0 ? availH / bh : Infinity;
  let s = Math.min(sX, sY);
  if (!Number.isFinite(s)) s = 1; // 점 1개(또는 모두 동일 좌표) → 배율 1, 중앙 배치
  // 사용 영역을 중앙 정렬: ox = pad + (availW - bw*s)/2 - minX*s
  const ox = pad + (availW - bw * s) / 2 - bbox.minX * s;
  const oy = pad + (availH - bh * s) / 2 - bbox.minY * s;
  return { s, ox, oy };
}

export function project(wx: number, wy: number, fit: Fit): { cx: number; cy: number } {
  return { cx: fit.ox + wx * fit.s, cy: fit.oy + wy * fit.s };
}

// 카메라 가시 월드 사각형 → 미니맵 픽셀 사각형.
// 가시 월드 top-left = (-cam.x/scale, -cam.y/scale), size = (vp.w/scale, vp.h/scale).
export function viewportRectPx(
  camera: { x: number; y: number; scale: number },
  vp: { w: number; h: number },
  fit: Fit,
): { x: number; y: number; w: number; h: number } {
  const s = camera.scale || 1;
  const wx0 = -camera.x / s;
  const wy0 = -camera.y / s;
  const { cx, cy } = project(wx0, wy0, fit);
  return { x: cx, y: cy, w: (vp.w / s) * fit.s, h: (vp.h / s) * fit.s };
}
