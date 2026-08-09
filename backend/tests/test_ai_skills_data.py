"""D109 2단계 — 세션 파일·개념 조회 스킬.

이 스킬들의 결과는 곧 **다음 LLM 호출의 입력**이다. 그래서 검증 관점이 둘이다:
  1. 내용이 맞는가
  2. **양이 통제되는가** — 예전의 "매 턴 15만 자 주입"으로 돌아가면 안 된다
"""

from __future__ import annotations

from typing import Any

from app.ai.base import SkillContext
from app.ai.skills import search_class_material as scm
from app.ai.skills.concepts import GetConceptSkill
from app.ai.skills.search_class_material import SearchClassMaterialSkill
from app.ai.skills.session_files import (
    ListSessionFilesSkill,
    ReadSessionFileSkill,
)


def _card(title: str, tag: str, body: str, seq: int) -> dict[str, Any]:
    """`canvas_items` 행 한 장 — 지금 화면에 있는 그대로다."""
    return {
        "id": f"i{seq}",
        "title": title,
        "body": body,
        "tag": tag,
        "seq": seq,
        "kind": "concept",
        "source": "ai",
    }


CARDS = [
    _card("광합성", "식물의 생명 활동", "식물이 빛으로 포도당을 만들어요.\n\n산소가 나와요.", 1),
    _card("세포호흡", "식물의 생명 활동", "포도당을 분해해 에너지를 얻어요.", 2),
    _card("엽록체", "세포 소기관", "광합성이 일어나는 곳이에요.", 3),
]


