"""D83 — 업로드 세션 연결(session_id) 검증·세션 파일 목록 테스트.

세션 소유자만 자기 세션에 user_upload를 연결할 수 있고(class_material 불가),
세션의 공간과 업로드 폼 공간이 일치해야 한다. 목록은 kind=user_upload 한정.
"""

import pytest
from fastapi import HTTPException

from app.services import files as F


class _FakeService:
    def __init__(self):
        self.storage = []
        self.inserts = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserts.append((table, row))
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    """sessions 조회에 지정된 행을 돌려주고, 그 외 select는 멤버십 통과."""

    def __init__(self, session_row=None):
        self.session_row = session_row
        self.selects = []

    async def select(self, table, params):
        self.selects.append((table, params))
        if table == "sessions":
            return [dict(self.session_row)] if self.session_row else []
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _overlay():
    return {}


def _sess(owner="u1", kind="personal", ref="u1"):
    return {"id": "s1", "owner_id": owner, "space_kind": kind, "space_ref": ref}


@pytest.mark.asyncio
async def test_session_id_with_class_material_422(monkeypatch):
    """① session_id는 user_upload 전용 — class_material이면 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(_sess()), "u1", "class", "c1",
            "a.pdf", None, b"x", kind="class_material", session_id="s1",
        )
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_session_not_found_404(monkeypatch):
    """② 세션이 없거나 RLS로 안 보이면 404."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(None), "u1", "personal", None,
            "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_session_owner_mismatch_403(monkeypatch):
    """③ 세션 소유자 ≠ 업로더 → 403 (교사는 학생 세션을 SELECT할 수 있어
    RLS만으론 부족 — 명시 비교)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(), _FakeUserClient(_sess(owner="other")), "u1",
            "personal", None, "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_session_space_mismatch_422(monkeypatch):
    """④ 세션 공간과 업로드 폼 공간 불일치 → 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            _FakeService(),
            _FakeUserClient(_sess(kind="class", ref="c9")), "u1",
            "personal", None, "a.pdf", None, b"x", session_id="s1",
        )
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_upload_with_session_saves_link(monkeypatch):
    """⑤ 정상 — files 행에 session_id가 실린다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(_sess()), "u1", "personal", None,
        "노트.pdf", None, b"x", session_id="s1",
    )
    assert row["session_id"] == "s1"
    files_rows = [r for t, r in svc.inserts if t == "files"]
    assert files_rows and files_rows[0]["session_id"] == "s1"


@pytest.mark.asyncio
async def test_upload_without_session_unchanged(monkeypatch):
    """⑥ session_id 미지정 시 기존 동작(연결 없음) — 회귀 가드."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(), "u1", "personal", None, "a.pdf", None, b"x",
    )
    assert row.get("session_id") is None


@pytest.mark.asyncio
async def test_list_session_files_filters():
    """⑦ 세션 파일 목록 — session_id·kind=user_upload 필터, 업로드 순."""
    client = _FakeUserClient()
    await F.list_session_files(client, "s1")
    table, params = client.selects[-1]
    assert table == "files"
    assert params["session_id"] == "eq.s1"
    assert params["kind"] == "eq.user_upload"
    assert params["order"] == "created_at.asc"
