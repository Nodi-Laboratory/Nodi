"""Qdrant 벡터 저장소 — 컬렉션 보장 + upsert + 검색 (upstage.EMBED_DIM, Cosine).

Qdrant에는 RLS가 없다 — 신뢰 경계가 아니다. file_chunks 페이로드는
{chunk_id, file_id, owner_id}만 저장(본문 없음)하고, 청크 텍스트는 검색 후
USER 스코프 Supabase 클라이언트로 다시 조회해 RLS가 접근을 재검증한다.
스코핑은 호출부가 file_ids 페이로드 필터로 강제한다.
컬렉션은 file_chunks(자료 청크)와 textbook_figures(교과서 도판) 둘뿐이다.
ebs/art_assets는 D94, canvas_cards는 D105로 제거됐다 — 카드 좌표·제목을
벡터로 들고 있던 컬렉션인데, 배치가 프론트 d3-force로 넘어가면서 쓰는 쪽이
사라졌다.
"""

from __future__ import annotations

import logging

from qdrant_client import AsyncQdrantClient, models

from ..config import get_settings
from ..services.upstage import EMBED_DIM

logger = logging.getLogger("nodi.qdrant")
settings = get_settings()

COL_FILE_CHUNKS = "file_chunks"
# 교과서 figure 임베딩 컬렉션(TASK 4, D86). file_chunks와 동형(같은 차원/Cosine) —
# figure 캡션·description 임베딩을 저장하고, file_id 페이로드 필터로 스코핑한다.
# 청크 본문과 마찬가지로 페이로드엔 식별자만(본문 없음), 히트 후 RLS 재조회.
COL_TEXTBOOK_FIGURES = "textbook_figures"
# 원자 질문 임베딩 컬렉션(TASK 6, D129). 청크당 solar가 생성한 예상 질문을
# embedding-passage로 임베딩해 저장한다. 페이로드는 {atom_id, chunk_id, file_id,
# owner_id}만(질문 본문 금지) — 히트 후 chunk_id로 file_chunks를 RLS 재조회한다.
COL_CHUNK_ATOMS = "chunk_atoms"
# 강의 클립 임베딩 컬렉션(D149). 클립 제목+본문을 embedding-passage로 임베딩하고,
# package_id 페이로드 필터로 스코핑한다(file_id가 아니라 package_id — search의
# scope_field 매개변수로 강제). 페이로드엔 식별자만, 히트 후 RLS 재조회.
COL_LECTURE_CLIPS = "lecture_clips"
# 강의 클립 원자 질문 임베딩 컬렉션(D149). chunk_atoms와 동형이나 스코프 키가
# package_id다.
COL_LECTURE_CLIP_ATOMS = "lecture_clip_atoms"

_client: AsyncQdrantClient | None = None


def get_client() -> AsyncQdrantClient:
    """지연 싱글턴 — 부팅 시 Qdrant가 없어도 import/기동은 실패하지 않는다."""
    global _client
    if _client is None:
        _client = AsyncQdrantClient(url=settings.qdrant_url)
    return _client


