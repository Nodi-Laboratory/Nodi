"""D83·D84·D85 — 세션 파일 전문 주입 빌더·프롬프트 블록 테스트."""

import pytest

from app.services import session_context as SC
from app.services.gemini import compose_system_structured


class _FakeClient:
    def __init__(self, files=None, chunks=None, raise_on=None):
        self.files = files or []
        self.chunks = chunks or {}
        self.raise_on = raise_on

    async def select(self, table, params):
        if self.raise_on == table:
            raise RuntimeError("boom")
        if table == "files":
            return [dict(f) for f in self.files]
        if table == "file_chunks":
            fid = params["file_id"].removeprefix("eq.")
            return [dict(c) for c in self.chunks.get(fid, [])]
        return []


async def _overlay():
    return {}


@pytest.fixture(autouse=True)
def _patch_overlay(monkeypatch):
    monkeypatch.setattr(SC.app_settings, "get_overlay", _overlay)


@pytest.mark.asyncio
async def test_builds_fulltext_in_seq_order():
    """① 청크를 seq 순으로 이어붙여 파일명 헤더와 함께 블록을 만든다."""
    client = _FakeClient(
        files=[{"id": "f1", "name": "노트.pdf", "context_chars": 9,
                "created_at": "t1"}],
        chunks={"f1": [{"seq": 0, "chunk_text": "안녕"},
                       {"seq": 1, "chunk_text": "하세요"}]},
    )
    result = await SC.build_session_file_context(client, "s1")
    assert result is not None
    assert "[세션 파일: 노트.pdf]\n안녕하세요" in result["block"]
    assert result["files"] == [
        {"file_id": "f1", "name": "노트.pdf", "chars": 5}
    ]


@pytest.mark.asyncio
async def test_no_files_returns_none():
    """② 세션 파일 없음 → None (블록 미주입)."""
    assert await SC.build_session_file_context(_FakeClient(), "s1") is None


@pytest.mark.asyncio
async def test_failure_returns_none():
    """③ 조회 실패 → None (채팅 불중단 불변식)."""
    client = _FakeClient(raise_on="files")
    assert await SC.build_session_file_context(client, "s1") is None


@pytest.mark.asyncio
async def test_budget_double_guard_excludes_whole_file(monkeypatch):
    """④ D84 이중 방어 — 합산 초과 파일은 부분 절단 없이 통째 제외."""
    monkeypatch.setattr(SC.settings, "session_context_max_chars", 10_000)
    client = _FakeClient(
        files=[
            {"id": "f1", "name": "a.txt", "context_chars": 9_000,
             "created_at": "t1"},
            {"id": "f2", "name": "b.txt", "context_chars": 5_000,
             "created_at": "t2"},
        ],
        chunks={
            "f1": [{"seq": 0, "chunk_text": "가" * 9_000}],
            "f2": [{"seq": 0, "chunk_text": "나" * 5_000}],
        },
    )
    result = await SC.build_session_file_context(client, "s1")
    assert result is not None
    names = [f["name"] for f in result["files"]]
    assert names == ["a.txt"]  # f2는 예산 초과로 제외
    assert "나" not in result["block"]


def test_compose_session_block_after_system_base():
    """⑤ D85 — session_files 블록이 system_base 직후, span 정합."""
    prompt, blocks = compose_system_structured(
        None,
        session_file_context="파일 전문",
        session_file_sources=[{"file_id": "f1", "name": "노트.pdf", "chars": 5}],
        base_instruction="BASE",
    )
    kinds = [b["kind"] for b in blocks]
    assert kinds == ["system_base", "session_files"]
    s, e = blocks[1]["prompt_span"]
    assert prompt[s:e].endswith("파일 전문")
    assert blocks[1]["sources"][0]["file_id"] == "f1"


def test_compose_without_session_block_unchanged():
    """⑥ session_files 없이 rag만 있을 때의 블록 구성.

    D107: memory_link·comparison 블록은 제거됐다 — 남는 것은 base와 rag뿐이다.
    """
    prompt, blocks = compose_system_structured("rag")
    assert [b["kind"] for b in blocks] == ["system_base", "rag"]
