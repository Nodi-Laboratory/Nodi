"""D78 — 대용량 PDF 분할 파싱 테스트 (실제 Upstage 호출 없음).

블랭크 페이지 PDF의 절대 크기는 pypdf 버전에 따라 다르므로, 단일 페이지
직렬화 크기(unit)를 기준으로 하드 리밋을 상대 설정해 결정론을 확보한다.
"""

import io

import pytest
from pypdf import PdfReader, PdfWriter

from app.services import upstage as U


def _make_pdf(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _single_page_size(data: bytes) -> int:
    r = PdfReader(io.BytesIO(data))
    w = PdfWriter()
    w.add_page(r.pages[0])
    buf = io.BytesIO()
    w.write(buf)
    return len(buf.getvalue())


def test_segments_cover_all_pages_within_hard_limit():
    """⑥ 조각이 전 페이지를 커버하고 각 조각이 하드 리밋 이하."""
    data = _make_pdf(10)
    unit = _single_page_size(data)
    hard = unit * 2 + 200  # 조각당 최대 ~2페이지 — 분할 강제, 1페이지는 항상 수용
    segs = U._pdf_segments(data, target=hard - 100, hard=hard)
    assert len(segs) >= 2
    assert all(len(s) <= hard for s in segs)
    assert sum(len(PdfReader(io.BytesIO(s)).pages) for s in segs) == 10


def test_small_pdf_single_segment():
    """기본 타깃(48MB)에서는 소형 PDF가 분할되지 않는다."""
    data = _make_pdf(2)
    assert len(U._pdf_segments(data)) == 1


@pytest.mark.asyncio
async def test_parse_document_dispatches_large_pdf(monkeypatch):
    """⑦ 50MB 초과 PDF → 분할 경로, 조각 결과가 페이지 순으로 연결."""
    data = _make_pdf(6)
    # 하드 리밋을 원본보다 1B 작게 → 디스패치 강제. 타깃도 동일값 →
    # 페이지당 평균 기준 5페이지 1차 그룹 → 2조각(5p+1p), 각각 리밋 이하.
    monkeypatch.setattr(U, "UPSTAGE_PARSE_MAX_BYTES", len(data) - 1)
    monkeypatch.setattr(U, "_SEGMENT_TARGET_BYTES", len(data) - 1)

    calls: list[str] = []

    async def fake_single(seg, filename):
        calls.append(filename)
        return f"[{filename}]"

    monkeypatch.setattr(U, "_parse_single", fake_single)
    out = await U.parse_document(data, "big.pdf")
    assert len(calls) >= 2
    part_no = [int(n.split(".part")[1].split(".")[0]) for n in calls]
    assert sorted(part_no) == list(range(1, len(calls) + 1))
    # 연결은 조각 인덱스(페이지) 순 — gather 결과 순서 보장.
    assert out == "\n\n".join(f"[big.pdf.part{i}.pdf]" for i in range(1, len(calls) + 1))


@pytest.mark.asyncio
async def test_parse_document_small_uses_single_path(monkeypatch):
    """⑧ 리밋 이하 PDF는 기존 단일 요청 경로."""
    async def fake_single(seg, filename):
        return "ok"

    monkeypatch.setattr(U, "_parse_single", fake_single)
    assert await U.parse_document(b"%PDF-1.4 tiny", "small.pdf") == "ok"
