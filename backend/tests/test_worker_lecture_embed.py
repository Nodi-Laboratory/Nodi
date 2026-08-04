from unittest.mock import AsyncMock, patch

import pytest

from app.services.worker import lectures


@pytest.mark.asyncio
async def test_embed_upserts_identifier_only_payload():
    svc = AsyncMock()
    # 1) clips select, 2) video select(package_id)
    svc.select.side_effect = [
        [{"id": "c1", "seq": 0, "title": "고려 토지제도"}],
        [{"id": "v1", "package_id": "p1"}],
    ]
    job = {"id": "j2", "target_id": "v1", "batch_range": {"from_seq": 0, "to_seq": 16}}
    captured = {}

    async def fake_upsert(points, collection):
        captured["points"] = points
        captured["collection"] = collection

    with patch.object(lectures.upstage, "embed_passages", AsyncMock(return_value=[[0.1] * 1024])), \
         patch.object(lectures.common, "_qdrant_upsert", fake_upsert):
        await lectures._handle_lecture_embed(svc, job)
    assert captured["collection"] == lectures.qdrant_store.COL_LECTURE_CLIPS
    pl = captured["points"][0]["payload"]
    assert set(pl.keys()) == {"clip_id", "video_id", "package_id"}   # 식별자만
    # ServiceClient.update(table, filters, patch) → AsyncMock에서 patch는 args[2]다.
    assert any(c.args[0] == "lecture_clips" and c.args[2].get("status") == "embedded"
               for c in svc.update.call_args_list)
