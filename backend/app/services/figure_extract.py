"""교과서 figure 추출(D86·D121) — labs extract.py 이식.

좌표는 페이지 기준 0~1 정규화. D121(사용자 결정 2026-07-30): 캡션은 비전
생성(figure_caption)이 단독 확정한다 — D93의 절대거리 top-K 후보(candidates)와
D103의 후보 선택 경로는 제거됐다. 여기서 뽑는 것은 생성 프롬프트의 입력이다:

  - parsed 캡션(nearest_caption): 파서가 caption/footnote로 **라벨한** 요소 중
    figure에 가까운 것(정규화 거리 0.25 이내). 확정값이 아니라 생성 프롬프트의
    힌트(고유명사 보존용)로만 쓰인다.
  - heading(figure 위쪽 최근접 heading1, 없으면 페이지 첫 heading1): 표시·디버그용.
  - page_texts(페이지 본문): 생성 프롬프트의 컨텍스트(D118).

실측 근거(labs): 파싱이 caption 카테고리를 paragraph로 흡수하는 교과서가 있고
img alt를 항상 생성하지도 않는다 — parsed 힌트는 있을 때만 실린다. figure
요소의 텍스트(content)는 파서가 생성한 영어 설명이라 힌트가 아니다.

DB·워커 계약: extract_figures가 반환하는 레코드 shape(키 목록)에 워커가
의존한다 — 키를 임의로 바꾸지 않는다. RAG 텍스트 청크는 text_from_elements가
figure 설명을 배제해 오염을 막는다.
"""
from __future__ import annotations

import base64
import html as html_lib
import logging
import math
import re
from collections import defaultdict

logger = logging.getLogger("nodi.figure_extract")

# 후보군에서 제외할 카테고리(생성된 영어 설명이라 캡션 후보가 아님).
FIGURE_CATEGORIES = {"figure"}

# D103: 파서가 **명시적으로 캡션이라고 라벨한** 카테고리. 이 라벨이 붙은 요소는
# 추측이 아니라 파서의 판단이므로, 비전 판정 없이 그대로 캡션으로 쓴다.
# (labs 실측에서 caption이 paragraph로 흡수되는 교과서가 있었는데, 그건 "라벨이
#  안 붙는" 경우다 — 붙은 경우까지 버릴 이유는 없다. 안 붙으면 아래 판정 경로로
#  넘어가고, 판정도 없으면 그 figure는 캡션 없이 실패한다. 추측은 하지 않는다.)
CAPTION_CATEGORIES = {"caption", "footnote"}

# 캡션으로 인정할 최대 중심간 거리(페이지 정규화 좌표, 0~1).
# 페이지 반대편에 있는 캡션 라벨은 이 figure의 것이 아니다. 2단 편집에서 옆
# 단(段)까지 잡히지 않을 정도로 보수적으로 잡았다.
MAX_CAPTION_DISTANCE = 0.25

