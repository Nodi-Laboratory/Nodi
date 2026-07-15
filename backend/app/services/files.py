"""File upload + registration (Stage 3b-1).

Upload writes to Storage and inserts the `files` row + an `embedding_split` job
via the service-role client (the worker pipeline needs service_role anyway).
owner_id is set explicitly to the caller, preserving isolation. List/get are
request-time reads and use the caller's RLS-scoped UserClient.
"""

from __future__ import annotations

import logging
import re
import unicodedata
import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from . import app_settings
from .service_client import ServiceClient
from .supabase_client import UserClient
from .upstage import UPSTAGE_PARSE_MAX_BYTES

settings = get_settings()
logger = logging.getLogger("nodi.files")

FILE_SELECT = (
    "id,owner_id,space_kind,space_ref,uploader_id,kind,storage_path,mime,"
    "size_bytes,status,chunk_total,chunk_done,error,session_id,position_x,"
    "position_y,name,created_at,updated_at"
)

# D79: 스토리지 키에 허용되는 ASCII 문자 — Supabase Storage는 비ASCII 키를
# InvalidKey(400)로 거부한다(2026-07-15 라이브 실측: 한글 키는 NFC/NFD 불문 전부
# 거부, ASCII는 공백·괄호 포함 허용). 이 집합 밖 문자는 키에서 `_`로 치환한다.
_STORAGE_KEY_DISALLOWED = re.compile(r"[^A-Za-z0-9._()\- ]")


def _storage_key_name(filename: str | None, ext: str) -> str:
    """스토리지 키용 ASCII-only 파일명(D79). 원본 stem에서 허용 문자만 남기고
    나머지는 `_`로 치환→연속 `_` 축약→앞뒤 공백·`.` strip→100자 cap, 빈 stem은
    "file"로 대체한 뒤 D75에서 검증된 소문자 `ext`를 붙여 재조립한다. 결과 키는
    항상 ASCII-only가 되어 Supabase Storage의 InvalidKey(400)를 피한다.
    (표시용 원본 파일명은 files.name에 별도 보존 — 사용자에겐 원본이 노출된다.)"""
    raw = filename or ""
    stem = raw.rsplit(".", 1)[0]  # 확장자 제거(점 없으면 원문 그대로)
    stem = _STORAGE_KEY_DISALLOWED.sub("_", stem)
    stem = re.sub(r"_+", "_", stem).strip(" .")
    if not stem:
        stem = "file"
    stem = stem[:100]
    return f"{stem}.{ext}"


# D75: 업로드 형식 화이트리스트 — _extract_text(embedding_worker)의 실제 처리
# 능력과 일치시킨다(Upstage Document Parse: pdf/이미지, UTF-8 디코드: txt/md).
# 목록 밖은 스토리지 업로드 전에 422로 거절(깨진 청킹·splitting 고착 예방).
ALLOWED_UPLOAD_EXTENSIONS = frozenset(
    {"pdf", "png", "jpg", "jpeg", "webp", "gif", "txt", "md"}
)
UNSUPPORTED_TYPE_DETAIL = (
    "지원 형식: PDF, 이미지(PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)"
)

# D77: 이미지는 페이지 분할(D78)이 불가능해 파서 하드 리밋을 넘을 수 없다.
IMAGE_UPLOAD_EXTENSIONS = frozenset({"png", "jpg", "jpeg", "webp", "gif"})
OVERSIZED_IMAGE_DETAIL = "이미지 파일은 50MB 이하만 업로드할 수 있습니다."


def resolve_upload_max_bytes(overlay: dict[str, Any], kind: str) -> int:
    """D77: kind별 업로드 상한 — class_material(교사 자료)만 대용량 허용."""
    if kind == "class_material":
        return app_settings.as_int(
            overlay,
            "class_material_max_bytes",
            settings.class_material_max_bytes,
            1024 * 1024,
            512 * 1024 * 1024,
        )
    return app_settings.as_int(
        overlay, "file_max_bytes", settings.file_max_bytes, 1024, 100 * 1024 * 1024
    )