class _Client:
    """select만 흉내 내는 대역. 테이블별로 준비된 행을 돌려준다."""

    def __init__(self, nodes=None, files=None, chunks=None, items=None):
        self._nodes = nodes or []
        self._files = files or []
        self._chunks = chunks or []
        self._items = items or []
        self.calls: list[tuple[str, dict]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.calls.append((table, params))
        return {
            "nodes": self._nodes,
            "files": self._files,
            "file_chunks": self._chunks,
            "canvas_items": self._items,
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


# --- 개념 스킬 (출처: canvas_items) ----------------------------------------
#
# ⚠️ 예전에는 `nodes.answer` 원문을 파싱했다. 지금 정본은 `canvas_items`다 —
# 학생이 본문을 고치고, 분류를 바꾸고, 카드를 지우기 때문이다(D122·D135·D147).
# 원문을 읽으면 그 셋 중 무엇도 안 보인다.


async def test_카드가_없으면_없다고_알려준다():
    res = await GetConceptSkill().run({"title": "광합성"}, _ctx(_Client()))
    assert res.ok
    assert res.data["found"] is False


async def test_AI_개념_카드만_읽는다():
    """도판·클립·학생 글이 섞이면 모델이 "이미 있는 개념"으로 오해한다."""
    c = _Client(items=CARDS)
    await GetConceptSkill().run({"title": "광합성"}, _ctx(c))
    table, params = c.calls[0]
    assert table == "canvas_items"
    assert params["kind"] == "eq.concept"
    assert params["source"] == "eq.ai"
    assert params["session_id"] == "eq.s1"


async def test_제목이_정확히_맞으면_본문을_준다():
    """**문단 본문**이 그대로 온다.

    옛 파서는 `- `로 시작하는 줄만 주웠다. 지금 프롬프트는 "설명을 목록으로
    쪼개지 마라"라 본문이 문단이고, 그래서 본문이 **늘 비어 있었다**
    (실측 2026-08-09: 지금 형식의 카드에서 본문 줄 수 0).
    """
    c = _Client(items=CARDS)
    res = await GetConceptSkill().run({"title": "광합성"}, _ctx(c))
    assert res.data["found"] is True
    assert res.data["cluster"] == "식물의 생명 활동"
    assert "포도당" in res.data["body"]
    assert "산소" in res.data["body"], "문단이 둘이면 둘 다 와야 한다"


async def test_학생이_고친_글이_온다():
    """학생이 캔버스에서 고친 뒤의 글이 곧 "아까 그거"다."""
    고친것 = [_card("광합성", "내가 만든 분류", "내가 고쳐 쓴 설명이다.", 1)]
    res = await GetConceptSkill().run({"title": "광합성"}, _ctx(_Client(items=고친것)))
    assert res.data["body"] == "내가 고쳐 쓴 설명이다."
    assert res.data["cluster"] == "내가 만든 분류"


async def test_제목이_조금_달라도_찾는다():
    # 모델이 제목을 정확히 기억하지 못하는 일이 흔하다.
    c = _Client(items=CARDS)
    res = await GetConceptSkill().run({"title": "광합성 과정"}, _ctx(c))
    assert res.data["found"] is True


async def test_못_찾으면_있는_제목을_알려준다():
    """헛물을 켜지 않게 후보를 준다 — 없다고만 하면 다시 헤맨다."""
    c = _Client(items=CARDS)
    res = await GetConceptSkill().run({"title": "미분"}, _ctx(c))
    assert res.ok
    assert res.data["found"] is False
    assert res.data["available"] == ["광합성", "세포호흡", "엽록체"]


async def test_빈_제목은_거절한다():
    res = await GetConceptSkill().run({"title": "  "}, _ctx(_Client()))
    assert res.ok is False
    assert res.error_code == "bad_args"


async def test_제목이_빈_카드는_안_집힌다():
    """제목 없는 행(도판 등)이 섞이면 **무엇을 찾든** 그게 걸린다.

    부분 일치가 `want in c["title"] or c["title"] in want`인데 빈 문자열은
    어떤 문자열에도 들어 있다 — 거르지 않으면 본문 없는 카드가 답이 된다.
    """
    섞임 = [*CARDS, _card("", "", "제목 없는 무엇", 4)]
    res = await GetConceptSkill().run({"title": "엽록체"}, _ctx(_Client(items=섞임)))
    assert res.data["title"] == "엽록체"


# --- 세션 파일 -------------------------------------------------------------


async def test_파일_목록은_이름과_분량만_준다():
    """본문은 주지 않는다 — 목록은 싸야 한다."""
    c = _Client(files=[{"id": "f1", "name": "노트.pdf", "context_chars": 12000}])
    res = await ListSessionFilesSkill().run({}, _ctx(c))
    assert res.data["files"] == [{"file_id": "f1", "name": "노트.pdf", "chars": 12000}]
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
    res = await ReadSessionFileSkill().run({"file_id": "f1", "from_char": 3000}, _ctx(c))
    assert res.data["from_char"] == 3000
    assert res.data["eof"] is True
    assert len(res.data["text"]) == 1000


async def test_이_세션의_파일이_아니면_거절한다():
    """file_id만 믿고 읽으면 같은 소유자의 다른 세션 파일이 새어 나간다."""
    c = _Client(files=[{"id": "f1", "name": "내 파일", "context_chars": 10}])
    res = await ReadSessionFileSkill().run({"file_id": "다른파일"}, _ctx(c))
    assert res.ok is False
    assert res.error_code == "not_found"


# --- search_class_material: 이중 검색 배선(D129) ---------------------------


def _class_ctx() -> SkillContext:
    return SkillContext(
        user_id="u1",
        client=object(),  # rag 함수는 전부 patch되므로 실제 client는 안 쓴다
        session_id="s1",
        space_kind="class",
        space_ref="class-1",
        role="student",
    )


def _wire_rag(monkeypatch, *, overlay, search_rows=None, dual_rows=None):
    """스킬이 부르는 rag 표면을 전부 기록 fake로 대체. 어느 검색을 불렀는지
    calls에 남긴다."""
    calls: dict[str, Any] = {"search": None, "dual": None}

    async def fake_overlay():
        return overlay

    async def fake_file_ids(_client, _ref):
        return ["f1"]

    async def fake_search(_client, file_ids, query, *a, **kw):
        calls["search"] = {"file_ids": file_ids, "query": query}
        return list(search_rows or [])

    async def fake_dual(_client, file_ids, query, *a, **kw):
        calls["dual"] = {"file_ids": file_ids, "query": query}
        return list(dual_rows or [])

    async def fake_names(_client, ids):
        return {i: f"자료-{i}" for i in ids}

    def fake_sources(chunks, names):
        return [{"id": c.get("file_id")} for c in chunks]

    monkeypatch.setattr(scm.app_settings, "get_overlay", fake_overlay)
    monkeypatch.setattr(scm.rag, "class_material_file_ids", fake_file_ids)
    monkeypatch.setattr(scm.rag, "search", fake_search)
    monkeypatch.setattr(scm.rag, "dual_search", fake_dual)
    monkeypatch.setattr(scm.rag, "file_names", fake_names)
    monkeypatch.setattr(scm.rag, "build_sources", fake_sources)
    return calls


async def test_원자검색_켜지면_dual_search를_부른다(monkeypatch):
    overlay = {"class_material_rag_enabled": True, "atom_rag_enabled": True}
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        dual_rows=[
            {"file_id": "f1", "chunk_text": "직접 히트", "distance": 0.3, "via": "chunk"},
            # 원자 경유 행 — distance None. round()에서 죽지 않아야 한다.
            {"file_id": "f1", "chunk_text": "원자 히트", "distance": None, "via": "atom"},
        ],
    )
    res = await SearchClassMaterialSkill().run({"query": "A와 B의 차이는?"}, _class_ctx())
    assert res.ok
    # dual만 불리고 search는 안 불린다.
    assert calls["dual"] is not None
    assert calls["search"] is None
    assert calls["dual"]["query"] == "A와 B의 차이는?"
    # 원자 경유 행(distance None)도 살아남아 2곳이 잡힌다(재게이트 금지).
    assert len(res.data["chunks"]) == 2
    # distance None은 items 조립에서 None으로 나가고 죽지 않는다.
    dists = [c["distance"] for c in res.data["chunks"]]
    assert 0.3 in dists
    assert None in dists


async def test_원자검색_꺼지면_기존_search와_거리게이트를_쓴다(monkeypatch):
    overlay = {
        "class_material_rag_enabled": True,
        "atom_rag_enabled": False,
        "class_material_rag_max_distance": 0.60,
    }
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        search_rows=[
            {"file_id": "f1", "chunk_text": "가까움", "distance": 0.3},
            {"file_id": "f1", "chunk_text": "멀다", "distance": 0.8},  # 게이트에 걸린다
            {"file_id": "f1", "chunk_text": "거리없음", "distance": None},  # 걸린다
        ],
    )
    res = await SearchClassMaterialSkill().run({"query": "광합성이란?"}, _class_ctx())
    assert res.ok
    # search만 불리고 dual은 안 불린다.
    assert calls["search"] is not None
    assert calls["dual"] is None
    # 거리 게이트가 그대로 — 0.3만 통과.
    assert len(res.data["chunks"]) == 1
    assert res.data["chunks"][0]["distance"] == 0.3


