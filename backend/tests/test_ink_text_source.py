"""손글씨를 **어느 길로 읽었는지** 응답에 남긴다 (사용자 지시 2026-08-10).

전용 OCR(VARCO)이 내려가면 비전 모델이 대신 읽는다(D181). 그 예비 경로는
학생을 구하지만 **정확도는 내려간다** — 그런데 지금까지 아무도 그 사실을 알
방법이 없었다. 학생 화면은 멀쩡하고, 관리자 실험실도 조용했다.

이 코드베이스가 거듭 잡아 온 "오류 없이 조용히 나빠지는" 부류라, 상태를
`marks_status`와 같은 자리에 실어 보낸다.
"""

from __future__ import annotations

import inspect

from app.routers import ink


def test_경로를_응답에_싣는다():
    src = inspect.getsource(ink)
    assert '"text_source": text_source' in src, "응답에 text_source가 없다"


def test_세_갈래를_구분한다():
    """`varco`(전용) · `vision_fallback`(예비) · `unavailable`(둘 다 실패)."""
    src = inspect.getsource(ink)
    for v in ('text_source = "varco"', 'text_source = "vision_fallback"',
              'text_source = "unavailable"'):
        assert v in src, f"{v} 가 없다"


def test_예비가_성공했을_때만_fallback으로_표시한다():
    """빈 결과를 받고 원래 실패를 올리는 길에서는 `vision_fallback`이 아니다.

    ⚠️ 여기가 어긋나면 **예비가 실패했는데 성공으로 기록된다** — 관리자가 보는
    상태가 거짓이 되고, 그건 상태를 아예 안 남기는 것보다 나쁘다.
    """
    src = inspect.getsource(ink)
    # `if text:` 안쪽에서만 fallback으로 바뀐다.
    i_if = src.index("            if text:")
    i_set = src.index('text_source = "vision_fallback"')
    assert i_set > i_if, "성공 판정 밖에서 fallback으로 표시하고 있다"