async def _assert_class_member(
    user_client: UserClient, owner_id: str, class_id: str
) -> None:
    """Verify the caller belongs to the class (RLS lets them read own row)."""
    rows = await user_client.select(
        "class_members",
        {
            "class_id": f"eq.{class_id}",
            "user_id": f"eq.{owner_id}",
            "select": "class_id",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this class.",
        )


async def _assert_class_teacher(user_client: UserClient, class_id: str) -> None:
    """Verify the caller is a teacher of the class (is_class_teacher RPC)."""
    is_teacher = await user_client.rpc("is_class_teacher", {"p_class_id": class_id})
    if not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a teacher of this class.",
        )


async def upload_file(
    service: ServiceClient,
    user_client: UserClient,
    owner_id: str,
    space_kind: str,
    space_ref: str | None,
    filename: str,
    mime: str | None,
    data: bytes,
    session_id: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
    kind: str = "user_upload",
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    if kind not in ("user_upload", "class_material"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kind must be 'user_upload' or 'class_material'.",
        )
    if kind == "class_material" and space_kind != "class":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class_material requires space_kind='class'.",
        )
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class files require space_ref (class id).",
        )
    # Defense: class_material requires teacher of that class; other class
    # uploads only require membership.
    if space_kind == "class":
        if kind == "class_material":
            await _assert_class_teacher(user_client, ref)
        else:
            await _assert_class_member(user_client, owner_id, ref)
    # D75: 형식 화이트리스트 — 확장자 기준(대소문자 무관), 저장 전에 거절.
    name_lower = (filename or "").lower()
    ext = name_lower.rsplit(".", 1)[-1] if "." in name_lower else ""
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=UNSUPPORTED_TYPE_DETAIL,
        )
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty file.",
        )
    overlay = await app_settings.get_overlay()
    max_bytes = resolve_upload_max_bytes(overlay, kind)
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {max_bytes} bytes.",
        )
    # D77: 이미지는 분할 파싱(D78) 불가 — 파서 하드 리밋 초과 시 사전 거절.
    if ext in IMAGE_UPLOAD_EXTENSIONS and len(data) > UPSTAGE_PARSE_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=OVERSIZED_IMAGE_DETAIL,
        )

    file_id = str(uuid.uuid4())
    # D79: 표시명은 NFC 정규화 원본을 보존한다(macOS는 파일명을 NFD로 전송 →
    # 정규화하지 않으면 자모 분리 상태로 저장됨). files.name에 저장해 UI에 노출.
    display_name = unicodedata.normalize("NFC", (filename or "upload")).strip()[:200]
    # 스토리지 키는 ASCII 강제(위 실측 근거). 원본은 위 display_name이 보존한다.
    safe_name = _storage_key_name(filename, ext)
    storage_path = f"{owner_id}/{file_id}/{safe_name}"

    # storage 오류(httpx 등)를 502로 변환 — 지금은 그대로 500 트레이스로 샌다.
    try:
        await service.storage_upload(
            settings.storage_bucket,
            storage_path,
            data,
            mime or "application/octet-stream",
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("스토리지 업로드 실패: path=%s", storage_path)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="저장소 업로드에 실패했습니다.",
        )

    rows = await service.insert(
        "files",
        {
            "id": file_id,
            "owner_id": owner_id,
            "space_kind": space_kind,
            "space_ref": ref,
            "uploader_id": owner_id,
            "kind": kind,
            "storage_path": storage_path,
            "name": display_name,
            "mime": mime,
            "size_bytes": len(data),
            "status": "uploaded",
            "session_id": session_id,
            "position_x": position_x,
            "position_y": position_y,
        },
    )
    file_row = rows[0]

    # Enqueue the split job (worker picks it up).
    await service.insert(
        "jobs",
        {
            "owner_id": owner_id,
            "kind": "embedding_split",
            "target_id": file_id,
            "status": "queued",
            "space_ref": ref,
        },
        returning=False,
    )
    return file_row


async def get_file_tags(client: UserClient, file_id: str) -> list[str]:
    """Tag names of a file the caller can access (own or class material)."""
    result = await client.rpc("get_file_tags", {"p_file_id": file_id})
    if isinstance(result, list):
        return [str(x) for x in result]
    return []


