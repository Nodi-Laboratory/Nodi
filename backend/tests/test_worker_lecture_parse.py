import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import lectures
from app.services.lecture_parse import LectureChapter


@pytest.mark.asyncio
async def test_parse_builds_transcript_and_end_sec_and_fanout():
    svc = AsyncMock()
    svc.select.return_value = [{"id": "v1", "page_url": "http://ebs/x",
                               "subtitle_path": "lectures/v1.smi", "title": "04강", "status": "pending"}]
    svc.storage_download = AsyncMock(return_value=b"<smi/>")
    job = {"id": "j1", "target_id": "v1", "owner_id": "admin1"}
    from app.services.subtitle_parse import Cue
    with patch.object(lectures.lecture_parse, "fetch_ebs_html", AsyncMock(return_value="<html/>")), \
         patch.object(lectures.lecture_parse, "parse_ebs_player",
                      return_value=[LectureChapter(365, "A"), LectureChapter(553, "B")]), \
         patch.object(lectures.subtitle_parse, "parse_subtitle",
                      return_value=[Cue(400000, 420000, "본문A"), Cue(560000, 580000, "본문B")]), \
         patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})):
        await lectures._handle_lecture_parse(svc, job)
    clip_inserts = [c for c in svc.insert.call_args_list if c.args[0] == "lecture_clips"]
    rows = clip_inserts[0].args[1]
    assert rows[0]["start_sec"] == 365 and rows[0]["end_sec"] == 553   # 다음 챕터 시작
    assert rows[1]["end_sec"] is None                                   # 마지막
    assert rows[0]["transcript"] == "본문A"                             # [365,553) 구간
    assert any(c.args[0] == "jobs" and c.args[1].get("kind") == "lecture_embed"
               for c in svc.insert.call_args_list)
    assert any(c.args[0] == "lecture_videos" and c.args[2].get("status") == "parsed"
               for c in svc.update.call_args_list)


@pytest.mark.asyncio
async def test_no_subtitle_still_parses_with_empty_transcript():
    svc = AsyncMock()
    svc.select.return_value = [{"id": "v1", "page_url": "http://ebs/x",
                               "subtitle_path": None, "title": "t", "status": "pending"}]
    with patch.object(lectures.lecture_parse, "fetch_ebs_html", AsyncMock(return_value="<html/>")), \
         patch.object(lectures.lecture_parse, "parse_ebs_player",
                      return_value=[LectureChapter(365, "A")]), \
         patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})):
        await lectures._handle_lecture_parse(svc, {"id": "j1", "target_id": "v1", "owner_id": "a"})
    rows = [c for c in svc.insert.call_args_list if c.args[0] == "lecture_clips"][0].args[1]
    assert rows[0]["transcript"] == ""   # 자막 없으면 빈 본문(제목만 임베딩으로 강등)


@pytest.mark.asyncio
async def test_no_chapters_marks_failed():
    svc = AsyncMock()
    svc.select.return_value = [{"id": "v1", "page_url": "http://ebs/x",
                               "subtitle_path": None, "title": "t", "status": "pending"}]
    with patch.object(lectures.lecture_parse, "fetch_ebs_html", AsyncMock(return_value="<html/>")), \
         patch.object(lectures.lecture_parse, "parse_ebs_player", return_value=[]), \
         patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})):
        await lectures._handle_lecture_parse(svc, {"id": "j1", "target_id": "v1", "owner_id": "a"})
    assert any(c.args[0] == "lecture_videos" and c.args[2].get("status") == "failed"
               for c in svc.update.call_args_list)
