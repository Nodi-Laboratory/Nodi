"""D77 — kind별 업로드 용량 상한 테스트.

실제 기본값(50MB/500MB)만큼 큰 페이로드는 느리므로, settings 속성을 clamp
하한 근처로 monkeypatch해 경계만 검증한다(클램프가 오버레이·기본값 공통
적용이라 오버레이 소값 주입은 불가).
"""

import pytest
from fastapi import HTTPException

from app.services import files as F

MB = 1024 * 1024


class _FakeService:
    def __init__(self):
        self.storage = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        # D110: 실제 insert는 **단건이면 dict**를 돌려준다. 대역이 list를
        # 돌려주던 탓에 `rows[0]` 버그(업로드 500)가 테스트를 통과했다.
        return dict(row) if returning and isinstance(row, dict) else None


class _FakeUserClient:
    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _overlay():
    return {}


def test_default_limits():
    """스펙 기본값 — 학생 50MB, 학급 자료 500MB."""
    assert F.settings.file_max_bytes == 50 * MB
    assert F.settings.class_material_max_bytes == 500 * MB


def test_resolve_limit_by_kind():
    """① kind별 해석 — class_material만 대용량 노브를 탄다."""
    assert F.resolve_upload_max_bytes({}, "user_upload") == 50 * MB
    assert F.resolve_upload_max_bytes({}, "class_material") == 500 * MB


@pytest.mark.asyncio
async def test_user_upload_over_limit_413(monkeypatch):
    """② user_upload 상한 초과 → 413, 스토리지 업로드 전 거절."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", 2048)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "u1", "personal", None,
            "big.pdf", None, b"\0" * 4096,
        )
    assert ei.value.status_code == 413
    assert svc.storage == []


@pytest.mark.asyncio
async def test_class_material_uses_own_larger_limit(monkeypatch):
    """③ class_material은 file_max_bytes를 넘어도 자기 상한 이내면 통과."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", 2048)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(), "t1", "class", "c1",
        "book.pdf", None, b"\0" * 4096, kind="class_material",
    )
    assert row["status"] == "uploaded"
    assert len(svc.storage) == 1


@pytest.mark.asyncio
async def test_class_material_over_own_limit_413(monkeypatch):
    """④ class_material 자기 상한 초과 → 413 (clamp 하한 1MB로 검증)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "class_material_max_bytes", MB)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "t1", "class", "c1",
            "book.pdf", None, b"\0" * (MB + 1), kind="class_material",
        )
    assert ei.value.status_code == 413


@pytest.mark.asyncio
async def test_oversized_image_rejected_422(monkeypatch):
    """⑤ 이미지는 분할 불가 — class_material이어도 파서 리밋 초과 시 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F, "UPSTAGE_PARSE_MAX_BYTES", 1024)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "t1", "class", "c1",
            "scan.png", None, b"\0" * 2048, kind="class_material",
        )
    assert ei.value.status_code == 422
    assert "이미지" in ei.value.detail
    assert svc.storage == []


# --- D188: 거절 문구가 교사에게 쓸모 있어야 한다 ----------------------------
#
# 같은 판정이 **두 곳**에 있다 — 라우터가 선언 크기로 먼저 자르고(본문 버퍼링
# 회피), 서비스가 실제 바이트로 다시 확인한다. 실제로 서비스만 고쳤다가
# 라우터가 먼저 거절해 **아무것도 안 바뀐 것처럼 보였다**(실측 2026-08-06).


def test_거절_문구는_MB로_말한다():
    """`File exceeds 52428800 bytes.`를 보고 자기 파일 크기를 가늠할 수 없다."""
    msg = F.too_large_detail(60 * MB, 50 * MB)
    assert "60MB" in msg
    assert "50MB" in msg
    assert "bytes" not in msg


def test_라우터와_서비스가_같은_문구를_쓴다():
    """둘이 갈리면 어느 쪽이 먼저 거절하느냐에 따라 학생이 보는 말이 달라진다."""
    from app.routers import files as R

    assert R.svc.too_large_detail is F.too_large_detail


@pytest.mark.asyncio
async def test_서비스가_거절할_때도_한국어다(monkeypatch):
    """라우터가 선언 크기를 못 봤을 때(멀티파트에 길이가 없으면) 여기가 잡는다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", MB)
    with pytest.raises(HTTPException) as exc:
        await F.upload_file(
            _FakeService(), _FakeUserClient(), "u1", "personal", None,
            "큰파일.pdf", None, b"\0" * (MB + 1),
        )
    assert exc.value.status_code == 413
    assert "MB까지 올릴 수 있습니다" in exc.value.detail
    assert "bytes" not in exc.value.detail
