"""D75 — 업로드 형식 화이트리스트 테스트.

_extract_text가 실제로 처리 가능한 형식(pdf/이미지/텍스트)만 수락하고,
그 외(zip/docx/확장자 없음)는 스토리지 업로드 전에 422로 거절한다.
"""

import pytest
from fastapi import HTTPException

from app.services import files as F


class _FakeService:
    def __init__(self):
        self.storage = []
        self.inserted = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        # D110: 실제 insert는 **단건이면 dict**를 돌려준다. 대역이 list를
        # 돌려주던 탓에 `rows[0]` 버그(업로드 500)가 테스트를 통과했다.
        return dict(row) if returning and isinstance(row, dict) else None


class _FakeUserClient:
    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _fake_overlay():
    return {}


async def _upload(svc, name, mime=None):
    return await F.upload_file(
        svc, _FakeUserClient(), "u1", "personal", None, name, mime, b"data"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["archive.zip", "report.docx", "한글.hwp", "noext"])
async def test_unsupported_format_rejected_422(monkeypatch, name):
    """⑥ 미지원 형식은 422 + 한국어 사유, 스토리지 업로드 전에 거절."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await _upload(svc, name)
    assert ei.value.status_code == 422
    assert "지원 형식" in ei.value.detail
    assert svc.storage == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name",
    ["doc.pdf", "scan.PNG", "photo.jpg", "img.jpeg", "pic.webp", "ani.gif",
     "메모.txt", "note.md"],
)
async def test_supported_format_accepted(monkeypatch, name):
    """화이트리스트 형식(대소문자 무관)은 기존 흐름대로 업로드된다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    row = await _upload(svc, name)
    assert row["status"] == "uploaded"
    assert len(svc.storage) == 1
    assert any(t == "jobs" for t, _ in svc.inserted)  # split 잡 큐잉 유지
