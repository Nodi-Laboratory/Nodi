"""figure_extract 이식 검증(D86) — labs 위치기반 캡션 매칭·후보 랭킹.

labs `extract.py`에서 실PDF로 검증된 규칙을 1:1 이식한 순수 로직이므로,
수치·우선순위(수직거리 0.05, 아래쪽 우선, 8000자 절단, 매직바이트 jpg/png)를
합성 elements로 고정한다. 외부 호출(Upstage·Qdrant·DB) 없음.
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


# ── match_description ──────────────────────────────────────────────────
def test_match_prefers_below_even_with_larger_gap():
    # 아래쪽 우선: 위 0.02 vs 아래 0.04 → 아래 선택(방향이 거리보다 우선).
    fig = (0.1, 0.40, 0.5, 0.60)
    above = ((0.1, 0.36, 0.5, 0.38), "above")  # gap 0.02, 위
    below = ((0.1, 0.64, 0.5, 0.66), "below")  # gap 0.04, 아래
    assert F.match_description(fig, [above, below]) == "below"


def test_match_rejects_gap_over_max():
    fig = (0.1, 0.40, 0.5, 0.60)
    far = ((0.1, 0.66, 0.5, 0.68), "far")  # gap 0.06 > 0.05
    assert F.match_description(fig, [far]) is None


def test_match_rejects_no_horizontal_overlap():
    fig = (0.1, 0.40, 0.5, 0.60)
    side = ((0.6, 0.62, 0.9, 0.64), "side")  # 수평 겹침 0
    assert F.match_description(fig, [side]) is None


def test_match_skips_empty_text():
    fig = (0.1, 0.40, 0.5, 0.60)
    empty = ((0.1, 0.62, 0.5, 0.64), "")
    assert F.match_description(fig, [empty]) is None


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
    assert r["caption"] == "그림 1 고구려의 전성기"
    assert r["alt"] == "고구려 지도"
    assert r["description"] == "A map of Goguryeo"
    assert r["figure_type"] == "map"
    assert r["heading"] == "1. 고대 국가"
    assert r["candidates"] == ["그림 1 고구려의 전성기", "1. 고대 국가"]
    assert r["embed_text"] == "그림 1 고구려의 전성기 고구려 지도 1. 고대 국가"
    assert r["match_kind"] == "caption"
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


def test_extract_figures_fallback_to_paragraph():
    # caption 후보 없음 → paragraph 폴백.
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    para = _text_el(2, "paragraph", (0.1, 0.62, 0.5, 0.64), "본문 문단")
    recs = F.extract_figures([fig, para])
    assert recs[0]["caption"] == "본문 문단"
    assert recs[0]["match_kind"] == "paragraph"


def test_extract_figures_fallback_to_alt_only():
    # caption·paragraph 모두 없음 → alt-only(caption "").
    fig = _fig_el(
        1,
        (0.1, 0.40, 0.5, 0.60),
        b64=base64.b64encode(_JPG).decode(),
        html='<img alt="지도만 있음">',
    )
    recs = F.extract_figures([fig])
    assert recs[0]["caption"] == ""
    assert recs[0]["match_kind"] == "alt-only"
    assert recs[0]["alt"] == "지도만 있음"


def test_extract_figures_embed_text_truncated_to_8000():
    long_caption = "가" * 9000
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    cap = _text_el(2, "caption", (0.1, 0.62, 0.5, 0.64), long_caption)
    recs = F.extract_figures([fig, cap])
    assert len(recs[0]["embed_text"]) == 8000


def test_extract_figures_caption_scoped_to_same_page():
    # 다른 페이지 caption은 매칭 후보가 아니다(페이지별 그룹핑).
    fig = _fig_el(
        1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode(), page=1,
    )
    other = _text_el(2, "caption", (0.1, 0.62, 0.5, 0.64), "다른 페이지", page=2)
    recs = F.extract_figures([fig, other])
    assert recs[0]["match_kind"] == "alt-only"
    assert recs[0]["caption"] == ""


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
