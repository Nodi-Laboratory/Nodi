from unittest.mock import AsyncMock, patch

import pytest

from app.ai.base import SkillContext
from app.ai.skills.search_lecture_clip import SearchLectureClip


def _ctx(space_kind="class"):
    return SkillContext(user_id="u", client=AsyncMock(), session_id="s",
                        space_kind=space_kind, space_ref="class1", role="student")


@pytest.mark.asyncio
async def test_rejects_personal_scope():
    r = await SearchLectureClip().run({"query": "q"}, _ctx(space_kind="personal"))
    assert r.ok is False and r.error_code == "wrong_scope"


@pytest.mark.asyncio
async def test_returns_clips_in_data():
    items = [{"clip_id": "c1", "title": "고려 토지제도", "timeline_label": "14:56",
              "page_url": "http://ebs/x", "start_sec": 896, "video_title": "04강", "score": 0.7}]
    with patch.object(SearchLectureClip, "run", wraps=None):
        pass
    with patch("app.ai.skills.search_lecture_clip.lecture_search.search_class_clips",
               AsyncMock(return_value=items)):
        r = await SearchLectureClip().run({"query": "고려"}, _ctx())
    assert r.ok is True
    assert r.data["clips"] == items
    assert r.data["captions"] == ["고려 토지제도"]


@pytest.mark.asyncio
async def test_registered_and_in_catalog():
    from app.ai import catalog
    assert "search_lecture_clip" in catalog.ALL_DECLARED
    names = catalog.skills_for("class", "student")
    assert "search_lecture_clip" in names