# --- search_class_material: 검색어 정제(D130) ------------------------------


def _wire_refine(monkeypatch, *, refined=None, raises=False):
    """`scm.solar.complete`를 기록 fake로 대체. 호출 여부·전달 메시지를 남긴다."""
    import types

    calls: dict[str, Any] = {"count": 0, "messages": None}

    async def fake_complete(messages, *a, **kw):
        calls["count"] += 1
        calls["messages"] = messages
        if raises:
            raise RuntimeError("정제 실패")
        return types.SimpleNamespace(message={"content": refined})

    monkeypatch.setattr(scm.solar, "complete", fake_complete)
    return calls


async def test_정제_켜지면_정제문으로_검색한다(monkeypatch):
    overlay = {
        "class_material_rag_enabled": True,
        "atom_rag_enabled": False,
        "rag_query_rewrite_enabled": True,
    }
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        search_rows=[{"file_id": "f1", "chunk_text": "히트", "distance": 0.3}],
    )
    refine = _wire_refine(monkeypatch, refined="광합성에서 명반응은 어디서 일어나?")
    res = await SearchClassMaterialSkill().run({"query": "그거 어디서 일어나?"}, _class_ctx())
    assert res.ok
    # solar가 불렸고, 검색에는 정제문이 들어갔다.
    assert refine["count"] == 1
    assert calls["search"]["query"] == "광합성에서 명반응은 어디서 일어나?"


async def test_정제_꺼지면_원문으로_검색하고_solar_미호출(monkeypatch):
    overlay = {
        "class_material_rag_enabled": True,
        "atom_rag_enabled": False,
        "rag_query_rewrite_enabled": False,
    }
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        search_rows=[{"file_id": "f1", "chunk_text": "히트", "distance": 0.3}],
    )
    refine = _wire_refine(monkeypatch, refined="바뀐문장")
    res = await SearchClassMaterialSkill().run({"query": "광합성이란?"}, _class_ctx())
    assert res.ok
    # solar는 아예 안 불린다.
    assert refine["count"] == 0
    assert calls["search"]["query"] == "광합성이란?"


async def test_정제_예외면_원문으로_검색한다(monkeypatch):
    overlay = {
        "class_material_rag_enabled": True,
        "atom_rag_enabled": False,
        "rag_query_rewrite_enabled": True,
    }
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        search_rows=[{"file_id": "f1", "chunk_text": "히트", "distance": 0.3}],
    )
    refine = _wire_refine(monkeypatch, raises=True)
    res = await SearchClassMaterialSkill().run({"query": "광합성이란?"}, _class_ctx())
    assert res.ok
    # 예외를 삼키고 원문으로 검색.
    assert refine["count"] == 1
    assert calls["search"]["query"] == "광합성이란?"


async def test_정제_빈문자열이면_원문을_유지한다(monkeypatch):
    overlay = {
        "class_material_rag_enabled": True,
        "atom_rag_enabled": False,
        "rag_query_rewrite_enabled": True,
    }
    calls = _wire_rag(
        monkeypatch,
        overlay=overlay,
        search_rows=[{"file_id": "f1", "chunk_text": "히트", "distance": 0.3}],
    )
    refine = _wire_refine(monkeypatch, refined="   ")
    res = await SearchClassMaterialSkill().run({"query": "광합성이란?"}, _class_ctx())
    assert res.ok
    # 정제 결과가 공백뿐이면 원문 유지.
    assert refine["count"] == 1
    assert calls["search"]["query"] == "광합성이란?"