async def ensure_collections() -> None:
    """전체 컬렉션(EMBED_DIM, Cosine) 생성 보장 + 페이로드 인덱스.

    멱등. 부팅 경로에서 호출되므로 절대 raise하지 않는다 — 실패는 로그만 남기고,
    실제 사용 시점(upsert/search)의 예외로 드러난다.
    """
    try:
        client = get_client()
        for name in (
            COL_FILE_CHUNKS,
            COL_TEXTBOOK_FIGURES,
            COL_CHUNK_ATOMS,
            COL_LECTURE_CLIPS,
            COL_LECTURE_CLIP_ATOMS,
        ):
            if not await client.collection_exists(name):
                await client.create_collection(
                    collection_name=name,
                    vectors_config=models.VectorParams(
                        size=EMBED_DIM, distance=models.Distance.COSINE
                    ),
                )
                logger.info("Qdrant 컬렉션 생성: %s (%dd, Cosine)", name, EMBED_DIM)
        # 스코프 필터 성능용 페이로드 인덱스 — best-effort(이미 있으면 무시).
        try:
            await client.create_payload_index(
                collection_name=COL_FILE_CHUNKS,
                field_name="file_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:  # noqa: BLE001 - 인덱스는 최적화일 뿐, 실패해도 동작함
            logger.debug("file_id 페이로드 인덱스 생성 생략(이미 존재하거나 실패)")
        # textbook_figures.file_id KEYWORD 인덱스 (figure 스코프 필터 성능, D86).
        try:
            await client.create_payload_index(
                collection_name=COL_TEXTBOOK_FIGURES,
                field_name="file_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:  # noqa: BLE001
            logger.debug("textbook_figures file_id 인덱스 생성 생략")
        # chunk_atoms.file_id KEYWORD 인덱스 (원자 스코프 필터 성능, D129).
        try:
            await client.create_payload_index(
                collection_name=COL_CHUNK_ATOMS,
                field_name="file_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:  # noqa: BLE001
            logger.debug("chunk_atoms file_id 인덱스 생성 생략")
        # 강의 클립 컬렉션은 package_id KEYWORD 인덱스로 스코핑 (D149).
        for col in (COL_LECTURE_CLIPS, COL_LECTURE_CLIP_ATOMS):
            try:
                await client.create_payload_index(
                    collection_name=col,
                    field_name="package_id",
                    field_schema=models.PayloadSchemaType.KEYWORD,
                )
            except Exception:  # noqa: BLE001
                logger.debug("%s package_id 인덱스 생성 생략", col)
    except Exception:  # noqa: BLE001 - 부팅을 죽이지 않는다
        logger.warning(
            "Qdrant 컬렉션 보장 실패 — 부팅은 계속, 사용 시점에 에러로 드러남 (url=%s)",
            settings.qdrant_url,
            exc_info=True,
        )


async def upsert(collection: str, points: list[dict]) -> None:
    """포인트 업서트. 각 항목: {"id": str(uuid), "vector": [...], "payload": {...}}."""
    if not points:
        return
    client = get_client()
    await client.upsert(
        collection_name=collection,
        points=[
            models.PointStruct(
                id=p["id"], vector=p["vector"], payload=p.get("payload") or {}
            )
            for p in points
        ],
        wait=True,
    )


async def search(
    collection: str,
    vector: list[float],
    k: int,
    *,
    file_ids: list[str] | None = None,
    scope_field: str = "file_id",  # D149: 강의 클립은 "package_id"로 스코프
    score_threshold: float | None = None,
) -> list[dict]:
    """코사인 유사도 검색 -> [{"id","score","payload"}] (score 높을수록 유사).

    file_ids가 주어지면 payload.{scope_field} MatchAny 필터를 must로 강제한다
    (RAG 스코핑 — 호출부는 RLS로 스코프된 조회에서 접근 가능 id를 파생).
    scope_field 기본은 "file_id"(자료 청크·figure·원자) — 강의 클립은
    "package_id"로 넘긴다. 빈 목록은 "접근 가능 항목 없음" — 즉시 빈 결과.
    """
    if file_ids is not None and not file_ids:
        return []
    query_filter = None
    if file_ids is not None:
        query_filter = models.Filter(
            must=[
                models.FieldCondition(
                    key=scope_field,
                    match=models.MatchAny(any=[str(f) for f in file_ids]),
                )
            ]
        )
    client = get_client()
    res = await client.query_points(
        collection_name=collection,
        query=vector,
        limit=k,
        query_filter=query_filter,
        score_threshold=score_threshold,
        with_payload=True,
    )
    return [
        {"id": str(pt.id), "score": pt.score, "payload": pt.payload or {}}
        for pt in res.points
    ]
