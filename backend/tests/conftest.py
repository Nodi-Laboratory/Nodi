"""테스트 공용 픽스처.

Gemini 키는 **모든 테스트에서 기본적으로 비운다** (공개판 2026-09-27).
Gemini가 설정돼 있으면 비전·손글씨가 legacy(EXAONE·VARCO)를 건너뛰므로, 개발자
`backend/.env`에 GEMINI_API_KEY가 들어 있으면 legacy 경로 테스트가 조용히 다른
갈래를 타고 깨진다. Gemini 갈래를 보는 테스트는 스스로 키를 넣는다
(tests/test_gemini_vision.py).
"""

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def _no_env_gemini_key(monkeypatch):
    monkeypatch.setattr(get_settings(), "gemini_api_key", "")