_ALT_RE = re.compile(r"alt=[\"']([^\"']*)[\"']", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_DESC_RE = re.compile(r"<p\s+class=[\"']figure-description[\"']>(.*?)</p>", re.S)
_TYPE_RE = re.compile(r"<p\s+class=[\"']figure-type[\"']>(.*?)</p>", re.S)


def bbox(coords: list[dict]) -> tuple[float, float, float, float]:
    """정규화 4꼭짓점 → (x0, y0, x1, y1) 축정렬 경계상자."""
    xs = [p["x"] for p in coords]
    ys = [p["y"] for p in coords]
    return (min(xs), min(ys), max(xs), max(ys))


def _center(b) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def figure_description(html: str | None) -> str:
    """enhanced 모드 figcaption의 figure-description 텍스트 (없으면 '')."""
    m = _DESC_RE.search(html or "")
    return html_lib.unescape(m.group(1)).strip() if m else ""


def figure_type(html: str | None) -> str:
    """enhanced 모드 figcaption의 figure-type 태그 목록 (없으면 '')."""
    m = _TYPE_RE.search(html or "")
    return html_lib.unescape(m.group(1)).strip() if m else ""


def alt_text(html: str | None) -> str:
    m = _ALT_RE.search(html or "")
    return (m.group(1) if m else "").strip()


def element_text(el: dict) -> str:
    """후보 매칭용 요소 텍스트 — content.text 우선, 없으면 html 태그 제거."""
    c = el.get("content") or {}
    text = (c.get("text") or "").strip()
    if text:
        return text
    return _TAG_RE.sub(" ", c.get("html") or "").strip()


def nearest_caption(fig_box, captions) -> str:
    """파서가 캡션으로 라벨한 요소 중 가장 가까운 것 (없거나 멀면 '') — D103.

    captions는 [(bbox, text)] — CAPTION_CATEGORIES 요소만 걸러 넘긴다.
    MAX_CAPTION_DISTANCE를 넘으면 이 figure의 캡션으로 보지 않는다. 거리만 보고
    방향(아래쪽 우선)은 보지 않는다 — 교과서마다 캡션 위치가 달라 방향 규칙이
    오히려 틀렸다는 것이 D93의 결론이었다.
    """
    fcx, fcy = _center(fig_box)
    best: tuple[float, str] | None = None
    for cap_box, text in captions:
        if not text:
            continue
        ccx, ccy = _center(cap_box)
        d = math.hypot(ccx - fcx, ccy - fcy)
        if d > MAX_CAPTION_DISTANCE:
            continue
        if best is None or d < best[0]:
            best = (d, text)
    return best[1] if best else ""


def _nearest_heading(fig_box, headings) -> str:
    """figure 위쪽 최근접 heading1, 없으면 페이지 첫 heading1 (없으면 '')."""
    above = [(fig_box[1] - b[3], t) for b, t in headings if b[3] <= fig_box[1] + 0.01]
    if above:
        return min(above)[1]
    return headings[0][1] if headings else ""


def extract_figures(elements: list[dict]) -> list[dict]:
    """Upstage 파싱 elements → figure 레코드 목록(D121).

    elements는 전역 page/id 보정이 끝난 상태로 들어온다(task4-2
    parse_document_full 공급). 페이지별로 그룹핑해 같은 페이지의 라벨된
    캡션(caption/footnote)만 parsed 힌트 후보로 쓴다. 캡션은 여기서 확정하지
    않는다 — 비전 생성(figure_caption)이 워커에서 확정한다(D121).

    figure 카테고리 + coordinates + base64_encoding을 모두 갖춘 요소만
    처리한다. base64가 없으면 스킵하고 warning 로그를 남긴다. 반환 레코드
    shape(키 목록)은 워커·DB 계약이므로 임의 변경 금지.
    """
    by_page: dict[int, list[dict]] = defaultdict(list)
    for el in elements:
        by_page[el.get("page", 1)].append(el)

    records: list[dict] = []
    for page, els in sorted(by_page.items()):
        # els를 기본 인자로 묶어 현재 페이지 요소에 고정한다. 클로저로 두면
        # 늦은 바인딩이라 호출 시점의 마지막 페이지를 보게 된다 — 지금은 같은
        # 반복 안에서만 호출해 문제가 없지만, 나중에 이 함수를 밖으로 넘기는
        # 순간 조용히 틀린 후보를 만든다.
        def cands(categories=None, els=els):
            """categories=None이면 figure를 제외한 모든 카테고리
            (figure의 텍스트는 생성된 영어 설명이라 캡션 후보가 아님)."""
            return [
                (bbox(el["coordinates"]), element_text(el))
                for el in els
                if el.get("coordinates")
                and el.get("category") not in FIGURE_CATEGORIES
                and (categories is None or el.get("category") in categories)
            ]

        headings = cands({"heading1"})
        # 파서가 캡션이라고 라벨한 요소만 따로 모은다(추측 아님) — 생성 힌트용.
        labeled_captions = cands(CAPTION_CATEGORIES)

        for el in els:
            if el.get("category") not in FIGURE_CATEGORIES:
                continue
            if not el.get("coordinates"):
                continue
            b64 = el.get("base64_encoding")
            if not b64:
                logger.warning("figure base64 없음 — 스킵: p%s e%s", page, el.get("id"))
                continue
            fig_box = bbox(el["coordinates"])
            raw = base64.b64decode(b64)
            ext = "jpg" if raw[:2] == b"\xff\xd8" else "png"

            fig_html = (el.get("content") or {}).get("html")
            alt = alt_text(fig_html)
            description = figure_description(fig_html)
            fig_type = figure_type(fig_html)
            heading = _nearest_heading(fig_box, headings)

            # D121: 파서가 캡션으로 라벨한 요소가 가까이 있으면 parsed 힌트로
            # 싣는다 — 확정값이 아니다(캡션 확정은 워커의 비전 생성이 전담).
            # embed_text는 빈 값으로 두고 생성이 채운다.
            parsed = nearest_caption(fig_box, labeled_captions)

            records.append({
                "page": page,
                "element_id": el["id"],
                "bbox": list(fig_box),
                "caption": parsed,  # 생성 프롬프트 힌트(고유명사 보존용)
                "alt": alt,
                "description": description,
                "figure_type": fig_type,
                "heading": heading,
                "embed_text": "",
                "match_kind": "",
                "image_bytes": raw,
                "ext": ext,
            })
    return records


def _chunk_text(el: dict) -> str:
    """청킹용 요소 텍스트 — content.markdown 우선, 없으면 element_text 폴백
    (text → html 태그 제거)."""
    md = ((el.get("content") or {}).get("markdown") or "").strip()
    return md or element_text(el)


def text_from_elements(elements: list[dict]) -> str:
    """텍스트 청킹 입력 — figure 카테고리를 제외한 요소 텍스트를 순서대로 이어붙임.

    요소별 텍스트는 content.markdown 우선, 없으면 content.text, 없으면 html
    태그 제거 폴백. figure content는 enhanced가 생성한 영어 설명이라 RAG 텍스트
    청크를 오염시키므로 배제한다(D86). 결과가 빈 문자열이면 호출부가 전체
    markdown으로 폴백한다(이 계약을 유지한다).
    """
    parts = [
        _chunk_text(el)
        for el in elements
        if el.get("category") not in FIGURE_CATEGORIES
    ]
    return "\n\n".join(p for p in parts if p)


def page_texts(elements: list[dict], max_chars: int = 4000) -> dict[int, str]:
    """페이지별 본문 텍스트(D118 캡션 비전 생성 컨텍스트) — {page: text}.

    figure 카테고리를 제외한 요소의 element_text를 페이지별로 등장 순서대로
    이어붙이고, `" ".join(text.split())`로 공백(탭·개행 포함)을 단일 공백으로
    정규화한 뒤 max_chars로 절단한다. 탭은 추론형 비전 모델의 reasoning 폭주를
    유발한다(figure_judge `_clean` 실측 근거). 텍스트가 없는 페이지(그림만 있는
    페이지)는 키 자체가 없다 — 호출부(_fanout_figures)가 '' 폴백한다.

    **extract_figures 레코드 shape은 건드리지 않는다**(계약 고정) — page_text는
    _fanout_figures가 이 결과에서 r["page"]로 얻어 rows에만 싣는다.
    """
    by_page: dict[int, list[str]] = defaultdict(list)
    for el in elements:
        if el.get("category") in FIGURE_CATEGORIES:
            continue
        text = element_text(el)
        if text:
            by_page[el.get("page", 1)].append(text)
    return {
        page: " ".join(" ".join(parts).split())[:max_chars]
        for page, parts in by_page.items()
    }
