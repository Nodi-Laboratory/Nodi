"""강의 잡 디스패치와 실패 격리.

⚠️ **`lecture_parse` 잡은 없다** (2026-08-10). 대회 규정상 제품 안에서 해외
모델을 못 써서, EBS 페이지 파싱과 Whisper 전사를 서버에서 통째로 걷어냈다.
파싱은 저장소 밖 오프라인 스크립트가 끝내고 관리자가 그 결과 파일을 올린다 —
그 순간 클립 행이 만들어지므로 서버가 하는 일은 임베딩부터다.
"""

from unittest.mock import AsyncMock, patch

import pytest

from app.services.worker import jobs, runner


@pytest.mark.asyncio
async def test_runner_dispatches_lecture_kinds():
    svc = AsyncMock()
    with patch.object(runner.lectures, "_handle_lecture_embed", AsyncMock()) as eh, \
         patch.object(runner.lectures, "_handle_lecture_atom", AsyncMock()) as ah:
        await runner._process(svc, {"id": "j", "kind": "lecture_embed", "attempts": 0})
        await runner._process(svc, {"id": "j", "kind": "lecture_atom", "attempts": 0})
    eh.assert_awaited_once()
    ah.assert_awaited_once()


@pytest.mark.asyncio
async def test_파싱_잡은_더_이상_없다():
    """옛 잡 종류가 큐에 남아 있어도 **되살아나지 않는다.**

    배포 전에 큐에 들어간 `lecture_parse` 행이 있을 수 있다. 그걸 처리하는
    분기가 남아 있으면 걷어냈다고 믿은 경로가 조용히 한 번 더 돈다.
    """
    assert not hasattr(runner.lectures, "_handle_lecture_parse")


@pytest.mark.asyncio
async def test_임베딩_잡_실패는_클립만_건드린다():
    """D149·D88 격리 — 파일·영상 status는 불가침이다."""
    svc = AsyncMock()
    await jobs._fail_file_for_job(
        svc,
        {"target_id": "v1", "kind": "lecture_embed",
         "batch_range": {"from_seq": 0, "to_seq": 4}},
        "err",
    )
    tables = [c.args[0] for c in svc.update.call_args_list]
    assert "lecture_clips" in tables
    assert "files" not in tables and "lecture_videos" not in tables
