import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import lectures


@pytest.mark.asyncio
async def test_atom_generates_and_upserts_with_model_override():
    svc = AsyncMock()
    svc.select.side_effect = [
        [{"id": "c1", "seq": 0, "title": "고려 토지제도", "transcript": "전시과 본문"}],  # embedded clips
        [],                                                                              # 기존 원자 없음
        [{"id": "v1", "package_id": "p1"}],                                              # video package
    ]
    svc.insert.return_value = [{"id": "a1", "clip_id": "c1", "question": "전시과는?"}]
    captured = {}

    async def fake_complete(messages, *, max_tokens=None, model=None):
        captured["model"] = model
        from app.services.solar import Completion
        return Completion(message={"content": "전시과는?"})

    async def fake_upsert(points, collection):
        captured["collection"] = collection
        captured["payload"] = points[0]["payload"]

    with patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})), \
         patch.object(lectures.solar, "complete", fake_complete), \
         patch.object(lectures.upstage, "embed_passages", AsyncMock(return_value=[[0.1] * 1024])), \
         patch.object(lectures.common, "_qdrant_upsert", fake_upsert):
        await lectures._handle_lecture_atom(svc, {"id": "j3", "target_id": "v1",
                                                  "batch_range": {"from_seq": 0, "to_seq": 16}})
    assert captured["model"] == "solar-pro3"                       # 모델 오버라이드
    assert captured["collection"] == lectures.qdrant_store.COL_LECTURE_CLIP_ATOMS
    assert set(captured["payload"].keys()) == {"atom_id", "clip_id", "package_id"}
