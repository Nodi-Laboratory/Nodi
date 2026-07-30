"""D104-5 — 파일시스템 저장소.

구 Supabase Storage(HTTP)를 대체한다. 검증 초점:
  1. 업로드·다운로드·삭제 왕복과 멱등성
  2. **경로 탈출 차단** — 경로에 사용자 입력(소유자·파일 id)이 들어간다
  3. signed URL의 서명·만료 — 위조·기간만료 토큰을 통과시키지 않는다
"""

import time

import pytest

from app.db import storage as S


@pytest.fixture(autouse=True)
def _tmp_root(tmp_path, monkeypatch):
    """저장소 루트를 테스트마다 임시 폴더로 — 실제 .storage를 건드리지 않는다."""
    monkeypatch.setattr(S.settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(S.settings, "storage_sign_secret", "test-secret")


# --- 왕복 -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_download_roundtrip():
    await S.upload("files", "u1/f1/doc.pdf", b"hello", "application/pdf")
    assert await S.download("files", "u1/f1/doc.pdf") == b"hello"


@pytest.mark.asyncio
async def test_upload_overwrites():
    await S.upload("files", "u1/a.txt", b"first", "text/plain")
    await S.upload("files", "u1/a.txt", b"second", "text/plain")
    assert await S.download("files", "u1/a.txt") == b"second"


@pytest.mark.asyncio
async def test_download_missing_raises():
    with pytest.raises(S.StorageError):
        await S.download("files", "u1/none.txt")


@pytest.mark.asyncio
async def test_delete_is_idempotent():
    """없는 파일 삭제가 실패하면 워커 재시도가 그 지점에서 계속 죽는다."""
    await S.upload("files", "u1/x.txt", b"x", "text/plain")
    await S.delete("files", "u1/x.txt")
    await S.delete("files", "u1/x.txt")  # 두 번째도 조용히 성공


@pytest.mark.asyncio
async def test_nested_paths_are_created():
    await S.upload("files", "a/b/c/d/deep.bin", b"z", "application/octet-stream")
    assert await S.download("files", "a/b/c/d/deep.bin") == b"z"


# --- 경로 탈출 차단 ----------------------------------------------------------


@pytest.mark.parametrize("evil", [
    "../../../etc/passwd",
    "u1/../../outside.txt",
    "u1/../../../../../../tmp/x",
])
@pytest.mark.asyncio
async def test_path_traversal_is_rejected(evil):
    """`..`로 루트 밖 파일을 읽거나 덮어쓰는 경로를 만들지 않는다."""
    with pytest.raises(S.StorageError):
        await S.upload("files", evil, b"pwned", "text/plain")
    with pytest.raises(S.StorageError):
        await S.download("files", evil)


@pytest.mark.asyncio
async def test_bucket_traversal_is_rejected():
    with pytest.raises(S.StorageError):
        await S.upload("../..", "x.txt", b"pwned", "text/plain")


# --- signed URL --------------------------------------------------------------


@pytest.mark.asyncio
async def test_sign_then_verify():
    url = await S.sign("files", "u1/f1/p.png", 3600)
    # /api 접두사 포함 — 브라우저 img src에서 Next rewrite(/api/*)를 타야 한다.
    assert url.startswith("/api/files/blob/files/u1/f1/p.png?")
    exp = int(url.split("exp=")[1].split("&")[0])
    sig = url.split("sig=")[1]
    assert S.verify("files", "u1/f1/p.png", exp, sig) is True


@pytest.mark.asyncio
async def test_verify_rejects_tampered_path():
    """서명은 경로에 묶인다 — 다른 파일로 바꿔치기할 수 없다."""
    url = await S.sign("files", "u1/mine.png", 3600)
    exp = int(url.split("exp=")[1].split("&")[0])
    sig = url.split("sig=")[1]
    assert S.verify("files", "u2/yours.png", exp, sig) is False


@pytest.mark.asyncio
async def test_verify_rejects_expired():
    url = await S.sign("files", "u1/p.png", 1)
    exp = int(url.split("exp=")[1].split("&")[0])
    sig = url.split("sig=")[1]
    # 만료 시각을 과거로 바꾸면(서명도 그에 맞게 다시 만들어도) 거부돼야 한다.
    past = int(time.time()) - 10
    assert S.verify("files", "u1/p.png", past, S._signature("files", "u1/p.png", past)) is False
    assert S.verify("files", "u1/p.png", exp, sig) is True


@pytest.mark.asyncio
async def test_verify_rejects_forged_signature():
    exp = int(time.time()) + 600
    assert S.verify("files", "u1/p.png", exp, "0" * 32) is False


@pytest.mark.asyncio
async def test_sign_does_not_require_file_to_exist():
    """서명은 존재 확인이 아니다 — 발급 시점에 파일이 없어도 URL은 나온다."""
    url = await S.sign("files", "not/yet/there.png", 60)
    assert "sig=" in url


# --- 서빙 라우트 (2026-07-30: sign만 있고 소비 라우트가 없어 figure가 전부
#     404 → 캔버스 무한 로딩이던 결함의 회귀 방지) ---------------------------


@pytest.mark.asyncio
async def test_blob_route_serves_signed_file():
    from fastapi import HTTPException

    from app.routers import files as R

    await S.upload("files", "u1/f1/figures/p1_e1.jpg", b"\xff\xd8jpg", "image/jpeg")
    url = await S.sign("files", "u1/f1/figures/p1_e1.jpg", 3600)
    assert url.startswith("/api/files/blob/")
    exp = int(url.split("exp=")[1].split("&")[0])
    sig = url.split("sig=")[1]

    resp = await R.serve_blob("files", "u1/f1/figures/p1_e1.jpg", exp, sig)
    assert resp.body == b"\xff\xd8jpg"
    assert resp.media_type == "image/jpeg"

    # 위조 서명 → 403 (로그인 없이도 서명이 인증을 대신하므로 반드시 검증)
    with pytest.raises(HTTPException) as ei:
        await R.serve_blob("files", "u1/f1/figures/p1_e1.jpg", exp, "0" * 32)
    assert ei.value.status_code == 403

    # 서명은 맞는데 파일이 없음 → 404
    url2 = await S.sign("files", "u1/f1/none.jpg", 3600)
    exp2 = int(url2.split("exp=")[1].split("&")[0])
    sig2 = url2.split("sig=")[1]
    with pytest.raises(HTTPException) as ei:
        await R.serve_blob("files", "u1/f1/none.jpg", exp2, sig2)
    assert ei.value.status_code == 404