async def _assert_file_owner(
    client: UserClient, owner_id: str, file_id: str
) -> dict[str, Any]:
    """Return the file row, requiring the caller to be its OWNER (not just a
    class member who can read class_material)."""
    file_row = await get_file(client, file_id)  # 404 unless accessible (RLS)
    if file_row.get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the file owner can do this.",
        )
    return file_row


async def delete_file(
    service: ServiceClient, client: UserClient, owner_id: str, file_id: str
) -> None:
    """Delete a file (owner only): Storage object + files row (cascades chunks/
    links/file_tags), then prune any concept tags that became ORPHANS (D29).

    The row delete + orphan-tag cleanup run atomically inside the
    `delete_file_cascade` RPC (SECURITY DEFINER, owner-checked) under the
    caller's JWT; shared tags (still used elsewhere) are preserved. Storage
    object removal stays here on the service client. The file's Qdrant points
    (벡터 저장소 — RPC 밖) are pruned best-effort afterwards to avoid orphan leak.
    """
    file_row = await _assert_file_owner(client, owner_id, file_id)
    storage_path = file_row.get("storage_path")
    if storage_path:
        await service.storage_delete(settings.storage_bucket, storage_path)
    await client.rpc("delete_file_cascade", {"p_file_id": file_id})
    # 워커의 재분할 정리와 같은 best-effort 헬퍼를 재사용해 오펀 벡터를 지운다
    # (내부 try/except+warning — 실패해도 삭제는 이미 성공). 워커 순환 임포트를
    # 피해 지역 임포트(retry_file과 동일 패턴).
    from . import embedding_worker

    await embedding_worker._qdrant_delete_file_points(file_id)


async def retry_file(
    service: ServiceClient, client: UserClient, owner_id: str, file_id: str
) -> str:
    """Re-process a file (owner only). Delegates to the worker's idempotent
    requeue. Returns the action taken."""
    from . import embedding_worker  # local import avoids a worker import cycle

    await _assert_file_owner(client, owner_id, file_id)
    return await embedding_worker.requeue_file(service, file_id)


async def list_files(
    client: UserClient, space_kind: str, space_ref: str
) -> list[dict[str, Any]]:
    return await client.select(
        "files",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{space_ref}",
            "select": FILE_SELECT,
            "order": "created_at.desc",
        },
    )


async def get_file(client: UserClient, file_id: str) -> dict[str, Any]:
    rows = await client.select(
        "files",
        {"id": f"eq.{file_id}", "select": FILE_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found.",
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Visual RAG links (Stage 3b-2)
# ---------------------------------------------------------------------------
LINK_SELECT = "id,file_id,target_node_id,owner_id,created_at"


async def _owned_node_session(
    client: UserClient, owner_id: str, node_id: str
) -> dict[str, Any]:
    """Return the node's session row, ensuring the caller owns that session."""
    rows = await client.select(
        "nodes",
        {"id": f"eq.{node_id}", "select": "id,session_id", "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Node not found."
        )
    session_id = rows[0]["session_id"]
    srows = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    if not srows or srows[0].get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not own this node's session.",
        )
    return srows[0]


async def add_link(
    client: UserClient, owner_id: str, file_id: str, target_node_id: str
) -> dict[str, Any]:
    # Both the file and the node's session must be the caller's.
    file_row = await get_file(client, file_id)  # 404 unless owner (RLS)
    session = await _owned_node_session(client, owner_id, target_node_id)
    # Space isolation: a file may only be linked within its own space.
    if (file_row.get("space_kind") != session.get("space_kind")) or (
        file_row.get("space_ref") != session.get("space_ref")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File and node must belong to the same space.",
        )
    # Idempotent: return the existing link if already present.
    existing = await client.select(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
            "select": LINK_SELECT,
            "limit": "1",
        },
    )
    if existing:
        return existing[0]
    return await client.insert(
        "file_node_links",
        {
            "file_id": file_id,
            "target_node_id": target_node_id,
            "owner_id": owner_id,
        },
    )


async def remove_link(
    client: UserClient, file_id: str, target_node_id: str
) -> None:
    await client.delete(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
        },
    )


