"""강의 클립 썸네일 (D190).

고정하는 계약:
  1. **경로가 안 삼켜진다** — `/files/clip-thumbnails`로 뒀다가 `/files/{file_id}`가
     uuid로 파싱해 502가 났다(실측 2026-08-06). 겹칠 수 없는 자리에 있어야 한다.
  2. 이미지만 받는다 — 안 보고 받으면 학생 화면의 `<img>`에 아무거나 들어간다.
  3. 크기 상한이 있다 — 썸네일이 4MB를 넘을 이유가 없다.
  4. 넣고 빼는 것은 관리자만(라우터 의존성).
  5. 저장소가 없으면 503 — 조용히 성공한 척하지 않는다.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException

from app.routers import clip_thumbnails as router_mod
from app.services import clip_thumbnails as svc

aio = pytest.mark.asyncio

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 40


class FakeClient:
    def __init__(self, rows: list[dict] | None = None):
        self.rows = rows if rows is not None else []
        self.inserted: dict[str, Any] | None = None

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        return self.rows

    async def insert(self, table: str, row: dict) -> dict[str, Any]:
        self.inserted = row
        return dict(row)

    async def delete(self, table: str, filters: dict) -> list[dict]:
        return [{"id": "t1"}]


class FakeService:
    def __init__(self):
        self.uploaded: list[tuple[str, int, str]] = []
        self.deleted: list[str] = []

    async def storage_upload(self, bucket, path, data, mime):
        self.uploaded.append((path, len(data), mime))

    async def storage_download(self, bucket, path):
        return PNG

    async def storage_delete(self, bucket, path):
        self.deleted.append(path)


# --- 1. 경로가 안 삼켜진다 ---------------------------------------------------


def test_썸네일_경로가_파일_경로와_겹치지_않는다():
    """`/files/{file_id}`는 정적 형제 경로를 uuid로 파싱해 삼킨다.

    선언 순서를 바꿔 고칠 수도 있지만, **다음 사람이 순서를 바꾸면 조용히 다시
    깨진다.** 겹칠 수 없는 접두사에 있는지를 본다.
    """
    assert router_mod.router.prefix == "/clip-thumbnails"
    paths = {r.path for r in router_mod.router.routes}
    assert "/clip-thumbnails" in paths
    assert not any(p.startswith("/files") for p in paths)


def test_읽기_경로는_로그인만_요구한다():
    """장식용 그림이라 학생도 봐야 한다 — 관리자 전용이면 카드가 빈다."""
    for route in router_mod.router.routes:
        names = [d.call.__name__ for d in route.dependant.dependencies]
        assert "get_current_user" in names
        assert "require_admin" not in names


# --- 2·3. 입력 검증 -----------------------------------------------------------


@aio
@pytest.mark.parametrize("mime", ["text/plain", "application/pdf", "", None])
async def test_이미지가_아니면_거절한다(mime, monkeypatch):
    monkeypatch.setattr(svc, "get_service_client", lambda: FakeService())
    with pytest.raises(HTTPException) as exc:
        await svc.add_thumbnail(
            FakeClient(), owner_id="u1", filename="x", mime=mime, data=PNG
        )
    assert exc.value.status_code == 422


@aio
async def test_빈_파일은_거절한다(monkeypatch):
    monkeypatch.setattr(svc, "get_service_client", lambda: FakeService())
    with pytest.raises(HTTPException) as exc:
        await svc.add_thumbnail(
            FakeClient(), owner_id="u1", filename="x", mime="image/png", data=b""
        )
    assert exc.value.status_code == 422


@aio
async def test_너무_크면_MB로_말해_준다(monkeypatch):
    monkeypatch.setattr(svc, "get_service_client", lambda: FakeService())
    with pytest.raises(HTTPException) as exc:
        await svc.add_thumbnail(
            FakeClient(),
            owner_id="u1",
            filename="x",
            mime="image/png",
            data=b"0" * (svc.MAX_BYTES + 1),
        )
    assert exc.value.status_code == 413
    assert "MB까지" in exc.value.detail


@aio
async def test_mime의_매개변수는_무시한다(monkeypatch):
    """브라우저가 `image/png; charset=binary`로 보낼 수 있다."""
    fake = FakeService()
    monkeypatch.setattr(svc, "get_service_client", lambda: fake)
    c = FakeClient()
    await svc.add_thumbnail(
        c, owner_id="u1", filename="a.png", mime="image/png; charset=binary", data=PNG
    )
    assert c.inserted is not None
    assert c.inserted["mime"] == "image/png"


@aio
async def test_저장_경로는_id로_짓는다(monkeypatch):
    """이름으로 지으면 같은 파일명을 두 번 올릴 때 앞 것이 덮인다."""
    fake = FakeService()
    monkeypatch.setattr(svc, "get_service_client", lambda: fake)
    c = FakeClient()
    row = await svc.add_thumbnail(
        c, owner_id="u1", filename="같은이름.png", mime="image/jpeg", data=PNG
    )
    path = fake.uploaded[0][0]
    assert row["id"] in path
    assert path.endswith(".jpg")  # jpeg → jpg


# --- 5. 저장소가 없을 때 -----------------------------------------------------


@aio
async def test_저장소가_없으면_503(monkeypatch):
    """행만 만들고 바이트를 안 넣으면 목록에 뜨는데 그림이 없다."""
    monkeypatch.setattr(svc, "get_service_client", lambda: None)
    with pytest.raises(HTTPException) as exc:
        await svc.add_thumbnail(
            FakeClient(), owner_id="u1", filename="x", mime="image/png", data=PNG
        )
    assert exc.value.status_code == 503


@aio
async def test_없는_썸네일은_404(monkeypatch):
    monkeypatch.setattr(svc, "get_service_client", lambda: FakeService())
    with pytest.raises(HTTPException) as exc:
        await svc.read_bytes(FakeClient(rows=[]), "없음")
    assert exc.value.status_code == 404


@aio
async def test_지우면_바이트도_지운다(monkeypatch):
    fake = FakeService()
    monkeypatch.setattr(svc, "get_service_client", lambda: fake)
    c = FakeClient(rows=[{"id": "t1", "storage_path": "clip-thumbs/t1.png"}])
    await svc.remove_thumbnail(c, "t1")
    assert fake.deleted == ["clip-thumbs/t1.png"]


@aio
async def test_바이트_삭제가_실패해도_행은_지워진다(monkeypatch):
    """목록에서 사라지는 것이 학생에게 보이는 결과다 — 그것부터 지킨다."""

    class Boom(FakeService):
        async def storage_delete(self, bucket, path):
            raise RuntimeError("저장소 죽음")

    monkeypatch.setattr(svc, "get_service_client", lambda: Boom())
    c = FakeClient(rows=[{"id": "t1", "storage_path": "p"}])
    await svc.remove_thumbnail(c, "t1")  # raise하지 않는다
