"""D86/D78 — 교과서 구조화 파싱 `parse_document_full` 테스트 (실제 Upstage 호출 없음).

1회 공유 파싱(D92 표준 모드): 한 응답에서 텍스트(markdown)와 figure(elements)를
함께 얻는다(페이지당 과금 1회). PDF는 조각당 ≤48MB·≤100페이지로 사전
분할해 전 조각이 sync 단일 요청만 타고, 조각 elements의 page(전역 1-base)·id를
결정론적으로 오프셋 보정한다.
"""

import io
import json
from types import SimpleNamespace

import httpx
from pypdf import PdfWriter

from app.services import upstage as U


def _make_pdf(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


# --- _parse_form ------------------------------------------------------------

def test_parse_form_default_equals_figures_false():
    """figures 미지정/False는 class_material 경로 보존 — 기존 dict와 완전 동일."""
    assert U._parse_form() == U._parse_form(figures=False)
    assert U._parse_form(figures=False) == {
        "model": U.settings.upstage_document_parse_model,
        "output_formats": json.dumps(["markdown"]),
        "ocr": "auto",
    }


def test_parse_form_figures_true_standard_mode():
    """figures=True: 표준 모드(D92 — mode 미지정) + coordinates + markdown/html
    + figure base64. enhanced 산출물은 D91로 소비처가 없어 표준으로 다운시프트."""
    form = U._parse_form(figures=True)
    assert "mode" not in form
    assert form["coordinates"] == "true"
    assert form["output_formats"] == json.dumps(["markdown", "html"])
    assert form["base64_encoding"] == json.dumps(["figure"])
    # 기존 공통 필드는 유지(모델·ocr).
    assert form["model"] == U.settings.upstage_document_parse_model
    assert form["ocr"] == "auto"


async def test_parse_single_payload_sends_figures_form_and_returns_payload(monkeypatch):
    """_parse_single_payload는 figures 폼으로 실제 요청을 보내고 payload dict 반환."""
    monkeypatch.setattr(
        U,
        "settings",
        SimpleNamespace(
            upstage_api_key="test-key",
            upstage_base_url="https://api.example/v1",
            upstage_document_parse_model="document-parse",
        ),
    )
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["content"] = request.content
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"content": {"markdown": "ok"}, "elements": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        payload = await U._parse_single_payload(
            client, b"%PDF-1.4", "t.pdf", figures=True
        )

    assert payload == {"content": {"markdown": "ok"}, "elements": []}
    assert captured["url"].endswith("/document-digitization")
    body = captured["content"]
    assert b'name="mode"' not in body  # D92: 표준 모드(enhanced 제거)
    assert b'name="coordinates"' in body
    assert b'name="base64_encoding"' in body


# --- _pdf_segment_ranges (페이지 상한) --------------------------------------

def test_pdf_segment_ranges_caps_pages_per_segment():
    """max_pages=100이면 조각당 ≤100페이지, 시작 페이지 0-base가 정확하고 전 페이지 커버."""
    data = _make_pdf(250)
    ranges = U._pdf_segment_ranges(data, max_pages=100)
    starts = [start for start, _ in ranges]
    page_counts = [
        len(__import__("pypdf").PdfReader(io.BytesIO(seg)).pages) for _, seg in ranges
    ]
    assert all(pc <= 100 for pc in page_counts)
    assert sum(page_counts) == 250
    assert starts == [0, 100, 200]
    assert page_counts == [100, 100, 50]


def test_pdf_segments_wrapper_unchanged():
    """얇은 래퍼 _pdf_segments는 bytes만 반환(기존 계약 — test_pdf_split 회귀 방지)."""
    data = _make_pdf(2)
    segs = U._pdf_segments(data)
    assert isinstance(segs, list)
    assert all(isinstance(s, bytes) for s in segs)


# --- parse_document_full ----------------------------------------------------

async def test_full_pdf_merges_segments_with_page_and_id_offsets(monkeypatch):
    """2조각 병합: 조각1(3페이지·요소2개)+조각2(요소3개) → 조각2 page +3, id +2."""
    # 결정론: 시작 페이지 0/3의 2조각으로 사전 분할(실제 pypdf 분할은 별도 테스트).
    monkeypatch.setattr(
        U, "_pdf_segment_ranges", lambda *a, **k: [(0, b"S1"), (3, b"S2")]
    )

    figures_seen: list[bool] = []

    async def fake_payload(client, data, filename, *, figures=False):
        figures_seen.append(figures)
        if data == b"S1":
            return {
                "content": {"markdown": "S1MD"},
                "elements": [
                    {"id": 0, "page": 1, "category": "figure"},
                    {"id": 1, "page": 2, "category": "paragraph"},
                ],
            }
        return {
            "content": {"markdown": "S2MD"},
            "elements": [
                {"id": 0, "page": 1, "category": "figure"},
                {"id": 1, "page": 1, "category": "paragraph"},
                {"id": 2, "page": 2, "category": "figure"},
            ],
        }

    monkeypatch.setattr(U, "_parse_single_payload", fake_payload)

    markdown, elements = await U.parse_document_full(b"pdfbytes", "book.pdf")

    assert markdown == "S1MD\n\nS2MD"
    assert [el["page"] for el in elements] == [1, 2, 4, 4, 5]
    assert [el["id"] for el in elements] == [0, 1, 2, 3, 4]
    assert all(figures_seen)  # 교과서 경로는 항상 figures 폼(coordinates+base64, D92 표준 모드)


async def test_full_pdf_enforces_100_page_cap(monkeypatch):
    """PDF 경로는 _pdf_segment_ranges에 max_pages=100 상한을 강제한다."""
    captured: dict = {}

    def fake_ranges(data, target, hard, max_pages):
        captured["target"] = target
        captured["hard"] = hard
        captured["max_pages"] = max_pages
        return []

    monkeypatch.setattr(U, "_pdf_segment_ranges", fake_ranges)

    markdown, elements = await U.parse_document_full(b"pdfbytes", "book.pdf")

    assert captured["max_pages"] == 100
    assert captured["hard"] == U.UPSTAGE_PARSE_MAX_BYTES
    assert captured["target"] == U._SEGMENT_TARGET_BYTES
    assert (markdown, elements) == ("", [])


async def test_full_non_pdf_single_request_no_offset(monkeypatch):
    """비-PDF는 분할하지 않고 단일 요청 — page 오프셋 0(로컬=전역)."""
    def _boom(*a, **k):
        raise AssertionError("비-PDF는 _pdf_segment_ranges를 호출하지 않아야 함")

    monkeypatch.setattr(U, "_pdf_segment_ranges", _boom)

    calls: list[tuple] = []

    async def fake_payload(client, data, filename, *, figures=False):
        calls.append((data, figures))
        return {
            "content": {"markdown": "IMG"},
            "elements": [{"id": 0, "page": 1, "category": "figure"}],
        }

    monkeypatch.setattr(U, "_parse_single_payload", fake_payload)

    markdown, elements = await U.parse_document_full(b"imgbytes", "figure.png")

    assert markdown == "IMG"
    assert len(calls) == 1
    assert calls[0][1] is True  # figures 폼
    assert [el["page"] for el in elements] == [1]
    assert [el["id"] for el in elements] == [0]