async def list_session_file_links(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """Links for any node in the session, with the linked file embedded."""
    node_rows = await client.select(
        "nodes", {"session_id": f"eq.{session_id}", "select": "id"}
    )
    node_ids = [n["id"] for n in node_rows]
    if not node_ids:
        return []
    return await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": (
                "id,file_id,target_node_id,created_at,"
                "files(id,storage_path,mime,status,chunk_total,chunk_done,"
                "session_id,position_x,position_y)"
            ),
            "order": "created_at.desc",
        },
    )


async def set_file_position(
    client: UserClient, file_id: str, position_x: float | None, position_y: float | None
) -> dict[str, Any]:
    """Persist a file-node's coordinates (D13). Owner only (RLS files_update_own)."""
    rows = await client.update(
        "files",
        {"id": f"eq.{file_id}"},
        {"position_x": position_x, "position_y": position_y},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found or not yours.",
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Graph-node PLACEMENTS (D58/D59) — display only, decoupled from RAG links.
#
# A placement (file_graph_nodes, 0021) means "show this file as a free node on
# THIS session's graph", with its own coordinates. Independent of file_node_links
# (RAG): placing a file does NOT make it a RAG source, and RAG retrieval still
# reads file_node_links ONLY (rag.linked_file_ids — unchanged). One file can be
# placed on many session graphs. All reads/writes go through the caller's
# RLS-scoped client (owner-only, fgn_* policies).
# ---------------------------------------------------------------------------
PLACEMENT_SELECT = (
    "id,file_id,session_id,position_x,position_y,created_at,"
    "files(id,storage_path,mime,kind,status,chunk_total,chunk_done,"
    "space_kind,space_ref)"
)


async def _owned_session(
    client: UserClient, owner_id: str, session_id: str
) -> dict[str, Any]:
    """Return the session row, requiring the caller to OWN it (not just read it)."""
    rows = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Session not found."
        )
    if rows[0].get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not own this session.",
        )
    return rows[0]


async def add_placement(
    client: UserClient,
    owner_id: str,
    file_id: str,
    session_id: str,
    position_x: float | None,
    position_y: float | None,
) -> dict[str, Any]:
    """Place a file as a node on a session graph (idempotent upsert on
    file_id+session_id). Caller must own both the file and the session, and they
    must share the same space (mirrors add_link isolation)."""
    file_row = await get_file(client, file_id)  # 404 unless accessible (RLS)
    if file_row.get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the file owner can place it.",
        )
    session = await _owned_session(client, owner_id, session_id)
    if (file_row.get("space_kind") != session.get("space_kind")) or (
        file_row.get("space_ref") != session.get("space_ref")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File and session must belong to the same space.",
        )
    return await client.upsert(
        "file_graph_nodes",
        {
            "file_id": file_id,
            "session_id": session_id,
            "owner_id": owner_id,
            "position_x": position_x,
            "position_y": position_y,
        },
        on_conflict="file_id,session_id",
    )


async def list_placements(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """Placements on a session graph, with the placed file's display meta joined
    (status/storage_path/chunk progress/kind) for graph file-node rendering."""
    return await client.select(
        "file_graph_nodes",
        {
            "session_id": f"eq.{session_id}",
            "select": PLACEMENT_SELECT,
            "order": "created_at.asc",
        },
    )


async def move_placement(
    client: UserClient,
    file_id: str,
    session_id: str,
    position_x: float | None,
    position_y: float | None,
) -> dict[str, Any]:
    """Update a placement's coordinates after drag (owner only via RLS)."""
    rows = await client.update(
        "file_graph_nodes",
        {"file_id": f"eq.{file_id}", "session_id": f"eq.{session_id}"},
        {"position_x": position_x, "position_y": position_y},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Placement not found or not yours.",
        )
    return rows[0]


async def remove_placement(
    client: UserClient, file_id: str, session_id: str
) -> None:
    """Remove a file from a session graph (placement only — the file itself and
    any RAG links are untouched; it stays in the space's file list)."""
    await client.delete(
        "file_graph_nodes",
        {"file_id": f"eq.{file_id}", "session_id": f"eq.{session_id}"},
    )
