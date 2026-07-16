"""교과서 figure 위치기반 캡션 매칭·후보 랭킹(D86) — labs extract.py 이식.

labs에서 실PDF로 검증된 순수 로직을 Nodi 서비스 계층으로 1:1 이식한다.
좌표는 페이지 기준 0~1 정규화. 캡션 매칭 규칙(스펙):
  1) 같은 페이지 caption 중 수평 겹침>0, 수직거리<=0.05, 아래쪽 우선
  2) 폴백: 같은 조건의 paragraph
  3) 폴백: figure의 img alt 텍스트만
heading = figure보다 위 최근접 heading1, 없으면 페이지 첫 heading1.

실측 근거(labs): enhanced 파싱 모드는 caption 카테고리를 paragraph로 흡수하고
img alt를 항상 생성하지는 않으므로 위치기반 매칭이 필요하다. figure 요소의
텍스트(content)는 파서가 생성한 영어 설명이라 캡션 후보가 아니다 — 후보군에서
figure 카테고리를 제외한다.

DB·워커 계약: extract_figures가 반환하는 레코드 shape(키 목록)에 task4-6의
워커가 의존한다 — 키를 임의로 바꾸지 않는다. RAG 텍스트 청크는
text_from_elements가 figure 설명을 배제해 오염을 막는다.
"""
from __future__ import annotations

import base64
import html as html_lib
import logging
import math
import re
from collections import defaultdict

logger = logging.getLogger("nodi.figure_extract")

# 캡션 매칭 수직거리 상한(정규화 좌표). labs 실측값 — 변경 금지.
MAX_GAP = 0.05
# 후보군에서 제외할 카테고리(생성된 영어 설명이라 캡션 후보가 아님).
FIGURE_CATEGORIES = {"figure"}

_ALT_RE = re.compile(r"alt=[\"']([^\"']*)[\"']", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_DESC_RE = re.compile(r"<p\s+class=[\"']figure-description[\"']>(.*?)</p>", re.S)
_TYPE_RE = re.compile(r"<p\s+class=[\"']figure-type[\"']>(.*?)</p>", re.S)


def bbox(coords: list[dict]) -> tuple[float, float, float, float]:
    """정규화 4꼭짓점 → (x0, y0, x1, y1) 축정렬 경계상자."""
    xs = [p["x"] for p in coords]
    ys = [p["y"] for p in coords]
    return (min(xs), min(ys), max(xs), max(ys))


def _h_overlap(a, b) -> float:
    return min(a[2], b[2]) - max(a[0], b[0])


def _v_gap(a, b) -> float:
    if b[1] >= a[3]:
        return b[1] - a[3]
    if a[1] >= b[3]:
        return a[1] - b[3]
    return 0.0


def _is_below(fig, cand) -> bool:
    return cand[1] >= fig[3]


def match_description(fig_box, candidates, max_gap: float = MAX_GAP) -> str | None:
    """candidates: [(box, text)] -> 규칙에 맞는 최적 텍스트 (없으면 None).

    수평 겹침>0 · 수직거리<=max_gap 후보 중 아래쪽 우선(키
    `(0 if below else 1, gap)` 최솟값). 빈 텍스트는 후보에서 제외.
    """
    best_key, best_text = None, None
    for cand_box, text in candidates:
        if not text:
            continue
        if _h_overlap(fig_box, cand_box) <= 0:
            continue
        gap = _v_gap(fig_box, cand_box)
        if gap > max_gap:
            continue
        key = (0 if _is_below(fig_box, cand_box) else 1, gap)
        if best_key is None or key < best_key:
            best_key, best_text = key, text
    return best_text


def _center(b) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def rank_candidates(fig_box, candidates, k: int = 3) -> list[str]:
    """캡션 후보 top-k — bbox 중심점 간 유클리드 절대거리 순.

    판정(EXAONE)용이므로 방향(아래쪽 우선) 없이 물리적으로 가까운 태그를
    고른다. 빈 텍스트 제외, 중복 텍스트는 1회만.
    """
    fcx, fcy = _center(fig_box)
    scored: list[tuple[float, str]] = []
    for cand_box, text in candidates:
        if not text:
            continue
        ccx, ccy = _center(cand_box)
        scored.append((math.hypot(ccx - fcx, ccy - fcy), text))
    scored.sort(key=lambda s: s[0])
    out: list[str] = []
    for _, text in scored:
        if text not in out:
            out.append(text)
        if len(out) == k:
            break
    return out


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


def _nearest_heading(fig_box, headings) -> str:
    """figure 위쪽 최근접 heading1, 없으면 페이지 첫 heading1 (없으면 '')."""
    above = [(fig_box[1] - b[3], t) for b, t in headings if b[3] <= fig_box[1] + 0.01]
    if above:
        return min(above)[1]
    return headings[0][1] if headings else ""


def extract_figures(elements: list[dict], top_k: int = 3) -> list[dict]:
    """Upstage 파싱 elements → figure 레코드 목록(위치기반 캡션 매칭).

    elements는 전역 page/id 보정이 끝난 상태로 들어온다(task4-2
    parse_document_full 공급). labs main()의 페이지별 처리 로직을 함수화 —
    페이지별로 그룹핑해 같은 페이지 후보군(caption·paragraph·heading1·전체)만
    매칭에 쓴다(다른 페이지 텍스트는 후보가 아니다).

    figure 카테고리 + coordinates + base64_encoding을 모두 갖춘 요소만
    처리한다. base64가 없으면 스킵하고 warning 로그를 남긴다. 반환 레코드
    shape(키 목록)은 워커·DB 계약이므로 임의 변경 금지.
    """
    by_page: dict[int, list[dict]] = defaultdict(list)
    for el in elements:
        by_page[el.get("page", 1)].append(el)

    records: list[dict] = []
    for page, els in sorted(by_page.items()):
        def cands(categories=None):
            """categories=None이면 figure를 제외한 모든 카테고리
            (figure의 텍스트는 생성된 영어 설명이라 캡션 후보가 아님)."""
            return [
                (bbox(el["coordinates"]), element_text(el))
                for el in els
                if el.get("coordinates")
                and el.get("category") not in FIGURE_CATEGORIES
                and (categories is None or el.get("category") in categories)
            ]

        captions = cands({"caption"})
        paragraphs = cands({"paragraph"})
        headings = cands({"heading1"})
        all_texts = cands()

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
            caption = match_description(fig_box, captions)
            match_kind = "caption"
            if caption is None:
                caption = match_description(fig_box, paragraphs)
                match_kind = "paragraph" if caption else "alt-only"
            heading = _nearest_heading(fig_box, headings)
            candidates = rank_candidates(fig_box, all_texts, k=top_k)

            embed_text = " ".join(
                t for t in [caption or "", alt, heading] if t
            ).strip()[:8000]
            records.append({
                "page": page,
                "element_id": el["id"],
                "bbox": list(fig_box),
                "caption": caption or "",
                "alt": alt,
                "description": description,
                "figure_type": fig_type,
                "heading": heading,
                "candidates": candidates,
                "embed_text": embed_text,
                "match_kind": match_kind,
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
