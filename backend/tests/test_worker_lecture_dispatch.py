import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import runner, jobs


@pytest.mark.asyncio
async def test_runner_dispatches_lecture_kinds():
    svc = AsyncMock()
    with patch.object(runner.lectures, "_handle_lecture_parse", AsyncMock()) as ph, \
         patch.object(runner.lectures, "_handle_lecture_embed", AsyncMock()) as eh, \
         patch.object(runner.lectures, "_handle_lecture_atom", AsyncMock()) as ah:
        await runner._process(svc, {"id": "j", "kind": "lecture_parse", "attempts": 0})
        await runner._process(svc, {"id": "j", "kind": "lecture_embed", "attempts": 0})
        await runner._process(svc, {"id": "j", "kind": "lecture_atom", "attempts": 0})
    ph.assert_awaited_once(); eh.assert_awaited_once(); ah.assert_awaited_once()


@pytest.mark.asyncio
async def test_fail_isolation_marks_video_not_file():
    svc = AsyncMock()
    await jobs._fail_file_for_job(svc, {"target_id": "v1", "kind": "lecture_parse"}, "err")
    tables = [c.args[0] for c in svc.update.call_args_list]
    assert "lecture_videos" in tables and "files" not in tables
