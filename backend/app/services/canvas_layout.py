"""캔버스 태그-기반 카드 배치 모듈.

태그 앵커(Vogel 나선)에서 무겹침(AABB) 자리를 찾아 카드를 배치한다.

상수:
  CANVAS_W / CANVAS_H — 캔버스 크기
  MARGIN              — 좌측·상단 여백
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import get_settings

_S = get_settings()

# ---------------------------------------------------------------------------
# 상수
# ---------------------------------------------------------------------------
CANVAS_W = 3200
CANVAS_H = 2200
MARGIN = 40


# ---------------------------------------------------------------------------
# 태그 앵커 무겹침 배치. 순수 함수·결정론. CANVAS_W/CANVAS_H/MARGIN 재사용.
# ---------------------------------------------------------------------------


@dataclass
class ExistingCard:
    """무겹침 판정 대상(pin) 기존 카드. 좌상단 (x,y)·높이 h."""
    x: float
    y: float
    h: float


def estimate_card_height(body_lines: int) -> float:
    """본문 줄 수 → 카드 높이(clamp). done 시점 본문으로 산출."""
    h = _S.card_h_min + max(0, body_lines) * _S.card_h_per_line
    return max(_S.card_h_min, min(_S.card_h_max, h))


def _overlap(
    ax: float, ay: float, ah: float,
    bx: float, by: float, bh: float,
    gap: float = 0.0,
) -> tuple[float, float] | None:
    """두 카드의 AABB(좌상단 (ax,ay)/(bx,by), 폭 CARD_W, 높이 ah/bh) 겹침 판정.

    좌표는 프론트 렌더와 동일하게 **좌상단** 기준. gap을 포함해 두 축 모두에서
    겹치면 (pen_x, pen_y) 최소 침투량을 반환(양수), 한 축이라도 gap 이상
    떨어져 있으면 None. 외접원과 달리 가변 높이에서도 실제 사각형 무겹침을
    정확히 판정한다.
    """
    w = _S.card_w
    dcx = ax - bx  # 같은 폭이라 중심 x 차이 = 좌상단 x 차이
    dcy = (ay + ah / 2.0) - (by + bh / 2.0)
    pen_x = (w + gap) - abs(dcx)
    pen_y = (ah + bh) / 2.0 + gap - abs(dcy)
    if pen_x > 0 and pen_y > 0:
        return pen_x, pen_y
    return None


def _first_free_position(
    px: float, py: float, new_h: float, existing: list[ExistingCard]
) -> tuple[float, float]:
    """힘이 정한 (px,py)에서 나선으로 확장하며 어떤 기존 카드와도 안 겹치는
    가장 가까운 위치를 찾아 반환(결정론). 못 찾으면 마지막 후보를 반환."""
    step = _S.card_w / 3.0  # 탐색 간격(카드 폭보다 촘촘히 → 좁은 틈도 포착)

    def _clamp(x: float, y: float) -> tuple[float, float]:
        return (
            max(MARGIN, min(CANVAS_W - _S.card_w - MARGIN, x)),
            max(MARGIN, min(CANVAS_H - new_h - MARGIN, y)),
        )

    def _free(x: float, y: float) -> bool:
        return all(
            _overlap(x, y, new_h, c.x, c.y, c.h, _S.force_min_gap) is None
            for c in existing
        )

    for ring in range(0, 80):
        if ring == 0:
            cx, cy = _clamp(px, py)
            if _free(cx, cy):
                return (cx, cy)
            continue
        r = ring * step
        samples = ring * 8  # 링마다 각 샘플 수 증가(간격 일정 유지)
        for k in range(samples):
            ang = 2.0 * math.pi * k / samples
            cx, cy = _clamp(px + r * math.cos(ang), py + r * math.sin(ang))
            if _free(cx, cy):
                return (cx, cy)
    return _clamp(px, py)


_TAG_GOLDEN = math.radians(137.5)


def tag_anchor(k: int) -> tuple[float, float]:
    """태그 첫 등장 순서 k(0-based) → Vogel(해바라기) 나선 앵커(중앙 기준). 결정론.

    k=0 → 캔버스 중앙. k>0 → r=TAG_R0·√k, angle=k·137.5°로 부채꼴 분산.
    """
    cx, cy = CANVAS_W / 2.0, CANVAS_H / 2.0
    if k <= 0:
        return (cx, cy)
    r = _S.tag_r0 * math.sqrt(k)
    ang = k * _TAG_GOLDEN
    return (cx + r * math.cos(ang), cy + r * math.sin(ang))


def place_by_tag(
    anchor: tuple[float, float], existing: list[ExistingCard], new_h: float
) -> tuple[float, float]:
    """앵커를 카드 중심으로 두고, 기존 카드와 안 겹치는 가장 가까운 자리를 반환.

    같은 태그 카드는 같은 앵커에서 나선 확장 → 앵커 주변 조밀 클러스터.
    _first_free_position이 경계 클램프 + AABB 무겹침을 보장한다.
    """
    ax, ay = anchor
    px = ax - _S.card_w / 2.0   # 앵커=중심 → 좌상단 보정
    py = ay - new_h / 2.0
    return _first_free_position(px, py, new_h, existing)
