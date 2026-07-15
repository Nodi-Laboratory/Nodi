"""D79 — 스토리지 키 ASCII 강제 + 원본 파일명 name 컬럼 보존 테스트.

한글/공백/괄호가 섞인 파일명이라도 스토리지 키는 ASCII-only가 되어 Supabase
Storage의 InvalidKey(400)를 피하고, 표시명(NFC 원본)은 files.name에 보존된다.
storage_upload 실패는 500 트레이스 대신 502로 변환된다.
"""

import re
import unicodedata

import pytest
from fastapi import HTTPException

from app.services import files as F
from app.services import rag as R

# 키 마지막 세그먼트가 만족해야 하는 ASCII 허용 집합(요구사항 D79).
_ASCII_KEY = re.compile(r"^[A-Za-z0-9._()\- ]+$")


class _FakeService:
    def __init__(self, storage_error=None):
        self.storage = []
        self.inserted = []
        self._storage_error = storage_error

    async def storage_upload(self, bucket, path, data, mime):
        if self._storage_error is not None:
            raise self._storage_error
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _fake_overlay():
    return {}


async def _upload(svc, name, mime="application/pdf"):
    return await F.upload_file(
        svc, _FakeUserClient(), "u1", "personal", None, name, mime, b"data"
    )


@pytest.mark.asyncio
async def test_korean_filename_key_ascii_and_name_preserved(monkeypatch):
    """한글+공백+괄호 파일명: 키는 ASCII-only(.pdf 유지), name은 NFC 원본."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    name = "도전제안서 (루키)_애벌레팀.pdf"
    row = await _upload(svc, name)
    # ① 스토리지 키 마지막 세그먼트는 ASCII-only + .pdf 확장자 유지.
    assert len(svc.storage) == 1
    seg = svc.storage[0].split("/")[-1]
    assert _ASCII_KEY.match(seg), seg
    assert seg.endswith(".pdf")
    # ② files 행 name == NFC 정규화된 원본 표시명.
    assert row["name"] == unicodedata.normalize("NFC", name)


@pytest.mark.asyncio
async def test_ascii_filename_key_unchanged(monkeypatch):
    """ASCII 파일명(공백·괄호 포함)은 키에 원형 유지 — 회귀 없음."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    row = await _upload(svc, "lesson (1).pdf")
    seg = svc.storage[0].split("/")[-1]
    assert seg == "lesson (1).pdf"
    assert row["name"] == "lesson (1).pdf"


@pytest.mark.asyncio
async def test_storage_upload_failure_maps_to_502(monkeypatch):
    """storage_upload 예외 → 502 HTTPException, files insert 미발생."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService(storage_error=RuntimeError("InvalidKey"))
    with pytest.raises(HTTPException) as ei:
        await _upload(svc, "test.pdf")
    assert ei.value.status_code == 502
    assert not any(t == "files" for t, _ in svc.inserted)


class _FakeNamesClient:
    def __init__(self, rows):
        self._rows = rows

    async def select(self, table, params):
        return self._rows


@pytest.mark.asyncio
async def test_file_names_prefers_name_with_basename_fallback():
    """_file_names: name 있으면 name, 없으면(구파일) basename 폴백."""
    rows = [
        {"id": "f1", "name": "도전제안서 (루키).pdf", "storage_path": "u1/f1/_ (_).pdf"},
        {"id": "f2", "name": None, "storage_path": "u1/f2/old_report.pdf"},
    ]
    names = await R._file_names(_FakeNamesClient(rows), ["f1", "f2"])
    assert names["f1"] == "도전제안서 (루키).pdf"
    assert names["f2"] == "old_report.pdf"
