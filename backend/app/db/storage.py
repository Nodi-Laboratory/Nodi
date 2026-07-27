"""파일 저장 — 로컬 파일시스템 (D104-5, 구 Supabase Storage 대체).

버킷·경로 규약은 그대로 유지한다(`<bucket>/<owner>/<file>/…`) — 호출부와 DB에
저장된 `storage_path`·`image_path` 값이 그대로 유효하다.

signed URL은 만료 있는 HMAC 토큰을 붙인 **우리 백엔드 경로**를 돌려준다. 교과서
도판은 이미 백엔드를 거쳐 서빙되므로(D87) 프론트 변경이 없다.

보안: 경로에 사용자 입력(파일 id·소유자 id)이 들어간다. 정규화 후 루트 밖으로
나가면 거부한다 — `..`로 임의 파일을 읽거나 덮어쓰는 경로를 만들지 않는다.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from pathlib import Path

from ..config import get_settings

logger = logging.getLogger("nodi.storage")
settings = get_settings()


class StorageError(Exception):
    """저장소 조작 실패 — 호출부가 best-effort로 처리한다."""


def _root() -> Path:
    root = Path(settings.storage_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve(bucket: str, path: str) -> Path:
    """버킷·경로 → 실제 파일 경로. **버킷 밖으로 나가면 거부한다.**

    경계를 루트가 아니라 **버킷 디렉터리**로 잡는 이유: `u1/../../outside.txt`는
    정규화하면 루트 안이지만 버킷 밖이다(실측). 루트만 검사하면 다른 버킷이나
    루트 직하에 쓰는 경로가 열린다.
    """
    root = _root()
    bucket_dir = (root / bucket).resolve()
    if not bucket_dir.is_relative_to(root):
        raise StorageError(f"저장소 루트 밖 버킷: {bucket!r}")
    target = (bucket_dir / path).resolve()
    # is_relative_to: 정규화 후에도 버킷 하위인지. `..`·심볼릭 조작을 막는다.
    if not target.is_relative_to(bucket_dir):
        raise StorageError(f"버킷 밖 경로: {bucket}/{path}")
    return target


async def upload(bucket: str, path: str, data: bytes, content_type: str) -> None:
    """업로드(덮어쓰기). content_type은 파일시스템에선 쓰지 않지만 시그니처 유지."""
    target = _resolve(bucket, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    logger.debug("저장: %s (%d bytes, %s)", target, len(data), content_type)


async def download(bucket: str, path: str) -> bytes:
    target = _resolve(bucket, path)
    if not target.is_file():
        raise StorageError(f"파일 없음: {bucket}/{path}")
    return target.read_bytes()


async def delete(bucket: str, path: str) -> None:
    """삭제. 없으면 조용히 넘어간다(멱등 — 재시도가 실패하지 않게)."""
    target = _resolve(bucket, path)
    if target.is_file():
        target.unlink()


def _signature(bucket: str, path: str, expires_at: int) -> str:
    msg = f"{bucket}:{path}:{expires_at}".encode()
    return hmac.new(
        settings.sign_secret.encode(), msg, hashlib.sha256
    ).hexdigest()[:32]


async def sign(bucket: str, path: str, expires_in: int) -> str:
    """만료 있는 서명 URL(백엔드 경로). 파일 존재 여부는 확인하지 않는다."""
    expires_at = int(time.time()) + max(1, expires_in)
    sig = _signature(bucket, path, expires_at)
    return f"/files/blob/{bucket}/{path}?exp={expires_at}&sig={sig}"


def verify(bucket: str, path: str, expires_at: int, sig: str) -> bool:
    """서명 검증 — 만료·위조 확인. 비교는 타이밍 안전하게."""
    if expires_at < int(time.time()):
        return False
    return hmac.compare_digest(_signature(bucket, path, expires_at), sig)
