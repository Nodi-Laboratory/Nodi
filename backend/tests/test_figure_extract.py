"""figure_extract 검증(D86·D93) — 절대거리 top-K 후보 랭킹.

D93(사용자 결정 2026-07-18): 위치기반 캡션 매칭(수평겹침·수직거리·아래쪽 우선)
제거 — 후보는 bbox 중심 유클리드 절대거리 top-K만, 캡션 확정은 비전 판정
(figure_judge)이 전담한다. caption·embed_text·match_kind는 추출 시점 빈 값.
매직바이트 jpg/png·heading 규칙은 유지. 외부 호출(Upstage·Qdrant·DB) 없음.
"""

import base64

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
    # D121: 파서 라벨 캡션은 생성 프롬프트 힌트로만 실린다 — 확정값이 아니라
    # embed_text·match_kind는 빈 값(캡션 확정은 워커의 비전 생성이 전담).
    assert r["caption"] == "그림 1 고구려의 전성기"
    assert r["embed_text"] == ""
    assert r["match_kind"] == ""
    assert r["alt"] == "고구려 지도"
    assert r["description"] == "A map of Goguryeo"
    assert r["figure_type"] == "map"
    assert r["heading"] == "1. 고대 국가"
    assert r["image_bytes"] == _JPG
    assert r["ext"] == "jpg"
    # 계약 키 전체 존재(워커가 이 shape에 의존).
    assert set(r) == {
        "page", "element_id", "bbox", "caption", "alt", "description",
        "figure_type", "heading", "embed_text", "match_kind",
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


# --- 파서 라벨 캡션(생성 프롬프트 힌트, D121) -----------------------------------------------------


def test_parsed_caption_prefers_labeled_over_nearer_paragraph():
    """더 가까운 paragraph가 있어도 힌트는 **라벨된** 요소에서 고른다.

    거리만 보면 paragraph가 이기지만, 그건 본문일 수 있다. 파서가 caption이라고
    라벨한 것만 힌트로 싣는다(추측 금지 — D103에서 확립, D121에서도 유지).
    """
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    near_para = _text_el(2, "paragraph", (0.1, 0.61, 0.5, 0.62), "본문 문장")
    far_caption = _text_el(3, "caption", (0.1, 0.66, 0.5, 0.68), "그림 2 첨성대")
    recs = F.extract_figures([fig, near_para, far_caption])
    assert recs[0]["caption"] == "그림 2 첨성대"


def test_parsed_caption_accepts_footnote_category():
    """footnote로 라벨된 요소도 캡션으로 인정한다(교과서마다 라벨이 갈린다)."""
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    note = _text_el(2, "footnote", (0.1, 0.62, 0.5, 0.64), "▲ 무구정광대다라니경")
    recs = F.extract_figures([fig, note])
    assert recs[0]["caption"] == "▲ 무구정광대다라니경"


def test_parsed_caption_ignored_when_too_far():
    """페이지 반대편의 캡션 라벨은 이 figure의 것이 아니다 — 추측하지 않는다."""
    fig = _fig_el(1, (0.05, 0.05, 0.25, 0.20), b64=base64.b64encode(_JPG).decode())
    far = _text_el(2, "caption", (0.75, 0.85, 0.95, 0.92), "다른 그림의 캡션")
    recs = F.extract_figures([fig, far])
    assert recs[0]["caption"] == ""


def test_parsed_caption_absent_leaves_empty_hint():
    """라벨이 없으면 힌트도 빈 값 — 생성이 이미지·페이지 본문만으로 캡션을 만든다."""
    fig = _fig_el(1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode())
    para = _text_el(2, "paragraph", (0.1, 0.62, 0.5, 0.64), "캡션일 수도 아닐 수도")
    recs = F.extract_figures([fig, para])
    assert recs[0]["caption"] == ""
    assert recs[0]["embed_text"] == ""
    assert recs[0]["match_kind"] == ""


def test_parsed_caption_scoped_to_same_page():
    """다른 페이지의 캡션 라벨은 쓰지 않는다."""
    fig = _fig_el(
        1, (0.1, 0.40, 0.5, 0.60), b64=base64.b64encode(_JPG).decode(), page=1,
    )
    other = _text_el(2, "caption", (0.1, 0.62, 0.5, 0.64), "2페이지 캡션", page=2)
    recs = F.extract_figures([fig, other])
    assert recs[0]["caption"] == ""


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


# ── page_texts (D118) ───────────────────────────────────────────────────
def test_page_texts_groups_by_page_and_excludes_figures():
    """페이지별로 figure 제외 요소 텍스트를 순서대로 이어붙인다."""
    els = [
        _text_el(1, "heading1", (0.1, 0.1, 0.5, 0.15), "제목 A", page=1),
        _fig_el(2, (0.1, 0.4, 0.5, 0.6),
                b64=base64.b64encode(_JPG).decode(), page=1),  # figure 제외
        _text_el(3, "paragraph", (0.1, 0.2, 0.5, 0.3), "본문 A", page=1),
        _text_el(4, "paragraph", (0.1, 0.1, 0.5, 0.2), "본문 B", page=2),
    ]
    out = F.page_texts(els)
    assert out[1] == "제목 A 본문 A"  # figure 텍스트 미포함, 순서 보존
    assert out[2] == "본문 B"


def test_page_texts_normalizes_whitespace_and_tabs():
    """탭·개행·연속 공백은 단일 공백으로 정규화한다(비전 reasoning 폭주 방지)."""
    els = [_text_el(1, "paragraph", (0, 0, 1, 1), "탭\t사이\n\n여러   줄", page=1)]
    assert F.page_texts(els)[1] == "탭 사이 여러 줄"


def test_page_texts_truncates_to_max_chars():
    els = [_text_el(1, "paragraph", (0, 0, 1, 1), "가" * 100, page=1)]
    assert F.page_texts(els, max_chars=10)[1] == "가" * 10


def test_page_texts_empty_for_figure_only_page():
    """figure만 있는 페이지는 결과에 키가 없다(_fanout_figures가 '' 폴백)."""
    els = [_fig_el(1, (0.1, 0.4, 0.5, 0.6),
                   b64=base64.b64encode(_JPG).decode(), page=1)]
    assert F.page_texts(els) == {}
