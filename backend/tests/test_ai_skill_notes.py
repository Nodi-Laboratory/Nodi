"""학생이 캔버스에 직접 쓴 글 읽기 (2026-08-09).

캔버스는 읽기만 하는 화면이 아니다. 학생이 쓴 글은 지금까지 AI에게 가는 경로가
**하나도 없었다** — 트리는 AI 카드만 노드로 치고(`_tree_lines`), 세션 파일은
올린 파일이지 캔버스에 쓴 글이 아니다. 실측 2026-08-09: 로컬 DB에 학생 글이
116장 있는데 프롬프트로 가는 길이 없었다.
"""

from __future__ import annotations

from typing import Any

from app.ai.base import SkillContext
from app.ai.skills.notes import ReadMyNotesSkill


class _Client:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self._rows = rows or []
        self.calls: list[tuple[str, dict]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.calls.append((table, params))
        return self._rows if table == "canvas_items" else []


def _ctx(client) -> SkillContext:
    return SkillContext(
        user_id="u1",
        client=client,
        session_id="s1",
        space_kind="personal",
        space_ref=None,
        role="student",
    )


def _note(i: int, body: str, title: str = "") -> dict[str, Any]:
    return {"id": f"n{i}", "title": title, "body": body, "seq": i}


async def test_학생이_쓴_글을_돌려준다():
    c = _Client([_note(1, "내 정리: 광합성은 빛으로 양분을 만든다.")])
    res = await ReadMyNotesSkill().run({}, _ctx(c))
    assert res.ok
    assert res.data["notes"][0]["text"].startswith("내 정리")


async def test_학생_글만_읽는다():
    """AI 개념 카드가 섞이면 "내가 쓴 것"이 아니게 된다."""
    c = _Client([_note(1, "메모")])
    await ReadMyNotesSkill().run({}, _ctx(c))
    table, params = c.calls[0]
    assert table == "canvas_items"
    assert params["kind"] == "eq.note"
    assert params["session_id"] == "eq.s1"


async def test_빈_글은_빼고_센다():
    """자리만 잡아 둔 빈 상자가 목록에 뜨면 모델이 빈 줄을 읽는다."""
    c = _Client([_note(1, "  "), _note(2, "쓸모 있는 메모")])
    res = await ReadMyNotesSkill().run({}, _ctx(c))
    assert len(res.data["notes"]) == 1


async def test_없으면_없다고_한다():
    res = await ReadMyNotesSkill().run({}, _ctx(_Client()))
    assert res.ok
    assert res.data["notes"] == []
    assert "없습니다" in res.message


async def test_글_한_장이_프롬프트를_삼키지_않는다():
    c = _Client([_note(1, "가" * 5000)])
    res = await ReadMyNotesSkill().run({}, _ctx(c))
    assert len(res.data["notes"][0]["text"]) <= 800


async def test_장수도_제한한다():
    c = _Client([_note(i, f"메모 {i}") for i in range(1, 60)])
    res = await ReadMyNotesSkill().run({}, _ctx(c))
    assert len(res.data["notes"]) <= 20
    # 최근 것이 남아야 한다 — 방금 쓴 글을 가리킬 가능성이 높다.
    assert res.data["notes"][-1]["text"] == "메모 59"
