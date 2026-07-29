"""워커 공용 — 텍스트 추출과 Qdrant 헬퍼.

여기 있는 함수는 잡 종류와 무관하게 쓰인다. 다른 워커 모듈은 이 모듈을
**모듈 채로 임포트해 한정 호출**한다(`common._qdrant_upsert(...)`) — 테스트가
`monkeypatch.setattr(common, "_qdrant_upsert", ...)`로 갈아끼울 수 있어야 하기
때문이다. `from .common import _qdrant_upsert`로 당겨오면 그 패치가 안 먹는다.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from .. import (
    qdrant_store,
    upstage,
)

logger = logging.getLogger("nodi.worker.common")

# 컬렉션 보장은 지연 1회 — 업서트 실패 시 다음 시도에서 재보장한다.
_qdrant_ready = False


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def touch_job(svc: Any, job_id: str) -> None:
    """장기 잡 하트비트(D120) — jobs.updated_at을 전진시켜 스테일 복구(120초)의
    오탐 재클레임을 막는다. LLM을 여러 번 부르는 잡(atom_batch·figure 캡션 생성·
    의미 청킹)이 N콜마다 부른다. 실패는 삼킨다 — 하트비트가 잡을 죽이면 본말전도."""
    try:
        await svc.update(
            "jobs", {"id": f"eq.{job_id}"}, {"updated_at": _now_iso()}
        )
    except Exception:  # noqa: BLE001
        logger.warning("touch_job 실패 job=%s", job_id, exc_info=True)


# ---------------------------------------------------------------------------
# 텍스트 추출: PDF/이미지는 Upstage Document Parse(markdown, 스캔본 OCR 포함),
# 그 외는 평문 디코드. 추출 실패 = 빈 텍스트 -> split이 파일을 failed 처리.
# ---------------------------------------------------------------------------
async def _extract_text(data: bytes, mime: str | None, storage_path: str) -> str:
    name = (storage_path or "").lower()
    mime = mime or ""

    is_image = mime.startswith("image/") or name.endswith(
        (".png", ".jpg", ".jpeg", ".webp", ".gif")
    )
    is_pdf = name.endswith(".pdf") or mime.endswith("pdf")
    if is_image or is_pdf:
        try:
            # 스토리지 경로 규약 "{owner}/{file_id}/{name}" -> 실제 파일명.
            filename = (storage_path or "").split("/")[-1] or "document"
            return await upstage.parse_document(data, filename)
        except Exception:  # noqa: BLE001 - 잡 상태 머신 보존(파일 failed 경로)
            logger.exception("Document parse failed for %s", storage_path)
            return ""

    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="ignore")


async def _qdrant_upsert(
    points: list[dict[str, Any]],
    collection: str = qdrant_store.COL_FILE_CHUNKS,
) -> None:
    global _qdrant_ready
    if not _qdrant_ready:
        await qdrant_store.ensure_collections()
        _qdrant_ready = True
    try:
        # D86: collection 기본값은 file_chunks(기존 호출부 하위호환), textbook
        # figure 경로만 COL_TEXTBOOK_FIGURES를 명시한다.
        await qdrant_store.upsert(collection, points)
    except Exception:
        _qdrant_ready = False  # 컬렉션 부재/일시 장애 대비 — 재시도 시 재보장
        raise


async def _qdrant_delete_file_points(
    file_id: str, collection: str = qdrant_store.COL_FILE_CHUNKS
) -> None:
    """재분할·삭제 전 해당 파일의 기존 Qdrant 포인트 정리 — best-effort.

    스테일 포인트가 남아도 본문 없는 페이로드뿐이고 검색 후 Supabase 재조회
    (RLS)에서 걸러지지만, 무한히 쌓이지 않도록 여기서 지운다. collection 기본값은
    file_chunks(기존 호출부·테스트 하위호환) — textbook figure 경로는
    COL_TEXTBOOK_FIGURES를 넘겨 figure 임베딩 포인트를 정리한다(D86).
    """
    try:
        from qdrant_client import models

        await qdrant_store.get_client().delete(
            collection_name=collection,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="file_id", match=models.MatchValue(value=str(file_id))
                        )
                    ]
                )
            ),
        )
    except Exception:  # noqa: BLE001 - 정리는 최적화일 뿐, split/삭제를 막지 않는다
        logger.warning(
            "Qdrant 포인트 정리 실패 file=%s collection=%s",
            file_id, collection, exc_info=True,
        )
