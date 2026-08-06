"""admin 노브가 **실제로 먹는지** (D62 점검 2026-08-06).

## 왜 이 파일이 필요한가

불변식은 "admin 오버레이(DB) > config 기본값"이다. 그런데 여덟 개가 오버레이가
아니라 `settings.*`를 직접 읽고 있었다 — 콘솔에서 값을 바꾸면 DB 행은 갱신되고
"기본값에서 변경됨" 배지까지 뜨는데 **서버는 옛 값으로 돌았다.**

그중 `ocr_enabled`는 **모델 서버 점검 중에 끄라고 만든 킬 스위치**다. 장애 때
쓰려고 만든 손잡이가 정작 그때 안 먹었다.

이 결함은 화면에도 로그에도 안 드러난다(껐다고 표시되고, 계속 돈다). 그래서
"노브가 스펙에 있으면 코드가 그 키를 오버레이로 읽는다"를 여기서 고정한다.
"""

from __future__ import annotations

import pytest

from app.services import admin_console, ink_marks, ocr

aio = pytest.mark.asyncio


def _overlay(values: dict):
    async def fake():
        return values

    return fake


# --- 킬 스위치가 실제로 끈다 --------------------------------------------------


@aio
async def test_ocr_킬스위치가_실제로_끈다(monkeypatch):
    """이게 안 되면 장애 때 쓸 손잡이가 없다."""
    monkeypatch.setattr(ocr.app_settings, "get_overlay", _overlay({"ocr_enabled": False}))
    assert (await ocr.read_knobs())["enabled"] is False
    monkeypatch.setattr(ocr, "resolve_base_url", lambda: "http://x")
    assert await ocr.is_available() is False


@aio
async def test_ocr_킬스위치가_켜져_있으면_부른다(monkeypatch):
    monkeypatch.setattr(ocr.app_settings, "get_overlay", _overlay({"ocr_enabled": True}))
    monkeypatch.setattr(ocr, "resolve_base_url", lambda: "http://x")
    assert await ocr.is_available() is True


@aio
async def test_주소가_없으면_노브와_무관하게_못_부른다(monkeypatch):
    monkeypatch.setattr(ocr.app_settings, "get_overlay", _overlay({"ocr_enabled": True}))
    monkeypatch.setattr(ocr, "resolve_base_url", lambda: "")
    assert await ocr.is_available() is False


@aio
async def test_표시_해석_킬스위치가_실제로_끈다(monkeypatch):
    monkeypatch.setattr(
        ink_marks.app_settings, "get_overlay", _overlay({"ink_vlm_enabled": False})
    )
    got = await ink_marks.read_marks([], b"png")
    assert got.status == "off"


@aio
async def test_킬스위치는_주소_확인과_다른_일이다(monkeypatch):
    """`missing_config`는 env만 본다 — 껐다고 "설정이 빠졌다"고 하면 관리자가
    env를 뒤진다."""
    monkeypatch.setattr(ocr.app_settings, "get_overlay", _overlay({"ocr_enabled": False}))
    monkeypatch.setattr(ocr, "resolve_base_url", lambda: "http://x")
    assert ocr.missing_config() == []


# --- 값 노브가 오버레이를 탄다 ------------------------------------------------


@aio
@pytest.mark.parametrize(
    "key,field,value",
    [
        ("ocr_timeout_seconds", "timeout", 77),
        ("ocr_max_concurrent", "max_concurrent", 5),
        ("ocr_queue_timeout_seconds", "queue_timeout", 9),
        ("ocr_max_new_tokens", "max_new_tokens", 512),
    ],
)
async def test_ocr_값_노브가_먹는다(monkeypatch, key, field, value):
    monkeypatch.setattr(ocr.app_settings, "get_overlay", _overlay({key: value}))
    assert (await ocr.read_knobs())[field] == value


@aio
async def test_표시_해석_상한이_먹는다(monkeypatch):
    monkeypatch.setattr(
        ink_marks.app_settings, "get_overlay", _overlay({"ink_vlm_timeout_seconds": 45})
    )
    assert (await ink_marks.read_knobs())["timeout"] == 45


@aio
async def test_카드_본문_길이가_먹는다(monkeypatch):
    monkeypatch.setattr(
        ink_marks.app_settings, "get_overlay", _overlay({"ink_card_body_max_chars": 300})
    )
    assert await ink_marks.read_card_body_max() == 300


@aio
async def test_말도_안_되는_값은_clamp된다(monkeypatch):
    """오버레이는 관리자가 손으로 넣는 값이다 — 0초 타임아웃이면 전부 실패한다."""
    monkeypatch.setattr(
        ocr.app_settings, "get_overlay", _overlay({"ocr_timeout_seconds": 0})
    )
    assert (await ocr.read_knobs())["timeout"] >= 5


# --- 스펙과 코드가 갈리지 않는다 ----------------------------------------------


def test_점검에서_드러난_여덟_키가_스펙에_있다():
    """스펙에서 사라지면 콘솔에서 못 만지는데 코드는 계속 읽는다 — 반대 방향의
    같은 어긋남이다."""
    keys = {s["key"] for s in admin_console._SPECS}
    for k in (
        "ocr_enabled",
        "ocr_timeout_seconds",
        "ocr_max_concurrent",
        "ocr_queue_timeout_seconds",
        "ocr_max_new_tokens",
        "ink_vlm_enabled",
        "ink_vlm_timeout_seconds",
        "ink_card_body_max_chars",
    ):
        assert k in keys, k
