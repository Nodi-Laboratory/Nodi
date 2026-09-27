"""데모 시드 자산을 만든다 — 그림 · PDF · 벡터 (공개판 2026-09-27).

**개발자가 가끔 돌리는 스크립트다.** 결과물(`app/seed_demo/assets/`)은 커밋되고,
컨테이너의 시드(`python -m app.cli seed-demo`)는 그 파일을 복사·적재만 한다.
그래서 여기서 쓰는 Pillow·한글 폰트·Upstage 키는 **실행 이미지에 필요 없다.**

    cd backend
    .venv/Scripts/python -m scripts.build_demo_assets            # 그림 + PDF + manifest 배치
    .venv/Scripts/python -m scripts.build_demo_assets --embed    # + 벡터(키 필요, backend/.env)

## 그림은 전부 여기서 직접 그린다

교과서 도판·학급 사진·클립 썸네일 모두 아래 코드가 도형으로 그린 모식도다.
저작권 있는 그림을 한 장도 쓰지 않는다.

## PDF는 이미지 PDF다

한글 글리프를 PDF에 넣으려면 CID 폰트를 서브셋해 심어야 한다. 시연용 파일
몇 장에 그 복잡도를 들일 이유가 없어서, 쪽을 Pillow로 그려 **이미지 한 장짜리
쪽**으로 담는다(팔레트 64색 + Flate — 글자가 뭉개지지 않고 쪽당 수십 KB).
글자를 긁어 복사할 수는 없지만, 파일 보기·내려받기는 그대로 된다. RAG 청크는
PDF를 파싱해 얻지 않고 `content.py`의 원문을 그대로 넣는다 — 인쇄된 글과 청크가
같은 원고에서 나오므로 어긋날 수 없다.

폰트는 Noto Sans KR(OFL)을 쓴다. 윈도우에 기본으로 깔려 있고, 다른 곳에서는
`NODI_DEMO_FONT`로 경로를 준다.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import io
import json
import math
import os
import sys
import zlib
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from app.seed_demo import content as c  # noqa: E402
from app.seed_demo import vectors as v  # noqa: E402

ASSETS = v.ASSETS

_FONT_CANDIDATES = [
    os.environ.get("NODI_DEMO_FONT", ""),
    "C:/Windows/Fonts/NotoSansKR-VF.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansKR-VF.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def _font_path() -> str:
    for p in _FONT_CANDIDATES:
        if p and Path(p).is_file():
            return p
    raise SystemExit("한글 폰트를 못 찾았다 — NODI_DEMO_FONT=<Noto Sans KR 경로>로 준다")


_FONT_CACHE: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = (size, bold)
    if key not in _FONT_CACHE:
        f = ImageFont.truetype(_font_path(), size)
        try:
            f.set_variation_by_name("Bold" if bold else "Regular")
        except (OSError, ValueError):
            pass  # 가변 폰트가 아니면 굵기 축이 없다 — 그대로 쓴다
        _FONT_CACHE[key] = f
    return _FONT_CACHE[key]


# ---------------------------------------------------------------------------
# 그리기 도구
# ---------------------------------------------------------------------------
INK = (46, 52, 64)
MUTED = (110, 118, 130)


def text(d: ImageDraw.ImageDraw, xy, s: str, size=20, bold=False, fill=INK, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=fill, anchor=anchor)


def arrow(d, p0, p1, fill, width=6, head=18):
    """굵은 화살표. 머리는 끝점에 삼각형으로 붙인다."""
    x0, y0 = p0
    x1, y1 = p1
    ang = math.atan2(y1 - y0, x1 - x0)
    # 몸통은 머리 밑동까지만 — 끝까지 그으면 뾰족한 머리가 뭉툭해진다.
    bx, by = x1 - head * 0.8 * math.cos(ang), y1 - head * 0.8 * math.sin(ang)
    d.line([p0, (bx, by)], fill=fill, width=width)
    left = (x1 - head * math.cos(ang - 0.45), y1 - head * math.sin(ang - 0.45))
    right = (x1 - head * math.cos(ang + 0.45), y1 - head * math.sin(ang + 0.45))
    d.polygon([p1, left, right], fill=fill)


def leader(d, label_xy, target, s, size=19):
    """이름표 + 지시선. 이름표 왼쪽 끝에서 대상까지 가는 선을 긋는다."""
    lx, ly = label_xy
    d.line([(lx - 8, ly), target], fill=MUTED, width=2)
    d.ellipse([target[0] - 4, target[1] - 4, target[0] + 4, target[1] + 4], fill=MUTED)
    text(d, (lx, ly), s, size=size, anchor="lm")


def canvas(w=900, h=560, bg=(255, 255, 255)):
    im = Image.new("RGB", (w, h), bg)
    return im, ImageDraw.Draw(im)


def save_png(im: Image.Image, name: str) -> None:
    # 팔레트로 줄여 저장 — 모식도는 색이 몇 개뿐이라 품질 손실 없이 크기가 1/3이 된다.
    out = im.convert("P", palette=Image.Palette.ADAPTIVE, colors=96)
    out.save(ASSETS / name, optimize=True)


# ---------------------------------------------------------------------------
# 교과서 도판
# ---------------------------------------------------------------------------
LEAF = (143, 207, 111)
LEAF_DARK = (76, 138, 58)
CHLORO = (63, 143, 58)
WATER = (70, 130, 210)
SUN = (255, 196, 40)
CO2 = (120, 120, 130)
O2 = (60, 170, 200)
SUGAR = (220, 130, 50)


def fig_photosynthesis() -> Image.Image:
    im, d = canvas()
    # 해와 빛
    d.ellipse([60, 40, 160, 140], fill=SUN)
    for k in range(12):
        a = k * math.pi / 6
        d.line([(110 + 62 * math.cos(a), 90 + 62 * math.sin(a)),
                (110 + 82 * math.cos(a), 90 + 82 * math.sin(a))], fill=SUN, width=5)
    arrow(d, (175, 140), (330, 205), SUN, width=10, head=26)
    text(d, (190, 190), "빛에너지", size=22, bold=True, fill=(190, 130, 0))
    # 잎자루(줄기)와 잎
    d.line([(450, 380), (450, 500)], fill=LEAF_DARK, width=12)
    d.ellipse([270, 160, 630, 390], fill=LEAF, outline=LEAF_DARK, width=4)
    d.line([(290, 275), (610, 275)], fill=LEAF_DARK, width=3)
    d.ellipse([370, 235, 530, 315], fill=CHLORO, outline=(40, 100, 40), width=3)
    text(d, (450, 275), "엽록체", size=24, bold=True, fill=(255, 255, 255), anchor="mm")
    # 들어오는 것
    arrow(d, (40, 300), (285, 290), CO2, width=8, head=22)
    text(d, (40, 262), "이산화 탄소", size=22, bold=True, fill=CO2)
    text(d, (40, 318), "(기공으로 들어옴)", size=17, fill=MUTED)
    arrow(d, (490, 520), (490, 395), WATER, width=8, head=22)
    text(d, (510, 470), "물", size=22, bold=True, fill=WATER)
    text(d, (510, 498), "(뿌리 → 물관)", size=17, fill=MUTED)
    # 나가는 것
    arrow(d, (615, 225), (830, 175), O2, width=8, head=22)
    text(d, (640, 118), "산소", size=22, bold=True, fill=O2)
    text(d, (640, 148), "(기공으로 나감)", size=17, fill=MUTED)
    arrow(d, (610, 330), (820, 400), SUGAR, width=8, head=22)
    text(d, (640, 410), "포도당", size=22, bold=True, fill=SUGAR)
    text(d, (640, 440), "→ 녹말(저장) · 설탕(이동)", size=17, fill=MUTED)
    text(d, (450, 540), "이산화 탄소 + 물  →  포도당 + 산소   (빛에너지, 엽록체)",
         size=19, bold=True, anchor="mm")
    return im


def fig_leaf_section() -> Image.Image:
    im, d = canvas()
    x0, x1 = 50, 600
    # 큐티클층 + 윗표피
    d.rectangle([x0, 56, x1, 62], fill=(120, 150, 80))
    for x in range(x0, x1, 55):
        d.rectangle([x, 62, x + 55, 100], fill=(238, 246, 232), outline=(107, 143, 90), width=2)
    # 울타리 조직
    for i, x in enumerate(range(x0 + 4, x1 - 30, 42)):
        d.rounded_rectangle([x, 104, x + 36, 226], radius=14, fill=(159, 208, 138),
                            outline=(90, 140, 70), width=2)
        for j in range(5):
            cy = 120 + j * 22
            cx = x + 10 + ((i + j) % 2) * 14
            d.ellipse([cx, cy, cx + 11, cy + 8], fill=CHLORO)
    # 해면 조직 — 세포 사이에 틈이 많다
    spots = [(70, 250), (140, 285), (215, 245), (100, 335), (180, 350), (250, 310),
             (470, 250), (540, 290), (430, 330), (505, 360), (575, 245), (590, 345),
             (60, 385), (270, 380), (420, 385)]
    for (sx, sy) in spots:
        d.ellipse([sx - 26, sy - 20, sx + 26, sy + 20], fill=(185, 222, 168),
                  outline=(100, 150, 80), width=2)
        d.ellipse([sx - 6, sy - 4, sx + 5, sy + 4], fill=CHLORO)
    # 잎맥: 물관(위) · 체관(아래)
    d.ellipse([285, 238, 395, 372], fill=(245, 240, 220), outline=(150, 130, 90), width=3)
    for (cx, cy) in [(318, 272), (345, 265), (372, 274), (330, 298), (360, 298)]:
        d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=(143, 184, 232),
                  outline=(70, 110, 170), width=2)
    for (cx, cy) in [(318, 330), (340, 342), (363, 332), (350, 318)]:
        d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=(240, 183, 122),
                  outline=(180, 110, 50), width=2)
    # 아랫표피 + 기공
    for x in range(x0, x1, 55):
        if 150 <= x <= 205:
            continue
        d.rectangle([x, 410, x + 55, 446], fill=(238, 246, 232), outline=(107, 143, 90), width=2)
    d.ellipse([150, 408, 176, 450], fill=(124, 196, 106), outline=(60, 120, 50), width=2)
    d.ellipse([184, 408, 210, 450], fill=(124, 196, 106), outline=(60, 120, 50), width=2)
    d.rectangle([x0, 446, x1, 452], fill=(120, 150, 80))
    # 이름표
    lx = 650
    leader(d, (lx, 59), (x1 - 4, 59), "큐티클층")
    leader(d, (lx, 92), (x1 - 20, 82), "윗표피")
    leader(d, (lx, 165), (x1 - 40, 165), "울타리 조직")
    leader(d, (lx, 250), (578, 250), "해면 조직")
    leader(d, (lx, 300), (372, 274), "물관")
    leader(d, (lx, 340), (363, 332), "체관")
    leader(d, (lx, 428), (x1 - 20, 428), "아랫표피")
    leader(d, (lx, 480), (180, 452), "기공")
    leader(d, (lx, 520), (163, 440), "공변세포")
    text(d, (340, 395), "잎맥", size=18, bold=True, fill=(120, 95, 50), anchor="mm")
    return im


def _guard_cells(d, cx, cy, opened: bool):
    """공변세포 한 쌍. 안쪽(기공 쪽) 벽을 굵게 그려 두께 차이를 보인다."""
    fill = (124, 196, 106)
    edge = (60, 120, 50)
    if opened:
        left = [cx - 70, cy - 95, cx - 8, cy + 95]
        right = [cx + 8, cy - 95, cx + 70, cy + 95]
        d.ellipse(left, fill=fill, outline=edge, width=3)
        d.ellipse(right, fill=fill, outline=edge, width=3)
        d.ellipse([cx - 16, cy - 62, cx + 16, cy + 62], fill=(60, 70, 60))
        d.arc([cx - 70, cy - 95, cx - 8, cy + 95], -60, 60, fill=(30, 80, 30), width=9)
        d.arc([cx + 8, cy - 95, cx + 70, cy + 95], 120, 240, fill=(30, 80, 30), width=9)
    else:
        left = [cx - 52, cy - 95, cx + 1, cy + 95]
        right = [cx - 1, cy - 95, cx + 52, cy + 95]
        d.ellipse(left, fill=fill, outline=edge, width=3)
        d.ellipse(right, fill=fill, outline=edge, width=3)
        d.line([(cx, cy - 55), (cx, cy + 55)], fill=(60, 70, 60), width=4)
    for k in range(4):
        yy = cy - 60 + k * 38
        d.ellipse([cx - 44, yy, cx - 32, yy + 9], fill=CHLORO)
        d.ellipse([cx + 32, yy, cx + 44, yy + 9], fill=CHLORO)


def fig_stoma() -> Image.Image:
    im, d = canvas()
    for panel, opened in ((0, True), (450, False)):
        # 배경 표피 세포
        for r in range(4):
            for q in range(4):
                x = panel + 30 + q * 100
                y = 40 + r * 110
                d.rounded_rectangle([x, y, x + 96, y + 106], radius=18,
                                    fill=(241, 247, 236), outline=(190, 210, 180), width=2)
        cx, cy = panel + 225, 250
        d.ellipse([cx - 95, cy - 120, cx + 95, cy + 120], fill=(241, 247, 236))
        _guard_cells(d, cx, cy, opened)
        title = "열린 기공" if opened else "닫힌 기공"
        note = "공변세포에 물이 들어와 부풂" if opened else "공변세포에서 물이 빠져나감"
        text(d, (cx, 495), title, size=24, bold=True, anchor="mm")
        text(d, (cx, 527), note, size=18, fill=MUTED, anchor="mm")
    d.line([(450, 30), (450, 470)], fill=(200, 200, 200), width=2)
    leader(d, (330, 90), (250, 170), "공변세포", size=18)
    leader(d, (330, 400), (225, 300), "기공", size=18)
    leader(d, (780, 400), (720, 330), "공변세포", size=18)
    text(d, (225, 380), "안쪽 벽이 두껍다", size=15, fill=(30, 80, 30), anchor="mm")
    return im


def _plant(d, cx, base_y, leaf=LEAF):
    d.polygon([(cx - 55, base_y), (cx + 55, base_y), (cx + 42, base_y + 70),
               (cx - 42, base_y + 70)], fill=(190, 110, 70))
    d.line([(cx, base_y), (cx, base_y - 170)], fill=LEAF_DARK, width=8)
    for (dx, dy, s) in [(-1, -60, 1), (1, -100, 1), (-1, -140, 0.8), (1, -165, 0.7)]:
        w, h = 90 * s, 40 * s
        x = cx + (8 if dx > 0 else -8 - w)
        d.ellipse([x, base_y + dy - h / 2, x + w, base_y + dy + h / 2], fill=leaf,
                  outline=LEAF_DARK, width=2)


def fig_day_night() -> Image.Image:
    im, d = canvas()
    d.rectangle([0, 0, 449, 560], fill=(232, 244, 255))
    d.rectangle([451, 0, 900, 560], fill=(35, 48, 90))
    # 낮
    d.ellipse([30, 30, 100, 100], fill=SUN)
    _plant(d, 225, 400)
    arrow(d, (40, 260), (170, 280), CO2, width=7, head=20)
    text(d, (40, 222), "이산화 탄소 흡수", size=19, bold=True, fill=(80, 80, 90))
    arrow(d, (285, 250), (420, 220), O2, width=7, head=20)
    text(d, (300, 176), "산소 방출", size=19, bold=True, fill=(30, 120, 150))
    text(d, (225, 505), "낮: 광합성량 > 호흡량", size=23, bold=True, anchor="mm")
    # 밤
    d.ellipse([800, 30, 860, 90], fill=(245, 240, 200))
    d.ellipse([815, 22, 875, 82], fill=(35, 48, 90))
    for (sx, sy) in [(520, 50), (600, 90), (700, 40), (760, 130), (540, 150)]:
        d.ellipse([sx, sy, sx + 5, sy + 5], fill=(230, 230, 200))
    _plant(d, 675, 400, leaf=(110, 170, 90))
    arrow(d, (490, 260), (620, 280), (120, 210, 230), width=7, head=20)
    text(d, (490, 222), "산소 흡수", size=19, bold=True, fill=(150, 225, 240))
    arrow(d, (735, 250), (870, 220), (200, 200, 210), width=7, head=20)
    text(d, (720, 176), "이산화 탄소 방출", size=19, bold=True, fill=(225, 225, 235))
    text(d, (675, 505), "밤: 호흡만 일어남", size=23, bold=True, fill=(255, 255, 255), anchor="mm")
    return im


def fig_atom() -> Image.Image:
    im, d = canvas()
    cx, cy = 320, 280
    for r in (110, 195):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(170, 175, 185), width=3)
    d.ellipse([cx - 42, cy - 42, cx + 42, cy + 42], fill=(240, 138, 126),
              outline=(190, 80, 70), width=3)
    text(d, (cx, cy), "+3", size=30, bold=True, fill=(255, 255, 255), anchor="mm")
    electrons = [(110, 35), (110, 215), (195, 300)]
    pos = []
    for r, deg in electrons:
        a = math.radians(deg)
        ex, ey = cx + r * math.cos(a), cy - r * math.sin(a)
        pos.append((ex, ey))
        d.ellipse([ex - 18, ey - 18, ex + 18, ey + 18], fill=(80, 130, 220),
                  outline=(40, 80, 170), width=2)
        text(d, (ex, ey - 2), "−", size=28, bold=True, fill=(255, 255, 255), anchor="mm")
    leader(d, (600, 170), (cx + 30, cy - 30), "원자핵: (+)전하, +3")
    leader(d, (600, 360), (pos[2][0] + 13, pos[2][1] - 13), "전자: (−)전하, 각각 −1")
    text(d, (600, 250), "리튬 원자 (간단히 나타낸 모형)", size=19, bold=True)
    text(d, (450, 525), "(+3) + (−1) × 3 = 0   →   원자는 전기적으로 중성",
         size=21, bold=True, anchor="mm")
    return im


def fig_wire_field() -> Image.Image:
    im, d = canvas()
    cx, cy = 280, 280
    for r, w in ((70, 5), (130, 4), (195, 3)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(70, 110, 200), width=w)
        # 시계 반대 방향: 화면에서 위쪽 점은 왼쪽으로, 아래쪽 점은 오른쪽으로 간다.
        arrow(d, (cx + 14, cy - r), (cx - 14, cy - r), (70, 110, 200), width=w, head=16)
        arrow(d, (cx - 14, cy + r), (cx + 14, cy + r), (70, 110, 200), width=w, head=16)
    # 나침반 바늘 — N극(빨강)이 자기장 방향을 가리킨다
    for deg in (0, 90, 180, 270):
        a = math.radians(deg)
        px, py = cx + 130 * math.cos(a), cy - 130 * math.sin(a)
        # 시계 반대 방향 접선(수학 좌표) = (-sin, cos) → 화면 y는 뒤집는다
        tx, ty = -math.sin(a), -math.cos(a)
        if deg in (90, 270):
            continue
        n_tip = (px + 26 * tx, py + 26 * ty)
        s_tip = (px - 26 * tx, py - 26 * ty)
        nx, ny = -ty, tx
        side_a = (px + 7 * nx, py + 7 * ny)
        side_b = (px - 7 * nx, py - 7 * ny)
        d.polygon([n_tip, side_a, side_b], fill=(220, 60, 60))
        d.polygon([s_tip, side_a, side_b], fill=(235, 235, 235), outline=(150, 150, 150))
    d.ellipse([cx - 18, cy - 18, cx + 18, cy + 18], fill=(250, 250, 250), outline=INK, width=3)
    d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=INK)
    x = 530
    text(d, (x, 120), "위에서 내려다본 모습", size=22, bold=True)
    text(d, (x, 170), "⊙  전류가 종이 면에서", size=19)
    text(d, (x, 198), "     나오는 방향", size=19)
    text(d, (x, 250), "파란 원: 자기장 (시계 반대 방향)", size=19)
    text(d, (x, 290), "나침반의 빨간 끝(N극)이", size=19)
    text(d, (x, 318), "자기장 방향을 가리킨다", size=19)
    text(d, (x, 380), "오른손 엄지 = 전류 방향", size=19, bold=True)
    text(d, (x, 410), "네 손가락 = 자기장 방향", size=19, bold=True)
    text(d, (x, 465), "도선에 가까울수록 자기장이 강하다", size=18, fill=MUTED)
    return im


def _bulb(d, cx, cy, r=24):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 245, 190), outline=INK, width=3)
    k = r * 0.62
    d.line([(cx - k, cy - k), (cx + k, cy + k)], fill=INK, width=3)
    d.line([(cx - k, cy + k), (cx + k, cy - k)], fill=INK, width=3)


def _battery(d, x, cy):
    """세로 전지 기호: 긴 선이 (+)극, 짧고 굵은 선이 (−)극."""
    d.line([(x - 26, cy - 8), (x + 26, cy - 8)], fill=INK, width=3)
    d.line([(x - 14, cy + 8), (x + 14, cy + 8)], fill=INK, width=8)
    text(d, (x - 44, cy - 10), "+", size=22, bold=True, anchor="mm")
    text(d, (x - 44, cy + 12), "−", size=22, bold=True, anchor="mm")


def fig_circuits() -> Image.Image:
    im, d = canvas()
    w = (60, 70, 80)
    # 직렬
    L, R, T, B = 80, 380, 110, 380
    d.line([(L, T), (R, T), (R, B), (L, B), (L, 255)], fill=w, width=4)
    d.line([(L, 237), (L, T)], fill=w, width=4)
    d.rectangle([L - 30, 240, L + 30, 252], fill=(255, 255, 255))
    _battery(d, L, 246)
    for bx in (180, 290):
        d.rectangle([bx - 26, T - 4, bx + 26, T + 4], fill=(255, 255, 255))
        _bulb(d, bx, T)
    text(d, (230, 430), "직렬연결", size=26, bold=True, anchor="mm")
    text(d, (230, 468), "전류가 흐르는 길이 하나", size=18, fill=MUTED, anchor="mm")
    text(d, (230, 496), "전구 하나를 빼면 모두 꺼진다", size=18, fill=MUTED, anchor="mm")
    d.line([(450, 60), (450, 520)], fill=(210, 210, 210), width=2)
    # 병렬
    L, R, T, M, B = 530, 830, 110, 245, 380
    d.line([(L, T), (R, T), (R, B), (L, B)], fill=w, width=4)
    d.line([(L, T), (L, 300)], fill=w, width=4)
    d.line([(L, 330), (L, B)], fill=w, width=4)
    d.line([(L, M), (R, M)], fill=w, width=4)
    _battery(d, L, 315)
    for (bx, by) in ((680, T), (680, M)):
        d.rectangle([bx - 26, by - 4, bx + 26, by + 4], fill=(255, 255, 255))
        _bulb(d, bx, by)
    text(d, (680, 430), "병렬연결", size=26, bold=True, anchor="mm")
    text(d, (680, 468), "전류가 흐르는 길이 여러 갈래", size=18, fill=MUTED, anchor="mm")
    text(d, (680, 496), "전구 하나를 빼도 나머지는 켜진다", size=18, fill=MUTED, anchor="mm")
    return im


FIGURE_DRAWERS = {
    "photosynthesis": fig_photosynthesis,
    "leaf": fig_leaf_section,
    "stoma": fig_stoma,
    "daynight": fig_day_night,
    "atom": fig_atom,
    "wire_field": fig_wire_field,
    "circuit": fig_circuits,
}


# ---------------------------------------------------------------------------
# 학급 사진 · 클립 썸네일
# ---------------------------------------------------------------------------
def _gradient(w, h, top, bottom) -> Image.Image:
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        t = y / max(1, h - 1)
        col = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = col
    return im


def class_avatar() -> Image.Image:
    im = _gradient(256, 256, (120, 200, 120), (40, 130, 90))
    d = ImageDraw.Draw(im)
    d.ellipse([58, 40, 198, 180], fill=(255, 255, 255))
    d.polygon([(128, 60), (170, 110), (128, 165), (86, 110)], fill=(90, 170, 90))
    d.line([(128, 70), (128, 175)], fill=(255, 255, 255), width=5)
    text(d, (128, 218), "2-3 과학", size=30, bold=True, fill=(255, 255, 255), anchor="mm")
    return im


def thumb_leaf() -> Image.Image:
    im = _gradient(320, 320, (214, 240, 200), (150, 205, 130))
    d = ImageDraw.Draw(im)
    d.ellipse([70, 90, 250, 230], fill=(90, 165, 80), outline=(50, 110, 45), width=5)
    d.line([(85, 160), (240, 160)], fill=(220, 245, 210), width=5)
    for k in range(4):
        x = 110 + k * 32
        d.line([(x, 160), (x + 22, 120)], fill=(220, 245, 210), width=3)
        d.line([(x, 160), (x + 22, 200)], fill=(220, 245, 210), width=3)
    return im


def thumb_atom() -> Image.Image:
    im = _gradient(320, 320, (215, 228, 250), (150, 175, 230))
    d = ImageDraw.Draw(im)
    for box in ([60, 125, 260, 195], [125, 60, 195, 260]):
        d.ellipse(box, outline=(60, 90, 170), width=5)
    d.ellipse([140, 140, 180, 180], fill=(235, 110, 95))
    for (x, y) in [(60, 160), (260, 160), (160, 60), (160, 260)]:
        d.ellipse([x - 10, y - 10, x + 10, y + 10], fill=(60, 90, 200))
    return im


def thumb_magnet() -> Image.Image:
    im = _gradient(320, 320, (250, 225, 215), (235, 170, 150))
    d = ImageDraw.Draw(im)
    d.arc([80, 70, 240, 230], 180, 360, fill=(120, 120, 130), width=40)
    d.rectangle([80, 150, 120, 250], fill=(220, 70, 70))
    d.rectangle([200, 150, 240, 250], fill=(70, 110, 210))
    text(d, (100, 225), "N", size=26, bold=True, fill=(255, 255, 255), anchor="mm")
    text(d, (220, 225), "S", size=26, bold=True, fill=(255, 255, 255), anchor="mm")
    return im


# ---------------------------------------------------------------------------
# PDF (쪽 = 이미지 한 장)
# ---------------------------------------------------------------------------
PAGE_W, PAGE_H = 910, 1287  # A4 @ 110dpi
MARGIN = 70
BODY = 17
LINE = int(BODY * 1.75)
TEXT_W = PAGE_W - 2 * MARGIN


def _wrap(s: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    """띄어쓰기 단위로 줄을 바꾼다. 한 낱말이 폭을 넘으면 글자 단위로 자른다."""
    lines: list[str] = []
    cur = ""
    for word in s.split(" "):
        cand = f"{cur} {word}".strip()
        if f.getlength(cand) <= width:
            cur = cand
            continue
        if cur:
            lines.append(cur)
        cur = ""
        for ch in word:
            if f.getlength(cur + ch) > width:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
    if cur:
        lines.append(cur)
    return lines


def _short_caption(caption: str) -> str:
    return caption.split(". ")[0].rstrip(".")


def render_page(f: c.DemoFile, page: c.Page, page_no: int, fig_no: list[int],
                fig_boxes: dict[str, list[float]]) -> Image.Image:
    im = Image.new("RGB", (PAGE_W, PAGE_H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    text(d, (MARGIN, 38), f.header, size=14, fill=MUTED)
    d.line([(MARGIN, 62), (PAGE_W - MARGIN, 62)], fill=(215, 215, 215), width=1)
    y = 88
    if page.title:
        size = 40 if page_no == 1 and f.kind == "textbook" else 30
        if page_no == 1 and f.kind == "textbook":
            y = 300
        text(d, (MARGIN, y), page.title, size=size, bold=True)
        y += size + 30
    for para in page.lead:
        bold = para == "차례"
        fnt = font(BODY + (3 if bold else 0), bold)
        for ln in _wrap(para, fnt, TEXT_W):
            d.text((MARGIN, y), ln, font=fnt, fill=INK)
            y += LINE
        y += 14
    for ch in page.chunks:
        text(d, (MARGIN, y), ch.heading, size=21, bold=True, fill=(40, 110, 70))
        y += 38
        fnt = font(BODY)
        for ln in _wrap(ch.body, fnt, TEXT_W):
            d.text((MARGIN, y), ln, font=fnt, fill=INK)
            y += LINE
        y += 22
    for fk in page.figures:
        fig = c.FIGURES[fk]
        src = Image.open(ASSETS / fig.image).convert("RGB")
        w = 600
        h = int(src.height * w / src.width)
        x = (PAGE_W - w) // 2
        y += 6
        im.paste(src.resize((w, h), Image.Resampling.LANCZOS), (x, y))
        d.rectangle([x, y, x + w, y + h], outline=(220, 220, 220), width=1)
        # 파서가 주는 bbox처럼 쪽 크기로 나눈 값(0~1)을 남긴다.
        fig_boxes[fk] = [round(x / PAGE_W, 4), round(y / PAGE_H, 4),
                         round((x + w) / PAGE_W, 4), round((y + h) / PAGE_H, 4)]
        y += h + 12
        fig_no[0] += 1
        text(d, (PAGE_W // 2, y), f"그림 {fig_no[0]}. {_short_caption(fig.caption)}",
             size=15, fill=MUTED, anchor="ma")
        y += 44
    if y > PAGE_H - 70:
        raise SystemExit(f"{f.key} {page_no}쪽이 넘친다(y={y}) — content.py에서 쪽을 나눈다")
    text(d, (PAGE_W // 2, PAGE_H - 40), str(page_no), size=14, fill=MUTED, anchor="mm")
    return im


def write_pdf(pages: list[Image.Image], title: str) -> bytes:
    """이미지 쪽들로 PDF를 짓는다. 각 쪽은 64색 팔레트 + Flate 이미지 하나.

    Pillow의 PDF 저장은 RGB를 JPEG로 넣어 글자 가장자리가 번진다. 팔레트
    이미지는 글자가 또렷하면서도 JPEG보다 작다.
    """
    objs: list[bytes] = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    catalog = add(b"")  # 자리만 잡는다
    pages_obj = add(b"")
    page_ids: list[int] = []
    w_pt, h_pt = 595.28, 841.89
    for im in pages:
        pal_im = im.convert("P", palette=Image.Palette.ADAPTIVE, colors=64)
        palette = (pal_im.getpalette() or [])[: 64 * 3]
        palette += [0] * (64 * 3 - len(palette))
        data = zlib.compress(pal_im.tobytes(), 9)
        img = add(
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
            b"/ColorSpace [/Indexed /DeviceRGB 63 <%s>] /BitsPerComponent 8 "
            b"/Filter /FlateDecode /Length %d >>\nstream\n"
            % (im.width, im.height, bytes(palette).hex().encode(), len(data))
            + data + b"\nendstream"
        )
        stream = b"q %.2f 0 0 %.2f 0 0 cm /Im0 Do Q" % (w_pt, h_pt)
        cs = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page_ids.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] "
            b"/Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (pages_obj, w_pt, h_pt, img, cs)
        ))
    objs[catalog - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj
    objs[pages_obj - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % i for i in page_ids), len(page_ids))
    info = add(b"<< /Title <feff%s> /Producer (Nodi demo seed) >>"
               % title.encode("utf-16-be").hex().encode())

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
              % (len(objs) + 1, catalog, info, xref))
    return out.getvalue()


# ---------------------------------------------------------------------------
# 벡터 · 검색 결과
# ---------------------------------------------------------------------------
def _cos_dist(a: list[float], b: list[float]) -> float:
    # 둘 다 L2 정규화돼 있다(upstage.embed_texts) — 내적이 곧 코사인이다.
    return 1.0 - sum(x * y for x, y in zip(a, b, strict=True))


async def build_vectors(manifest: dict) -> None:
    from app.services import upstage

    specs = list(v.specs())
    print(f"passage 임베딩 {len(specs)}건 …")
    vecs = await upstage.embed_passages([s.text for s in specs])
    points = {
        s.point_id: {"c": s.collection, "h": v.text_hash(s.text), "v": v.encode(vec)}
        for s, vec in zip(specs, vecs, strict=True)
    }
    # 이후 계산은 **파일에 들어간 float16 값**으로 한다 — 시드가 올리는 것과 같은 수로.
    by_id = {pid: v.decode(p["v"]) for pid, p in points.items()}
    with gzip.open(v.VECTORS_FILE, "wt", encoding="utf-8", compresslevel=9) as fh:
        json.dump({
            "model": {"passage": "embedding-passage", "dimensions": v.DIM},
            "dim": v.DIM,
            "points": points,
        }, fh, separators=(",", ":"))
    print(f"  → {v.VECTORS_FILE.name} {v.VECTORS_FILE.stat().st_size / 1024:.0f}KB")

    # 학급 턴마다: 그 질문으로 실제 검색했으면 무엇이 몇 거리로 나왔을지.
    # 질의는 embedding-query로 만든다(비대칭 불변식). 결과는 manifest에만 남긴다.
    class_turns = [(s, t) for s in c.SESSIONS if s.space == "class" for t in s.turns]
    qvecs = await upstage.embed_texts([t.question for _, t in class_turns], kind="query")
    chunk_ids = [(f, seq) for f in c.FILES for seq, _ in enumerate(f.chunks())]
    turns: dict[str, dict] = {}
    for (s, t), q in zip(class_turns, qvecs, strict=True):
        ranked = sorted(
            ((_cos_dist(q, by_id[c.chunk_id(f.key, seq)]), f.key, seq) for f, seq in chunk_ids)
        )
        rag = [[fk, seq, round(dist, 4)] for dist, fk, seq in ranked[:5] if dist <= 0.60]
        figs = sorted((_cos_dist(q, by_id[fg.id]), k) for k, fg in c.FIGURES.items())
        clips = sorted(
            (_cos_dist(q, by_id[c.clip_id(vd.key, cl.key)]), f"{vd.key}:{cl.key}")
            for p in c.PACKAGES if p.enabled for vd in p.videos for cl in vd.clips
        )
        want_f = {k: round(dist, 4) for dist, k in figs if k in t.figures}
        want_c = {k: round(dist, 4) for dist, k in clips if k in t.clips}
        turns[f"{s.key}:{t.key}"] = {"rag": rag, "figures": want_f, "clips": want_c}
        print(f"· {s.key}:{t.key} {t.question}")
        print(f"    RAG {[(fk, seq, d_) for fk, seq, d_ in rag[:3]]}")
        print(f"    도판 top {figs[0][1]}({figs[0][0]:.3f}) 지정 {want_f}")
        print(f"    클립 top {clips[0][1]}({clips[0][0]:.3f}) 지정 {want_c}")
    manifest["turns"] = turns

    # 교차 연결 거리 — 워커와 같이 새 카드는 query, 과거 카드는 passage로 잰다.
    link_q = []
    for link in c.LINKS:
        s = c.SESSION_BY_KEY[link.from_ref[0]]
        t = next(x for x in s.turns if x.key == link.from_ref[1])
        title, _, body = c.card_from_answer(t.answer)
        link_q.append(v.concept_embed_text(title, body))
    lq = await upstage.embed_texts(link_q, kind="query")
    manifest["links"] = {}
    for link, q in zip(c.LINKS, lq, strict=True):
        to_id = c.concept_item_id(*link.to_ref)
        dist = round(_cos_dist(q, by_id[to_id]), 4)
        manifest["links"][link.key] = dist
        print(f"· 연결 {link.key}: 거리 {dist}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--embed", action="store_true", help="Upstage로 벡터도 만든다(키 필요)")
    args = ap.parse_args()
    ASSETS.mkdir(parents=True, exist_ok=True)

    for key, draw in FIGURE_DRAWERS.items():
        save_png(draw(), c.FIGURES[key].image)
    save_png(class_avatar(), "class_avatar.png")
    thumbs = (thumb_leaf, thumb_atom, thumb_magnet)
    for (name, _), draw in zip(c.CLIP_THUMBNAILS, thumbs, strict=True):
        save_png(draw(), name)
    print("그림 저장 완료")

    manifest = v.load_manifest()
    fig_boxes: dict[str, list[float]] = {}
    files_meta: dict[str, dict] = {}
    for f in c.FILES:
        fig_no = [0]
        pages = [render_page(f, p, i, fig_no, fig_boxes) for i, p in enumerate(f.pages, start=1)]
        pdf = write_pdf(pages, f.name)
        (ASSETS / f.storage_name).write_bytes(pdf)
        files_meta[f.key] = {"pages": len(pages), "bytes": len(pdf)}
        print(f"  {f.storage_name}: {len(pages)}쪽 {len(pdf) / 1024:.0f}KB")
    manifest["figure_bbox"] = fig_boxes
    manifest["files"] = files_meta

    if args.embed:
        asyncio.run(build_vectors(manifest))
    v.MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8", newline="\n",  # 윈도우에서도 LF — 저장소 규약(D97)
    )
    print(f"manifest 저장: {v.MANIFEST_FILE.name}")


if __name__ == "__main__":
    main()
