"""figure_extract 검증(D86·D93) — 절대거리 top-K 후보 랭킹.

D93(사용자 결정 2026-07-18): 위치기반 캡션 매칭(수평겹침·수직거리·아래쪽 우선)
제거 — 후보는 bbox 중심 유클리드 절대거리 top-K만, 캡션 확정은 비전 판정
(figure_judge)이 전담한다. caption·embed_text·match_kind는 추출 시점 빈 값.
매직바이트 jpg/png·heading 규칙은 유지. 외부 호출(Upstage·Qdrant·DB) 없음.
"""

import base64

import pytest

from app.services import figure_extract as F


# ── 헬퍼 ───────────────────────────────────────────────────────────────
def _coords(x0, y0, x1, y1):
    """(x0,y0,x1,y1) → 정규화 4꼭짓점 dict 목록(Upstage coordinates 형식)."""
    return [
        {"x": x0, "y": y0},
        {"x": x1, "y": y0},
        {"x": x1, "y": y1},
        {"x": x0, "y": y1},
    ]


def _text_el(el_id, category, box, text, page=1):
    x0, y0, x1, y1 = box
    return {
        "id": el_id,
        "page": page,
        "category": category,
        "coordinates": _coords(x0, y0, x1, y1),
        "content": {"text": text},
    }


def _fig_el(el_id, box, *, b64=None, html=None, page=1):
    x0, y0, x1, y1 = box
    el = {
        "id": el_id,
        "page": page,
        "category": "figure",
        "coordinates": _coords(x0, y0, x1, y1),
        "content": {"html": html},
    }
    if b64 is not None:
        el["base64_encoding"] = b64
    return el


_JPG = b"\xff\xd8\xff\xe0\x00\x10JFIF"  # 매직바이트 \xff\xd8 → jpg
_PNG = b"\x89PNG\r\n\x1a\n\x00\x00"  # 그 외 → png


# ── bbox ───────────────────────────────────────────────────────────────
def test_bbox_from_corners():
    coords = _coords(0.2, 0.3, 0.8, 0.7)
    assert F.bbox(coords) == (0.2, 0.3, 0.8, 0.7)


# ── rank_candidates ────────────────────────────────────────────────────
def test_rank_by_center_distance_dedup_and_k():
    fig = (0.4, 0.4, 0.6, 0.6)  # 중심 (0.5, 0.5)
    near = ((0.4, 0.6, 0.6, 0.65), "near")  # 중심 (0.5, 0.625) 거리 0.125
    mid = ((0.4, 0.7, 0.6, 0.75), "mid")  # 중심 (0.5, 0.725) 거리 0.225
    far = ((0.4, 0.85, 0.6, 0.9), "far")  # 중심 (0.5, 0.875) 거리 0.375
    dup = ((0.41, 0.6, 0.61, 0.65), "near")  # 동일 텍스트(중복) — 1회만
    empty = ((0.4, 0.55, 0.6, 0.58), "")  # 빈 텍스트 제외
    out = F.rank_candidates(fig, [far, mid, near, dup, empty], k=2)
    assert out == ["near", "mid"]  # 거리순 + k 절단 + 중복 1회 + 빈 제외


# ── figure_description / figure_type ───────────────────────────────────
def test_figure_description_multiline_and_entity():
    html = (
        '<figcaption><p class="figure-description">line one\n'
        'line two &amp; more</p></figcaption>'
    )
    assert F.figure_description(html) == "line one\nline two & more"


def test_figure_type_extract_and_missing():
    html = '<p class="figure-type">map&#44; chart</p>'
    assert F.figure_type(html) == "map, chart"
    assert F.figure_type('<p class="other">x</p>') == ""
    assert F.figure_type(None) == ""


def test_alt_text():
    assert F.alt_text('<img alt="고구려 지도" src="x">') == "고구려 지도"
    assert F.alt_text(None) == ""


# ── _nearest_heading ───────────────────────────────────────────────────
def test_nearest_heading_picks_closest_above():
    fig = (0.1, 0.50, 0.5, 0.70)
    far_above = ((0.1, 0.40, 0.5, 0.45), "far")  # bottom 0.45, dist 0.05
    near_above = ((0.1, 0.46, 0.5, 0.48), "near")  # bottom 0.48, dist 0.02
    below = ((0.1, 0.72, 0.5, 0.80), "below")  # bottom 0.80 > 0.51 → 제외
    assert F._nearest_heading(fig, [far_above, near_above, below]) == "near"


def test_nearest_heading_falls_back_to_page_first():
    fig = (0.1, 0.10, 0.5, 0.20)
    h1 = ((0.1, 0.30, 0.5, 0.35), "first")  # 모두 아래 → 위쪽 없음
    h2 = ((0.1, 0.50, 0.5, 0.55), "second")
    assert F._nearest_heading(fig, [h1, h2]) == "first"
    assert F._nearest_heading(fig, []) == ""


