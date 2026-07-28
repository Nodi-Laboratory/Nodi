"""D110 — 업로드 happy path 회귀.

기존 업로드 테스트는 **거절 경로만** 태웠다(형식 화이트리스트·용량 상한). 그래서
D104에서 데이터 계층을 asyncpg로 갈아끼울 때 생긴 반환 타입 변화를 아무도 못
잡았고, 교사 자료 업로드가 `KeyError: 0`으로 계속 500이었다.

`insert`에 dict를 주면 dict가 돌아온다(list가 아니다). 그 계약을 여기서 고정한다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services import files as F


class _FakeUserClient:
    """소유권·정원 검사만 통과시키는 최소 대역."""

    def __init__(self) -> None:
        self.selects: list[tuple[str, dict]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.selects.append((table, params))
        if table == "class_members":
            return [{"class_id": "c1", "role": "teacher"}]
        if table == "classes":
            return [{"id": "c1", "owner_id": "u1"}]
        if table == "sessions":
            return [{
                "id": "s1", "owner_id": "u1",
                "space_kind": "personal", "space_ref": "u1",
            }]
        return []

    async def rpc(self, fn: str, args: dict) -> Any:
        return True


class _FakeService:
    """insert의 **실제 반환 계약**을 흉내 낸다 — dict를 주면 dict가 나온다."""

    def __init__(self) -> None:
        self.inserted: list[tuple[str, Any]] = []
        self.uploaded: list[tuple[str, str, int]] = []

    async def storage_upload(self, bucket: str, path: str, data: bytes, mime) -> None:
        self.uploaded.append((bucket, path, len(data)))

    async def insert(self, table: str, rows, *, returning: bool = True):
        self.inserted.append((table, rows))
        if not returning:
            return []
        if isinstance(rows, dict):
            return dict(rows)  # ← 단건은 dict (list 아님)
        return [dict(r) for r in rows]


@pytest.fixture
def _no_gate(monkeypatch):
    """업로드 정책 조회(app_settings)를 기본값으로 고정."""

    async def overlay():
        return {}

    monkeypatch.setattr(F.app_settings, "get_overlay", overlay)


async def test_학생_개인_업로드가_파일_행을_돌려준다(_no_gate):
    svc, client = _FakeService(), _FakeUserClient()
    row = await F.upload_file(
        svc, client, "u1", "personal", None,
        "메모.txt", "text/plain", "광합성 정리".encode(),
        kind="user_upload", session_id="s1",
    )
    # 예전에는 여기서 KeyError: 0으로 500이 났다.
    assert row["id"]
    assert row["status"] == "uploaded"
    assert row["name"] == "메모.txt"
    assert row["session_id"] == "s1"


async def test_업로드하면_split_잡이_큐에_들어간다(_no_gate):
    svc, client = _FakeService(), _FakeUserClient()
    await F.upload_file(
        svc, client, "u1", "personal", None, "메모.txt", "text/plain", b"hello",
    )
    tables = [t for t, _ in svc.inserted]
    assert tables == ["files", "jobs"]
    _, job = svc.inserted[1]
    assert job["kind"] == "embedding_split"
    assert job["status"] == "queued"


async def test_스토리지에_실제_바이트가_올라간다(_no_gate):
    svc, client = _FakeService(), _FakeUserClient()
    data = "본문".encode()
    await F.upload_file(
        svc, client, "u1", "personal", None, "a.txt", "text/plain", data,
    )
    assert svc.uploaded and svc.uploaded[0][2] == len(data)


async def test_한글_파일명은_표시용과_저장키가_갈린다(_no_gate):
    """D79: 저장 키는 ASCII-only, 표시 이름은 원본 보존."""
    svc, client = _FakeService(), _FakeUserClient()
    row = await F.upload_file(
        svc, client, "u1", "personal", None, "한글 자료.txt", "text/plain", b"x",
    )
    assert row["name"] == "한글 자료.txt"
    assert row["storage_path"].isascii()
