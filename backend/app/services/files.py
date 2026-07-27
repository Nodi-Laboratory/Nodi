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
from ..db.client import ServiceClient, UserClient
from . import app_settings, figure_judge, qdrant_store
from .upstage import UPSTAGE_PARSE_MAX_BYTES

settings = get_settings()
logger = logging.getLogger("nodi.files")

FILE_SELECT = (
    "id,owner_id,space_kind,space_ref,kind,storage_path,mime,"
    "size_bytes,status,chunk_total,chunk_done,error,name,"
    "session_id,context_chars,created_at,updated_at"
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


# D75: 업로드 형식 화이트리스트 — _extract_text(worker.common)의 실제 처리
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

# D86: 교과서 figure 파이프라인은 PDF 페이지 좌표를 전제한다 — 이미지·평문 입력은
# 페이지 구조가 없어 좌표 기반 figure 추출이 불가하므로 업로드 단계에서 차단한다.
TEXTBOOK_PDF_ONLY_DETAIL = "교과서는 PDF만 업로드할 수 있습니다."


def resolve_upload_max_bytes(overlay: dict[str, Any], kind: str) -> int:
    """D77: kind별 업로드 상한 — class_material(교사 자료)만 대용량 허용.

    D86: textbook(교과서)도 같은 500MB 노브를 공유한다 — 둘 다 교사가 올리는
    대용량 학습 자료라 상한 근거가 동일하고, 신규 노브 증식을 막는다.
    """
    if kind in ("class_material", "textbook"):
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
    kind: str = "user_upload",
    session_id: str | None = None,
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    # D86: textbook(교과서)는 class_material과 동형 — class 공간·교사 전용.
    if kind not in ("user_upload", "class_material", "textbook"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kind must be 'user_upload', 'class_material', or 'textbook'.",
        )
    if kind in ("class_material", "textbook") and space_kind != "class":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class_material/textbook requires space_kind='class'.",
        )
    # D103: 판정(VLM) 미설정이 더 이상 업로드를 막지 않는다. 캡션 확정에 파서
    # 라벨(caption/footnote) 경로가 생겨서, 판정 없이도 figure가 만들어질 수
    # 있기 때문이다(figure_extract). 판정은 라벨이 없는 figure를 건지는
    # 폴백으로 남는다 — 미설정이면 그 figure만 캡션 없이 실패한다.
    #
    # (D93에서는 판정이 유일한 캡션 출처라 업로드 자체를 503으로 막았다.
    #  그 전제가 깨졌으므로 게이트도 함께 걷어낸다. 텍스트 RAG는 어느 경우에도
    #  정상 동작하므로 교과서 업로드를 막을 이유가 없다.)
    if kind == "textbook" and figure_judge.missing_config():
        logger.info(
            "교과서 업로드 — figure 판정 미설정(%s). 파서가 캡션으로 라벨한 "
            "figure만 처리된다.",
            ", ".join(figure_judge.missing_config()),
        )
    # D83: 세션 연결은 user_upload 전용 — 학급 자료는 세션에 귀속되지 않는다.
    if session_id is not None and kind != "user_upload":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="session_id는 user_upload에만 허용됩니다.",
        )
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class files require space_ref (class id).",
        )
    # Defense: class_material/textbook require teacher of that class (D86);
    # other class uploads only require membership.
    if space_kind == "class":
        if kind in ("class_material", "textbook"):
            await _assert_class_teacher(user_client, ref)
        else:
            await _assert_class_member(user_client, owner_id, ref)
    # D83: 세션 소유자 검증. 교사도 학생 세션을 SELECT할 수 있으므로(RLS R2)
    # 조회 성공만으론 부족 — owner_id를 명시 비교한다. 세션의 공간과 업로드
    # 폼의 공간이 어긋나면 주입 스코프가 꼬이므로 422.
    if session_id is not None:
        srows = await user_client.select(
            "sessions",
            {
                "id": f"eq.{session_id}",
                "select": "id,owner_id,space_kind,space_ref",
                "limit": "1",
            },
        )
        if not srows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found or not accessible.",
            )
        sess = srows[0]
        if sess.get("owner_id") != owner_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="자기 세션에만 파일을 연결할 수 있습니다.",
            )
        if sess.get("space_kind") != space_kind or sess.get("space_ref") != ref:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="세션의 공간과 업로드 공간이 일치해야 합니다.",
            )
    # D75: 형식 화이트리스트 — 확장자 기준(대소문자 무관), 저장 전에 거절.
    name_lower = (filename or "").lower()
    ext = name_lower.rsplit(".", 1)[-1] if "." in name_lower else ""
    if ext not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=UNSUPPORTED_TYPE_DETAIL,
        )
    # D86: 교과서는 PDF 전용 — figure 추출이 페이지 좌표를 전제하므로 화이트리스트
    # 통과분(이미지·텍스트)이라도 PDF가 아니면 거절한다.
    if kind == "textbook" and ext != "pdf":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=TEXTBOOK_PDF_ONLY_DETAIL,
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
    except Exception as exc:
        logger.exception("스토리지 업로드 실패: path=%s", storage_path)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="저장소 업로드에 실패했습니다.",
        ) from exc

    rows = await service.insert(
        "files",
        {
            "id": file_id,
            "owner_id": owner_id,
            "space_kind": space_kind,
            "space_ref": ref,
            "kind": kind,
            "storage_path": storage_path,
            "name": display_name,
            "mime": mime,
            "size_bytes": len(data),
            "session_id": session_id,
            "status": "uploaded",
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
    """Delete a file (owner only): Storage object + files row (cascades chunks).

    The row delete runs inside the `delete_file_cascade` RPC (SECURITY DEFINER,
    owner-checked) under the caller's JWT. Storage object removal stays here on
    the service client. The file's Qdrant points (벡터 저장소 — RPC 밖) are pruned
    best-effort afterwards to avoid orphan leak.
    """
    file_row = await _assert_file_owner(client, owner_id, file_id)
    storage_path = file_row.get("storage_path")
    is_textbook = file_row.get("kind") == "textbook"
    # D86: textbook은 figure 크롭(Storage)도 함께 지운다. 경로 목록은
    # delete_file_cascade가 textbook_figures 행을 FK cascade로 지우기 "전에"
    # 수집해야 한다. best-effort — 조회·삭제 실패는 warning만(행 삭제는 cascade가
    # 담당하고, 오펀 Storage 객체가 남아도 치명적이지 않다).
    if is_textbook:
        try:
            figs = await service.select(
                "textbook_figures",
                {"file_id": f"eq.{file_id}", "select": "image_path"},
            )
        except Exception:  # noqa: BLE001 - 크롭 정리는 최적화일 뿐, 삭제를 막지 않는다
            logger.warning(
                "textbook_figures 조회 실패 — 크롭 정리 생략 file=%s",
                file_id, exc_info=True,
            )
            figs = []
        for fig in figs:
            path = fig.get("image_path")
            if not path:
                continue
            try:
                await service.storage_delete(settings.storage_bucket, path)
            except Exception:  # noqa: BLE001 - 개별 크롭 삭제 실패는 무시하고 계속
                logger.warning("figure 크롭 삭제 실패(무시) path=%s", path, exc_info=True)
    if storage_path:
        await service.storage_delete(settings.storage_bucket, storage_path)
    await client.rpc("delete_file_cascade", {"p_file_id": file_id})
    # 워커의 재분할 정리와 같은 best-effort 헬퍼를 재사용해 오펀 벡터를 지운다
    # (내부 try/except+warning — 실패해도 삭제는 이미 성공). 워커 순환 임포트를
    # 피해 지역 임포트(retry_file과 동일 패턴).
    from .worker import common as worker_common

    await worker_common._qdrant_delete_file_points(file_id)
    # D86: textbook figure 임베딩 포인트도 정리(별도 Qdrant 컬렉션).
    if is_textbook:
        await worker_common._qdrant_delete_file_points(
            file_id, collection=qdrant_store.COL_TEXTBOOK_FIGURES
        )


async def retry_file(
    service: ServiceClient, client: UserClient, owner_id: str, file_id: str
) -> str:
    """Re-process a file (owner only). Delegates to the worker's idempotent
    requeue. Returns the action taken."""
    from . import worker  # local import avoids a worker import cycle

    await _assert_file_owner(client, owner_id, file_id)
    return await worker.requeue_file(service, file_id)


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


async def list_session_files(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """D83: 세션 컨텍스트 파일 목록 — 주입 순서(created_at asc)와 동일하게."""
    return await client.select(
        "files",
        {
            "session_id": f"eq.{session_id}",
            "kind": "eq.user_upload",
            "select": FILE_SELECT,
            "order": "created_at.asc",
        },
    )

