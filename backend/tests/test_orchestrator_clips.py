"""오케스트레이터 clips 수집 채널 (D149).

figures 채널과 대칭 — 스킬 result.data["clips"]를 clip_id로 dedupe.
"""

from app.ai.base import SkillResult
from app.ai.orchestrator import Orchestrator, TurnOutcome


def test_collect_gathers_clips_dedup_by_clip_id():
    outcome = TurnOutcome()
    r = SkillResult(
        ok=True,
        message="",
        data={
            "clips": [
                {"clip_id": "c1", "title": "A"},
                {"clip_id": "c1", "title": "A"},
                {"clip_id": "c2", "title": "B"},
            ]
        },
    )
    Orchestrator._collect(outcome, "search_lecture_clip", r)
    assert [c["clip_id"] for c in outcome.clips] == ["c1", "c2"]
