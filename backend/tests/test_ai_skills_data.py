"""D109 2단계 — 세션 파일·개념 조회 스킬.

이 스킬들의 결과는 곧 **다음 LLM 호출의 입력**이다. 그래서 검증 관점이 둘이다:
  1. 내용이 맞는가
  2. **양이 통제되는가** — 예전의 "매 턴 15만 자 주입"으로 돌아가면 안 된다
"""

from __future__ import annotations

from typing import Any

from app.ai.base import SkillContext
from app.ai.skills.concepts import (
    GetConceptSkill,
    ListSessionConceptsSkill,
    _parse_cards,
)
from app.ai.skills.session_files import (
    ListSessionFilesSkill,
    ReadSessionFileSkill,
)

ANSWER_1 = """CHAT: 광합성을 알아볼까요?
@concept: 광합성 | 식물의 생명 활동
- 식물이 **빛**으로 ==포도당==을 만들어요
- 산소가 나와요
@related: 엽록체
@end"""

ANSWER_2 = """CHAT: 이어서 볼게요
@concept: 세포호흡 | 식물의 생명 활동
- 포도당을 분해해 에너지를 얻어요
@end
@concept: 엽록체 | 세포 소기관
- 광합성이 일어나는 곳이에요
/end"""


class _Client:
    """select만 흉내 내는 대역. 테이블별로 준비된 행을 돌려준다."""

    def __init__(self, nodes=None, files=None, chunks=None):
        self._nodes = nodes or []
        self._files = files or []
        self._chunks = chunks or []
        self.calls: list[tuple[str, dict]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.calls.append((table, params))
        return {
            "nodes": self._nodes,
            "files": self._files,
            "file_chunks": self._chunks,
        }.get(table, [])


def _ctx(client) -> SkillContext:
    return SkillContext(
        user_id="u1",
        client=client,
        session_id="s1",
        space_kind="personal",
        space_ref=None,
        role="student",
    )


# --- 개념 카드 파싱 --------------------------------------------------------


def test_카드_파싱은_제목과_분류를_가른다():
    cards = _parse_cards(ANSWER_1)
    assert len(cards) == 1
    assert cards[0]["title"] == "광합성"
    assert cards[0]["cluster"] == "식물의 생명 활동"


def test_본문에서_강조_마커를_걷어낸다():
    # 모델이 다시 읽을 때 `**`·`==`는 잡음일 뿐이다.
    body = _parse_cards(ANSWER_1)[0]["body"]
    assert body[0] == "식물이 빛으로 포도당을 만들어요"


def test_종료_토큰_변형도_카드를_닫는다():
    # 파서와 같은 관용성 — 모델이 `/end`를 쓰는 일이 실제로 있다.
    cards = _parse_cards(ANSWER_2)
    assert [c["title"] for c in cards] == ["세포호흡", "엽록체"]


def test_분류가_없으면_빈_문자열():
    assert _parse_cards("@concept: 제목만\n- 본문\n@end")[0]["cluster"] == ""


def test_형식_밖_줄은_버린다():
    cards = _parse_cards("그냥 텍스트\n@concept: A | T\n> 인용\n- 본문\n@end")
    assert cards[0]["body"] == ["본문"]


# --- list_session_concepts -------------------------------------------------


async def test_개념_목록과_분류_목록을_돌려준다():
    c = _Client(nodes=[{"answer": ANSWER_1}, {"answer": ANSWER_2}])
    res = await ListSessionConceptsSkill().run({}, _ctx(c))
    assert res.ok
    assert [x["title"] for x in res.data["concepts"]] == ["광합성", "세포호흡", "엽록체"]
    # 분류는 **중복 제거 + 첫 등장 순서** — 태그 재사용의 근거다.
    assert res.data["clusters"] == ["식물의 생명 활동", "세포 소기관"]


async def test_개념이_없으면_새로_지어도_된다고_알려준다():
    res = await ListSessionConceptsSkill().run({}, _ctx(_Client()))
    assert res.ok
    assert res.data["concepts"] == []
    assert "새 분류" in res.message


# --- get_concept -----------------------------------------------------------


async def test_제목이_정확히_맞으면_본문을_준다():
    c = _Client(nodes=[{"answer": ANSWER_1}])
    res = await GetConceptSkill().run({"title": "광합성"}, _ctx(c))
    assert res.data["found"] is True
    assert res.data["cluster"] == "식물의 생명 활동"
    assert "포도당" in res.data["body"][0]


async def test_제목이_조금_달라도_찾는다():
    # 모델이 제목을 정확히 기억하지 못하는 일이 흔하다.
    c = _Client(nodes=[{"answer": ANSWER_1}])
    res = await GetConceptSkill().run({"title": "광합성 과정"}, _ctx(c))
    assert res.data["found"] is True


async def test_못_찾으면_있는_제목을_알려준다():
    """헛물을 켜지 않게 후보를 준다 — 없다고만 하면 다시 헤맨다."""
    c = _Client(nodes=[{"answer": ANSWER_1}])
    res = await GetConceptSkill().run({"title": "미분"}, _ctx(c))
    assert res.ok
    assert res.data["found"] is False
    assert res.data["available"] == ["광합성"]


async def test_빈_제목은_거절한다():
    res = await GetConceptSkill().run({"title": "  "}, _ctx(_Client()))
    assert res.ok is False
    assert res.error_code == "bad_args"


# --- 세션 파일 -------------------------------------------------------------


async def test_파일_목록은_이름과_분량만_준다():
    """본문은 주지 않는다 — 목록은 싸야 한다."""
    c = _Client(files=[{"id": "f1", "name": "노트.pdf", "context_chars": 12000}])
    res = await ListSessionFilesSkill().run({}, _ctx(c))
    assert res.data["files"] == [
        {"file_id": "f1", "name": "노트.pdf", "chars": 12000}
    ]
    assert "text" not in res.data


async def test_파일이_없으면_빈_목록():
    res = await ListSessionFilesSkill().run({}, _ctx(_Client()))
    assert res.ok
    assert res.data["files"] == []


async def test_긴_파일은_잘라서_주고_이어읽기_위치를_알려준다():
    """전문을 통째로 실으면 예전의 '매 턴 15만 자'와 다를 게 없다."""
    long_text = "가" * 10_000
    c = _Client(
        files=[{"id": "f1", "name": "긴글.txt", "context_chars": 10_000}],
        chunks=[{"seq": 0, "chunk_text": long_text}],
    )
    res = await ReadSessionFileSkill().run({"file_id": "f1"}, _ctx(c))
    assert res.ok
    assert len(res.data["text"]) == 3000
    assert res.data["from_char"] == 0
    assert res.data["next_char"] == 3000
    assert res.data["total_chars"] == 10_000
    assert res.data["eof"] is False


async def test_이어읽기가_동작한다():
    c = _Client(
        files=[{"id": "f1", "name": "긴글.txt", "context_chars": 4000}],
        chunks=[{"seq": 0, "chunk_text": "".join(str(i % 10) for i in range(4000))}],
    )
    res = await ReadSessionFileSkill().run(
        {"file_id": "f1", "from_char": 3000}, _ctx(c)
    )
    assert res.data["from_char"] == 3000
    assert res.data["eof"] is True
    assert len(res.data["text"]) == 1000


async def test_이_세션의_파일이_아니면_거절한다():
    """file_id만 믿고 읽으면 같은 소유자의 다른 세션 파일이 새어 나간다."""
    c = _Client(files=[{"id": "f1", "name": "내 파일", "context_chars": 10}])
    res = await ReadSessionFileSkill().run({"file_id": "다른파일"}, _ctx(c))
    assert res.ok is False
    assert res.error_code == "not_found"
