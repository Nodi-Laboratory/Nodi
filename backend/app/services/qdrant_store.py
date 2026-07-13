"""Qdrant 벡터 저장소 — 컬렉션 보장 + upsert + 검색 (4096d, Cosine).

Qdrant에는 RLS가 없다 — 신뢰 경계가 아니다. file_chunks 페이로드는
{chunk_id, file_id, owner_id}만 저장(본문 없음)하고, 청크 텍스트는 검색 후
USER 스코프 Supabase 클라이언트로 다시 조회해 RLS가 접근을 재검증한다.
스코핑은 호출부가 file_ids 페이로드 필터로 강제한다. art/ebs는 전역
카탈로그(유저 데이터 아님)라 필터 없음.
"""

from __future__ import annotations

import logging
import uuid

from qdrant_client import AsyncQdrantClient, models

from ..config import get_settings
from ..services.upstage import EMBED_DIM

logger = logging.getLogger("nodi.qdrant")
settings = get_settings()

COL_FILE_CHUNKS = "file_chunks"
COL_ART = "art_assets"
COL_EBS = "ebs"
COL_CANVAS_CARDS = "canvas_cards"
COL_TEXTBOOK = "textbook"

_client: AsyncQdrantClient | None = None


def get_client() -> AsyncQdrantClient:
    """지연 싱글턴 — 부팅 시 Qdrant가 없어도 import/기동은 실패하지 않는다."""
    global _client
    if _client is None:
        _client = AsyncQdrantClient(url=settings.qdrant_url)
    return _client


# ---------------------------------------------------------------------------
# 포인트 ID 규약: 행 uuid가 있으면 그대로(청크 id / art_assets id), 없으면
# uuid5(NAMESPACE_URL, "ebs:{video_id}" | "art:{slug}")로 결정론적 생성
# (재실행 ingest가 중복 대신 덮어쓰도록).
# ---------------------------------------------------------------------------
def ebs_point_id(video_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"ebs:{video_id}"))


def art_point_id(slug: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"art:{slug}"))


def canvas_card_point_id(node_id: str, concept_index: int) -> str:
    """canvas_cards 포인트 id — 멱등 upsert를 위한 결정론 uuid5."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"card:{node_id}:{concept_index}"))


def textbook_point_id(source_name: str, seq: int) -> str:
    """textbook 포인트 id — 재실행 ingest가 덮어쓰도록 결정론 uuid5."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"textbook:{source_name}:{seq}"))


async def ensure_collections() -> None:
    """전체 컬렉션(4096d, Cosine) 생성 보장 + 페이로드 인덱스.

    멱등. 부팅 경로에서 호출되므로 절대 raise하지 않는다 — 실패는 로그만 남기고,
    실제 사용 시점(upsert/search)의 예외로 드러난다.
    """
    try:
        client = get_client()
        for name in (COL_FILE_CHUNKS, COL_ART, COL_EBS, COL_CANVAS_CARDS, COL_TEXTBOOK):
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
        # canvas_cards.session_id KEYWORD 인덱스 (세션 필터 성능).
        try:
            await client.create_payload_index(
                collection_name=COL_CANVAS_CARDS,
                field_name="session_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:  # noqa: BLE001
            logger.debug("canvas_cards session_id 인덱스 생성 생략")
        # textbook 키워드 인덱스 — source_name은 재인제스트 선삭제 필터용,
        # subject/grade는 지금은 미사용(과목/학년 필터 대비, 스펙 2장).
        for field in ("source_name", "subject", "grade"):
            try:
                await client.create_payload_index(
                    collection_name=COL_TEXTBOOK,
                    field_name=field,
                    field_schema=models.PayloadSchemaType.KEYWORD,
                )
            except Exception:  # noqa: BLE001 - 인덱스는 최적화일 뿐
                logger.debug("textbook %s 인덱스 생성 생략", field)
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


async def delete_textbook_source(source_name: str) -> None:
    """textbook 컬렉션에서 해당 source_name 포인트 전부 삭제.

    재인제스트 정합성: 청크 수가 줄면 결정론 id 업서트만으로는 옛 tail
    포인트가 남으므로, 업서트 전에 소스 단위로 지운다 (스크립트 전용).
    """
    client = get_client()
    await client.delete(
        collection_name=COL_TEXTBOOK,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="source_name",
                        match=models.MatchValue(value=source_name),
                    )
                ]
            )
        ),
        wait=True,
    )


