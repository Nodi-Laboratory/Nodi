"""File endpoints (Stage 3b-1) — upload + list + status.

Upload requires the service-role client (storage write + the embedding pipeline
need it). If SUPABASE_SERVICE_ROLE_KEY is unset, upload returns 503; list/get
still work (RLS reads via the caller's JWT).
"""

from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)

from fastapi.responses import Response

from ..auth.deps import CurrentUser, get_current_user
from ..db import storage
from ..db.client import UserClient, get_service_client
from ..services import app_settings, figures
from ..services import files as svc

router = APIRouter(prefix="/files", tags=["files"])


# 확장자 → Content-Type. figure 크롭은 jpg/png만 나오지만(figure_extract) 원본
# 문서 서빙 가능성까지 최소한으로 커버한다. 모르는 확장자는 octet-stream.
_BLOB_MIME = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "pdf": "application/pdf",
}


@router.get("/blob/{bucket}/{blob_path:path}")
async def serve_blob(bucket: str, blob_path: str, exp: int, sig: str) -> Response:
    """서명 URL 서빙 (D104-5의 빠진 반쪽 — 2026-07-30 라이브 E2E에서 발견).

    storage.sign()이 만드는 `/api/files/blob/…?exp=&sig=` URL의 소비자다.
    **로그인 인증을 요구하지 않는다** — `<img src>`는 Authorization 헤더를 실을
    수 없어서, 만료 있는 HMAC 서명이 인증을 대신한다(발급 시점에 RLS 재조회로
    접근 권한을 이미 검증했다 — figures.sign_figure_url). 서명·만료가 어긋나면
    403, 파일이 없으면 404. 경로 탈출은 storage._resolve가 거부한다.
    """
    if not storage.verify(bucket, blob_path, exp, sig):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="서명이 유효하지 않거나 만료됐습니다.",
        )
    try:
        data = await storage.download(bucket, blob_path)
    except storage.StorageError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="파일이 없습니다."
        ) from None
    ext = blob_path.rsplit(".", 1)[-1].lower() if "." in blob_path else ""
    return Response(
        content=data,
        media_type=_BLOB_MIME.get(ext, "application/octet-stream"),
        # 서명 만료와 무관하게 브라우저 캐시는 짧게 — 만료 후 재발급 URL이
        # 캐시에 가려지지 않게 한다.
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post("", status_code=201)
async def upload(
    file: UploadFile = File(...),
    space_kind: str = Form("personal"),
    space_ref: str | None = Form(None),
    kind: str = Form("user_upload"),
    session_id: str | None = Form(None),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Upload a file -> Storage + files row + queued embedding_split job.

    `kind='class_material'` (teacher only, space_kind='class') makes the file
    readable + RAG-searchable by all class members (Stage 4b).
    """
    service = get_service_client()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File uploads are disabled (service-role key not configured).",
        )
    # Early reject on declared size (avoid buffering an oversized body). D62:
    # the limit is admin-tunable via the overlay (upload_file re-checks it too).
    overlay = await app_settings.get_overlay()
    # D77: kind별 상한 — class_material은 대용량 허용(서비스가 재검증).
    max_bytes = svc.resolve_upload_max_bytes(overlay, kind)
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {max_bytes} bytes.",
        )
    data = await file.read()
    return await svc.upload_file(
        service,
        UserClient.from_user(user),
        owner_id=user.id,
        space_kind=space_kind,
        space_ref=space_ref,
        filename=file.filename or "upload",
        mime=file.content_type,
        data=data,
        kind=kind,
        session_id=session_id,
    )


@router.get("")
async def list_files(
    space_kind: str | None = Query(None, pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    session_id: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    # D83: 세션 기준 조회 — 공간 인자 불필요(RLS가 소유자 스코프).
    if session_id:
        return await svc.list_session_files(client, session_id)
    if not space_kind:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind or session_id is required.",
        )
    ref = space_ref or (user.id if space_kind == "personal" else None)
    if not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class space requires space_ref (class id).",
        )
    return await svc.list_files(client, space_kind, ref)


@router.get("/{file_id}")
async def get_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """File row incl. status + progress (chunk_done / chunk_total)."""
    client = UserClient.from_user(user)
    return await svc.get_file(client, file_id)


@router.delete("/{file_id}", status_code=204)
async def delete_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Delete a file (owner only): Storage object + row (cascades chunks)."""
    service = get_service_client()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File operations are disabled (service-role key not configured).",
        )
    client = UserClient.from_user(user)
    await svc.delete_file(service, client, user.id, file_id)


@router.post("/{file_id}/retry")
async def retry_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Re-process a failed/partial/stuck file (owner only). Idempotent."""
    service = get_service_client()
    if service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File operations are disabled (service-role key not configured).",
        )
    client = UserClient.from_user(user)
    action = await svc.retry_file(service, client, user.id, file_id)
    return {"file_id": file_id, "action": action}


# --- Figure 재수화 (D87: signed URL 비영속 → 재발급 창구) ------------------
@router.get("/figures/{figure_id}")
async def get_figure(
    figure_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """단건 figure signed URL 재발급(D87). URL은 영속하지 않으므로(만료) 프론트가
    노드 재수화 시 이 창구로 새 signed URL을 받는다.

    UserClient로 textbook_figures 1행 조회 — RLS(0038)가 소유자/학급 구성원 접근을
    재검증(없거나 접근 불가면 404). 서명은 service-role 필요 — 미설정·발급 실패 시
    404로 뭉개지 않고 503(서비스 미구성, 기존 라우터의 서비스롤 부재 관례).
    `/figures/{id}`는 2세그먼트라 1세그먼트 `/{file_id}`에 삼켜지지 않는다.
    반환: {figure_id, url, caption, page}.
    """
    client = UserClient.from_user(user)
    rows = await client.select(
        "textbook_figures",
        {
            "id": f"eq.{figure_id}",
            "select": (
                "id,file_id,page,caption,alt,candidates,selected_index,embed_text,image_path"
            ),
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Figure not found or not accessible.",
        )
    row = rows[0]
    url = await figures.sign_figure_url(row)
    if not url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Figure URL signing is unavailable (service-role key not configured).",
        )
    return {
        "figure_id": row.get("id"),
        "url": url,
        "caption": figures.display_caption(row),
        "page": row.get("page"),
    }


# --- RAG source detail (D41) ---------------------------------------------
@router.get("/chunks/{chunk_id}/context")
async def get_chunk_context(
    chunk_id: str,
    neighbors: int = Query(1, ge=0, le=5),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Full text + neighbours of a RAG source chunk (the "⋯" detail panel, D41).

    Calls the get_chunk_context RPC under the caller's JWT; visibility (own file
    or class_material the caller belongs to) is enforced inside the RPC, so a
    chunk the caller cannot access yields 0 rows -> 404. Returns
    ``{file_id, name, seq, chunk_text, prev_text, next_text}``.
    """
    client = UserClient.from_user(user)
    rows = await client.rpc(
        "get_chunk_context",
        {"p_chunk_id": chunk_id, "p_neighbors": neighbors},
    )
    if isinstance(rows, list):
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Chunk not found or not accessible.",
            )
        return rows[0]
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chunk not found or not accessible.",
        )
    return rows

