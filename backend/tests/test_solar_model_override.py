"""D149: solar.complete()의 per-call `model` 오버라이드 시그니처 검사.

강의 원자 생성만 solar-pro3를 쓰고 전역 채팅 모델은 그대로 두기 위해,
`complete()`에 기본값 None의 `model` kwarg가 있어야 한다(None이면 전역 동작 불변).
"""

import inspect

from app.services import solar


def test_complete_accepts_model_kwarg():
    sig = inspect.signature(solar.complete)
    assert "model" in sig.parameters
    assert sig.parameters["model"].default is None
