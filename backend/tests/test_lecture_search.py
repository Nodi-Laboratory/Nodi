from unittest.mock import AsyncMock, patch

import pytest

from app.services import lecture_search


@pytest.mark.asyncio
async def test_no_enabled_packages_returns_empty():
    client = AsyncMock()
    client.select.return_value = []   # class_lecture_packages 비어있음
    out = await lecture_search.search_class_clips(client, "class1", "미터원기")
    assert out == []


@pytest.mark.asyncio
async def test_direct_hit_returns_clip_with_timeline():
    client = AsyncMock()
    client.select.side_effect = [
        [{"package_id": "p1"}],                                             # 켠 패키지
        # clips 재조회
        [{"id": "c1", "video_id": "v1", "start_sec": 896, "title": "고려 토지제도"}],
        [{"id": "v1", "page_url": "http://ebs/x", "title": "한국사 04강"}],  # videos
    ]
    # search 두 번: [0]=직접(클립) 히트, [1]=원자 히트(없음)
    with patch.object(
        lecture_search.upstage,
        "embed_query",
        AsyncMock(return_value=[0.1] * 1024),
    ), \
         patch.object(lecture_search.qdrant_store, "search",
                      AsyncMock(side_effect=[[{"id": "c1", "score": 0.7, "payload": {}}], []])), \
         patch.object(lecture_search.app_settings, "get_overlay", AsyncMock(return_value={})):
        out = await lecture_search.search_class_clips(client, "class1", "고려 토지")
    assert out[0]["clip_id"] == "c1" and out[0]["via"] == "clip"
    assert out[0]["timeline_label"] == "14:56"
    assert out[0]["page_url"] == "http://ebs/x" and out[0]["video_title"] == "한국사 04강"


@pytest.mark.asyncio
async def test_atom_hit_resolves_to_clip_via_payload():
    client = AsyncMock()
    client.select.side_effect = [
        [{"package_id": "p1"}],                                             # 켠 패키지
        # clips 재조회
        [{"id": "c9", "video_id": "v9", "start_sec": 553, "title": "삼국 경제정책"}],
        [{"id": "v9", "page_url": "http://ebs/y", "title": "한국사 04강"}],  # videos
    ]
    # 직접은 0건, 원자만 히트 → payload.clip_id로 c9 해석
    with patch.object(
        lecture_search.upstage,
        "embed_query",
        AsyncMock(return_value=[0.1] * 1024),
    ), \
         patch.object(lecture_search.qdrant_store, "search",
                      AsyncMock(side_effect=[[], [{"id": "a1", "score": 0.8,
                                                   "payload": {"clip_id": "c9"}}]])), \
         patch.object(lecture_search.app_settings, "get_overlay", AsyncMock(return_value={})):
        out = await lecture_search.search_class_clips(client, "class1", "땅 어떻게 나눠줬어")
    assert out[0]["clip_id"] == "c9" and out[0]["via"] == "atom"


@pytest.mark.asyncio
async def test_failure_degrades_to_empty():
    client = AsyncMock()
    client.select.side_effect = RuntimeError("db down")
    assert await lecture_search.search_class_clips(client, "class1", "q") == []
