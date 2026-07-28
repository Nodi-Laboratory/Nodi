"""D109 3단계 — 교사 스킬의 권한 경계.

카탈로그(1층)가 학생에게 이 스킬을 보여주지 않지만, **모델이 없는 이름을 지어
부르는 일이 실제로 있다.** 그래서 실행 시점에도 막아야 한다. 여기서 검증하는
것은 그 2중 방어다.
"""

from __future__ import annotations

from typing import Any

from app.ai import skills_for
from app.ai.base import SkillContext
from app.ai.skills.teacher import (
    ListClassMaterialsSkill,
    SummarizeClassQuestionsSkill,
)


class _Client:
    def __init__(self, *, is_teacher=True, tables=None, rpc_raises=False):
        self._is_teacher = is_teacher
        self._tables = tables or {}
        self._rpc_raises = rpc_raises
        self.selects: list[str] = []

    async def rpc(self, fn: str, args: dict) -> Any:
        if self._rpc_raises:
            raise RuntimeError("rpc 실패")
        return self._is_teacher

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.selects.append(table)
        return self._tables.get(table, [])


def _ctx(client, space_kind="class", role="teacher") -> SkillContext:
    return SkillContext(
        user_id="t1",
        client=client,
        session_id="s1",
        space_kind=space_kind,
        space_ref="c1" if space_kind == "class" else None,
        role=role,
    )


# --- 카탈로그 (1층) --------------------------------------------------------


def test_학생에게는_교사_스킬이_안_보인다():
    names = skills_for("class", "student")
    assert "list_class_materials" not in names
    assert "summarize_class_questions" not in names


def test_교사에게는_보인다():
    names = skills_for("class", "teacher")
    assert "list_class_materials" in names
    assert "summarize_class_questions" in names


def test_교사라도_개인_공간에는_안_보인다():
    # 개인 세션엔 학급이라는 대상 자체가 없다.
    assert "list_class_materials" not in skills_for("personal", "teacher")


# --- 실행 시점 (3층) -------------------------------------------------------


async def test_담임이_아니면_거절한다():
    """카탈로그를 뚫고 들어와도 막힌다 — is_class_teacher가 최종 판정."""
    c = _Client(is_teacher=False)
    res = await ListClassMaterialsSkill().run({}, _ctx(c))
    assert res.ok is False
    assert res.error_code == "forbidden"
    # 거절됐으면 데이터 조회 자체가 없어야 한다.
    assert c.selects == []


async def test_개인_공간이면_거절한다():
    res = await ListClassMaterialsSkill().run({}, _ctx(_Client(), space_kind="personal"))
    assert res.ok is False
    assert res.error_code == "wrong_scope"


async def test_권한_확인_실패는_거절로_강등된다():
    """RPC가 터지면 통과시키지 않는다 — 실패는 안전한 쪽으로."""
    c = _Client(rpc_raises=True)
    res = await SummarizeClassQuestionsSkill().run({}, _ctx(c))
    assert res.ok is False
    assert res.error_code == "forbidden"


# --- 자료 목록 -------------------------------------------------------------


async def test_자료_목록은_상태와_진행률을_준다():
    c = _Client(tables={"files": [
        {"name": "3단원.pdf", "kind": "class_material", "status": "indexed",
         "chunk_total": 10, "chunk_done": 10},
        {"name": "교과서.pdf", "kind": "textbook", "status": "embedding",
         "chunk_total": 40, "chunk_done": 12},
    ]})
    res = await ListClassMaterialsSkill().run({}, _ctx(c))
    assert res.ok
    assert res.data["materials"][0]["kind"] == "수업자료"
    assert res.data["materials"][1]["kind"] == "교과서"
    assert res.data["materials"][1]["chunks"] == "12/40"
    # 검색 가능한 건수를 메시지에 담아 준다 — 선생님이 가장 궁금해하는 값이다.
    assert "검색 가능 1건" in res.message


async def test_자료가_없으면_그렇게_말한다():
    res = await ListClassMaterialsSkill().run({}, _ctx(_Client()))
    assert res.ok
    assert res.data["materials"] == []


# --- 질문 요약 -------------------------------------------------------------


async def test_학생_질문을_모아_준다():
    c = _Client(tables={
        "sessions": [{"id": "s1"}, {"id": "s2"}],
        "nodes": [
            {"question": "광합성이 뭐야?"},
            {"question": "  "},          # 공백만 → 버린다
            {"question": "지진은 왜 나?"},
        ],
    })
    res = await SummarizeClassQuestionsSkill().run({}, _ctx(c))
    assert res.data["questions"] == ["광합성이 뭐야?", "지진은 왜 나?"]


async def test_학생_대화가_없으면_노드를_조회하지_않는다():
    c = _Client(tables={"sessions": []})
    res = await SummarizeClassQuestionsSkill().run({}, _ctx(c))
    assert res.ok
    assert res.data["questions"] == []
    assert "nodes" not in c.selects