async def scroll_canvas_cards(
    owner_id: str,
    session_id: str,
    *,
    limit: int = 200,
    with_vectors: bool = False,
) -> list[dict]:
    """canvas_cards 컬렉션을 세션 필터로 scroll — payload(+옵션 벡터) 반환.

    반환: [{"id": str, "payload": {...}}] (with_vectors=True면 각 dict에 "vector" 추가).
    owner_id + session_id 조합으로 강제 스코핑 (Qdrant는 RLS 없음).
    """
    client = get_client()
    query_filter = models.Filter(
        must=[
            models.FieldCondition(
                key="owner_id",
                match=models.MatchValue(value=owner_id),
            ),
            models.FieldCondition(
                key="session_id",
                match=models.MatchValue(value=session_id),
            ),
        ]
    )
    result, _next = await client.scroll(
        collection_name=COL_CANVAS_CARDS,
        scroll_filter=query_filter,
        limit=limit,
        with_vectors=with_vectors,
        with_payload=True,
    )
    out: list[dict] = []
    for pt in result:
        item = {"id": str(pt.id), "payload": pt.payload or {}}
        if with_vectors:
            item["vector"] = pt.vector
        out.append(item)
    return out


async def upsert_canvas_card(
    owner_id: str,
    session_id: str,
    node_id: str,
    concept_index: int,
    title: str,
    x: float,
    y: float,
    size_h: float,
    vector: list[float],
) -> None:
    """canvas_cards 멱등 upsert. 좌표(연속)+크기+벡터 저장."""
    client = get_client()
    point = models.PointStruct(
        id=canvas_card_point_id(node_id, concept_index),
        vector=vector,
        payload={
            "owner_id": owner_id,
            "session_id": session_id,
            "node_id": node_id,
            "concept_index": concept_index,
            "title": title,
            "x": x,
            "y": y,
            "size_h": size_h,
        },
    )
    await client.upsert(collection_name=COL_CANVAS_CARDS, points=[point])


async def search_canvas_cards(
    vector: list[float],
    owner_id: str,
    session_id: str,
    k: int = 1,
) -> list[dict]:
    """canvas_cards kNN top-k — owner+session 필터 강제.

    반환: [{"id","score","payload"}]
    """
    client = get_client()
    query_filter = models.Filter(
        must=[
            models.FieldCondition(
                key="owner_id",
                match=models.MatchValue(value=owner_id),
            ),
            models.FieldCondition(
                key="session_id",
                match=models.MatchValue(value=session_id),
            ),
        ]
    )
    res = await client.query_points(
        collection_name=COL_CANVAS_CARDS,
        query=vector,
        limit=k,
        query_filter=query_filter,
        with_payload=True,
    )
    return [
        {"id": str(pt.id), "score": pt.score, "payload": pt.payload or {}}
        for pt in res.points
    ]


async def search(
    collection: str,
    vector: list[float],
    k: int,
    *,
    file_ids: list[str] | None = None,
    score_threshold: float | None = None,
) -> list[dict]:
    """코사인 유사도 검색 -> [{"id","score","payload"}] (score 높을수록 유사).

    file_ids가 주어지면 payload.file_id MatchAny 필터를 must로 강제한다
    (RAG 스코핑 — 호출부는 RLS로 스코프된 조회에서 접근 가능 file_id를 파생).
    빈 목록은 "접근 가능한 파일 없음" — 즉시 빈 결과.
    """
    if file_ids is not None and not file_ids:
        return []
    query_filter = None
    if file_ids is not None:
        query_filter = models.Filter(
            must=[
                models.FieldCondition(
                    key="file_id",
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
