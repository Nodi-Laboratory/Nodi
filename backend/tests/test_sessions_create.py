"""빈 대화가 무한히 쌓이지 않는다 (D202).

"새 대화"를 누를 때마다 행이 생기던 것을, **이미 있는 빈 대화를 다시 여는**
쪽으로 바꿨다. 지우는 것이 아니라 안 만드는 것이라 잃는 것이 없다.

여기서 못 박는 것 다섯:
  1. 최근 대화가 비었으면 **insert가 아예 안 나간다**
  2. 글이 하나라도 있으면 새로 만든다
  3. 파일만 붙어 있어도 새로 만든다(그 파일이 다음 질문에 딸려 가면 안 된다)
  4. **턴이 있었으면** 새로 만든다 (2026-08-09)
  5. 제목을 정해서 만들라고 하면 언제나 새로 만든다
"""

from __future__ import annotations

import pytest

from app.services import sessions as svc

OWNER = "11111111-1111-1111-1111-111111111111"


class FakeClient:
    """select/count/insert만 흉내 내는 최소 대역."""

    def __init__(
        self,
        recent: list[dict] | None = None,
        counts: dict | None = None,
        drawings: list[dict] | None = None,
    ):
        self._drawings = drawings if drawings is not None else []
        self._recent = recent if recent is not None else []
        self._counts = counts or {}
        self.inserted: list[dict] = []
        self.selects: list[dict] = []

    async def select(self, table, params):
        self.selects.append({"table": table, **params})
        # 그림은 따로 준다 — 표마다 돌려줄 것이 다르다.
        if table == "canvas_drawings":
            return list(self._drawings)
        return list(self._recent)

    async def count(self, table, params):
        return int(self._counts.get(table, 0))

    async def insert(self, table, row):
        self.inserted.append(row)
        return {"id": "new-session", **row}


def 빈대화(sid: str = "empty-1") -> dict:
    return {"id": sid, "title": None, "space_kind": "personal"}


@pytest.mark.asyncio
async def test_빈_대화가_있으면_그것을_돌려준다():
    c = FakeClient(recent=[빈대화()])
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "empty-1"
    # 안 만드는 것이 요점이다 — 만들고 나서 지우면 id가 계속 바뀐다.
    assert c.inserted == []


@pytest.mark.asyncio
async def test_글이_있으면_새로_만든다():
    c = FakeClient(recent=[빈대화()], counts={"canvas_items": 3})
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session"
    assert len(c.inserted) == 1


@pytest.mark.asyncio
async def test_턴이_있었으면_새로_만든다():
    """`canvas_items`가 0인데 답이 있는 방이 실제로 있다 (2026-08-09).

    카드는 **화면이** 만든다. 스트리밍 도중에 새로고침하면 서버는 `nodes`에
    답을 남기고 카드는 안 생긴다 — v2 이전 대화도 같은 모양이고, 화면은 그런
    방을 `nodes`에서 읽어 `legacy-…` 카드로 그린다.

    그 방을 재사용하면 학생이 "새 대화"를 눌렀는데 **지난 답이 그대로 있는
    방**이 열린다(실측: 새 대화에 `legacy-…` 카드 한 장이 떠 있었다).
    """
    c = FakeClient(recent=[빈대화()], counts={"nodes": 1})
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session"
    assert len(c.inserted) == 1


@pytest.mark.asyncio
async def test_파일만_붙어_있어도_새로_만든다():
    # 자료만 올려 둔 대화를 재사용하면 그 파일이 다음 질문의 컨텍스트로
    # 조용히 딸려 간다 — 학생은 올린 적이 없다고 기억한다.
    c = FakeClient(recent=[빈대화()], counts={"files": 1})
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session"


@pytest.mark.asyncio
async def test_이름을_정해_만들면_언제나_새로_만든다():
    c = FakeClient(recent=[빈대화()])
    out = await svc.create_session(c, OWNER, "personal", None, "탐구 노트")
    assert out["id"] == "new-session"
    assert c.inserted[0]["title"] == "탐구 노트"
    # 제목이 있으면 재사용을 따질 필요가 없다 — 조회조차 안 나가야 한다.
    assert c.selects == []


@pytest.mark.asyncio
async def test_이름_있는_대화는_재사용하지_않는다():
    c = FakeClient(recent=[{"id": "titled", "title": "광합성"}])
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session"


@pytest.mark.asyncio
async def test_대화가_하나도_없으면_만든다():
    c = FakeClient(recent=[])
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session"
    assert c.inserted[0]["space_ref"] == OWNER


@pytest.mark.asyncio
async def test_학급은_그_학급_안에서만_찾는다():
    c = FakeClient(recent=[빈대화("class-empty")])
    await svc.create_session(c, OWNER, "class", "cls-9", None)
    조회 = c.selects[0]
    assert 조회["space_kind"] == "eq.class"
    assert 조회["space_ref"] == "eq.cls-9"
    # 가장 최근 것 하나만 본다 — 목록 전체를 끌어오면 대화가 많은 학생일수록
    # 느려진다(이 경로는 "새 대화"를 누를 때마다 돈다).
    assert 조회["limit"] == "1"


@pytest.mark.asyncio
async def test_그린_것이_있으면_빈_대화가_아니다():
    """사용자 지시 2026-08-10 — 그리기만 한 방을 재사용하면 안 된다.

    판정이 `canvas_items`·`files`·`nodes`만 봤다. 그런데 **그리기만** 한 방은
    셋 다 0이다 — 카드도 파일도 턴도 없이 획만 있다. 그 방을 재사용하면
    "새 대화"를 눌렀는데 **어제 그린 그림이 그대로 있는 방**이 열린다.

    실측 2026-08-10: 노드 0·카드 0인데 그림 요소 16개인 방이 재사용됐고,
    손글씨 e2e가 "한 획을 그으면 1획"에서 13을 받았다.
    """
    c = FakeClient(recent=[빈대화()], drawings=[{"elements": [{"type": "freedraw"}]}])
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "new-session", "그림이 있는데 재사용했다"


@pytest.mark.asyncio
async def test_그림_행이_비어_있으면_여전히_빈_대화다():
    """⚠️ 행이 **있는 것**만으로 판단하면 안 된다.

    처음 저장될 때 빈 배열로 행이 먼저 생긴다 — 그걸 "그렸다"로 읽으면 D202가
    통째로 무력해져 빈 대화가 다시 쌓인다.
    """
    c = FakeClient(recent=[빈대화()], drawings=[{"elements": []}])
    out = await svc.create_session(c, OWNER, "personal", None, None)
    assert out["id"] == "empty-1", "빈 그림 행 때문에 새로 만들었다"
