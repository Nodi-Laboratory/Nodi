"""손글씨 비전 예비 경로 (D181).

전용 OCR GPU가 내려가도 질문 펜이 살아 있어야 한다. 다만 **예비이지
대체가 아니다** — 순서가 뒤집히면 품질이 조용히 내려간다.
"""

import httpx
import pytest

from app.services import handwriting_vision as hv


def _reply(text: str) -> dict:
    return {"choices": [{"message": {"content": text}}]}


def test_그림이_먼저고_지시가_나중이다():
    """실측 2026-08-05(ink_marks): 지시를 앞이나 system에 두면 묻힌다.
    그림을 본 직후의 마지막 지시가 이긴다 — 같은 서버, 같은 규칙이다."""
    msgs = hv.build_messages(b"\x89PNG_fake")
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    parts = msgs[0]["content"]
    assert parts[0]["type"] == "image_url"
    assert parts[-1]["type"] == "text"
    assert parts[-1]["text"].rstrip().endswith("못 읽었으면 빈 줄을 내라.")


def test_고쳐_쓰지_말라고_말한다():
    """맞춤법을 고치면 **학생이 쓰지 않은 질문**이 된다."""
    joined = hv.SYSTEM
    assert "옮겨 적기만 한다" in joined
    assert "쓰인 대로" in joined
    assert "지어내는" in joined


def test_머리말을_걷어낸다():
    assert hv.parse("옮겨 적은 글자: 광합성이 뭐야") == "광합성이 뭐야"
    assert hv.parse('"광합성이 뭐야"') == "광합성이 뭐야"


def test_못_읽었다는_말을_글자로_오해하지_않는다():
    """그대로 두면 학생의 질문이 "글씨를 읽을 수 없습니다"가 된다."""
    assert hv.parse("이 이미지의 글씨는 읽을 수 없습니다.") == ""
    assert hv.parse("I cannot read the handwriting.") == ""
    assert hv.parse("") == ""


def test_길이를_자른다():
    assert len(hv.parse("가" * 900)) == hv.MAX_CHARS


@pytest.mark.asyncio
async def test_읽어_온다(monkeypatch):
    monkeypatch.setattr(hv.settings, "judge_base_url", "http://x/v1")
    monkeypatch.setattr(hv.settings, "judge_api_key", "k")
    monkeypatch.setattr(hv.settings, "ocr_vision_fallback_enabled", True)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_reply("광합성이 뭐야"))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
        assert await hv.recognize(b"png", client=c) == "광합성이 뭐야"


@pytest.mark.asyncio
async def test_어떤_실패든_빈_문자열(monkeypatch):
    """호출부는 이미 한 번 실패한 뒤에 온다 — 여기서 또 예외를 올리면
    그 갈래를 한 번 더 처리해야 한다."""
    monkeypatch.setattr(hv.settings, "judge_base_url", "http://x/v1")
    monkeypatch.setattr(hv.settings, "judge_api_key", "k")
    monkeypatch.setattr(hv.settings, "ocr_vision_fallback_enabled", True)

    async def boom(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="nope")

    async with httpx.AsyncClient(transport=httpx.MockTransport(boom)) as c:
        assert await hv.recognize(b"png", client=c) == ""


@pytest.mark.asyncio
async def test_꺼져_있으면_부르지_않는다(monkeypatch):
    monkeypatch.setattr(hv.settings, "ocr_vision_fallback_enabled", False)
    monkeypatch.setattr(hv.settings, "judge_base_url", "http://x/v1")
    monkeypatch.setattr(hv.settings, "judge_api_key", "k")
    assert hv.is_configured() is False
    assert await hv.recognize(b"png") == ""


@pytest.mark.asyncio
async def test_비전이_미설정이면_예비_경로가_없다(monkeypatch):
    monkeypatch.setattr(hv.settings, "ocr_vision_fallback_enabled", True)
    monkeypatch.setattr(hv.settings, "judge_base_url", "")
    assert hv.is_configured() is False