# ── extract_figures ────────────────────────────────────────────────────
def test_extract_figures_full_record():
    fig = _fig_el(
        10,
        (0.1, 0.40, 0.5, 0.60),
        b64=base64.b64encode(_JPG).decode(),
        html=(
            '<img alt="고구려 지도">'
            '<figcaption><p class="figure-description">A map of Goguryeo</p>'
            '<p class="figure-type">map</p></figcaption>'
        ),
    )
    caption = _text_el(11, "caption", (0.1, 0.62, 0.5, 0.64), "그림 1 고구려의 전성기")
    heading = _text_el(12, "heading1", (0.1, 0.30, 0.5, 0.34), "1. 고대 국가")

    recs = F.extract_figures([fig, caption, heading])
    assert len(recs) == 1
    r = recs[0]
    assert r["page"] == 1
    assert r["element_id"] == 10
    assert r["bbox"] == [0.1, 0.40, 0.5, 0.60]
    # D93: caption·embed_text·match_kind는 판정 전이므로 빈 값 — 확정은 워커.
    assert r["caption"] == ""
    assert r["embed_text"] == ""
    assert r["match_kind"] == ""
    assert r["alt"] == "고구려 지도"
    assert r["description"] == "A map of Goguryeo"
    assert r["figure_type"] == "map"
    assert r["heading"] == "1. 고대 국가"
    # 후보는 절대거리 순(D93) — 캡션(0.13) < 헤딩(0.18).
    assert r["candidates"] == ["그림 1 고구려의 전성기", "1. 고대 국가"]
    assert r["image_bytes"] == _JPG
    assert r["ext"] == "jpg"
    # 계약 키 전체 존재(task4-6이 이 shape에 의존).
    assert set(r) == {
        "page", "element_id", "bbox", "caption", "alt", "description",
        "figure_type", "heading", "candidates", "embed_text", "match_kind",
        "image_bytes", "ext",
    }


def test_extract_figures_png_magic_byte():
    fig = _fig_el(1, (0.1, 0.4, 0.5, 0.6), b64=base64.b64encode(_PNG).decode())
    recs = F.extract_figures([fig])
    assert recs[0]["ext"] == "png"
    assert recs[0]["image_bytes"] == _PNG


def test_extract_figures_skips_missing_base64(caplog):
    fig = _fig_el(7, (0.1, 0.4, 0.5, 0.6), b64=None)  # base64 없음
    with caplog.at_level("WARNING", logger="nodi.figure_extract"):
        recs = F.extract_figures([fig])
    assert recs == []
    assert any("base64" in m for m in caplog.messages)


def test_extract_figures_candidates_by_absolute_distance():
    """D93: 후보는 방향(아래쪽) 우선 없이 bbox 중심 절대거리 순이다."""
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    # 위쪽이 더 가깝다: above 중심거리 0.13 < below 중심거리 0.17.
    above = _text_el(2, "paragraph", (0.1, 0.34, 0.5, 0.40), "위 텍스트")
    below = _text_el(3, "caption", (0.1, 0.64, 0.5, 0.70), "아래 캡션")
    recs = F.extract_figures([fig, above, below])
    assert recs[0]["candidates"] == ["위 텍스트", "아래 캡션"]


def test_extract_figures_no_candidates_leaves_empty():
    """같은 페이지에 텍스트가 없으면 candidates는 빈 목록(판정이 -1 처리)."""
    fig = _fig_el(
        1,
        (0.1, 0.40, 0.5, 0.60),
        b64=base64.b64encode(_JPG).decode(),
        html='<img alt="지도만 있음">',
    )
    recs = F.extract_figures([fig])
    assert recs[0]["candidates"] == []
    assert recs[0]["caption"] == ""
    assert recs[0]["match_kind"] == ""
    assert recs[0]["alt"] == "지도만 있음"


def test_extract_figures_candidates_scoped_to_same_page():
    # 다른 페이지 텍스트는 후보가 아니다(페이지별 그룹핑).
    fig = _fig_el(
        1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode(), page=1,
    )
    other = _text_el(2, "caption", (0.1, 0.62, 0.5, 0.64), "다른 페이지", page=2)
    recs = F.extract_figures([fig, other])
    assert recs[0]["candidates"] == []


def test_extract_figures_top_k_passthrough():
    fig = _fig_el(1, (0.4, 0.4, 0.6, 0.6), b64=base64.b64encode(_JPG).decode())
    c1 = _text_el(2, "caption", (0.4, 0.62, 0.6, 0.64), "c1")
    c2 = _text_el(3, "paragraph", (0.4, 0.70, 0.6, 0.72), "c2")
    c3 = _text_el(4, "heading1", (0.4, 0.80, 0.6, 0.82), "c3")
    recs = F.extract_figures([fig, c1, c2, c3], top_k=1)
    assert len(recs[0]["candidates"]) == 1


# ── text_from_elements ─────────────────────────────────────────────────
def test_text_from_elements_excludes_figures_and_orders():
    els = [
        {"category": "heading1", "content": {"markdown": "# 제목"}},
        {"category": "figure", "content": {"markdown": "생성된 영어 설명"}},  # 제외
        {"category": "paragraph", "content": {"text": "본문 텍스트"}},
    ]
    assert F.text_from_elements(els) == "# 제목\n\n본문 텍스트"


def test_text_from_elements_fallback_chain():
    els = [
        {"category": "paragraph", "content": {"markdown": "MD 우선"}},
        {"category": "paragraph", "content": {"text": "text 폴백"}},
        {"category": "paragraph", "content": {"html": "<b>html</b> 폴백"}},
    ]
    assert F.text_from_elements(els) == "MD 우선\n\ntext 폴백\n\nhtml  폴백"


def test_text_from_elements_empty_input():
    assert F.text_from_elements([]) == ""
    assert F.text_from_elements([{"category": "figure", "content": {"markdown": "x"}}]) == ""
