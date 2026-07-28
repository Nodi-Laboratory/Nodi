"""Visual RAG retrieval + chat injection (Stage 3b-2; Upstage+Qdrant 이전).

D82: 파일 링크·제안 엔진 제거로 RAG는 **학급 자료(class_material) 자동 스코프
단일 경로**로 단순화됐다. 학급 세션이면 그 학급의
class_material 파일을 링크 없이 검색 후보로 삼아 질의를 임베딩(Upstage query,
1024d)하고, cosine-search(Qdrant, file_id 페이로드 필터로 스코핑) 상위 청크에
전(全) 청크 거리 게이트(class_material_rag_max_distance)를 적용해 인사말·무관
질의 턴의 프롬프트 오염을 막은 뒤, SOURCE-LABELLED 참고 블록
("[학급 자료에서 참고]")으로 주입한다. 개인 공간·비학급 세션엔 주입 없음.

Qdrant는 신뢰 경계가 아니다 — 히트한 chunk_id의 본문/메타는 반드시 USER
스코프 클라이언트로 Supabase에서 재조회해 RLS가 접근(소유/클래스 자료)을
재검증한다(교차 유저 유출 불변식 유지).

Best-effort: any failure -> no RAG context, never blocks the turn.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings, embedding, qdrant_store

logger = logging.getLogger("nodi.rag")
settings = get_settings()


def _file_basename(storage_path: str | None) -> str:
    """Filename from a "{owner}/{file_id}/{name}" storage path."""
    return (storage_path or "").split("/")[-1]


async def search(
    client: UserClient, file_ids: list[str], query: str, k: int | None = None
) -> list[dict[str, Any]]:
    """Qdrant 코사인 top-K -> Supabase 본문 재조회(RLS) -> 구 RPC 호환 rows.

    반환 shape: {file_id, chunk_id, seq, chunk_text, distance}.
    Qdrant는 유사도(score, 높을수록 유사)를 주므로 distance = 1 - score로
    변환해 기존 거리 임계값(0.60 등) 의미를 그대로 유지한다.
    """
    if not file_ids or not query.strip():
        return []
    if k is None:
        # RAG-injection path. D62: admin-tunable rag_top_k가 config 기본을 덮는다.
        overlay = await app_settings.get_overlay()
        k = app_settings.as_int(overlay, "rag_top_k", settings.rag_top_k, 1, 50)
    vec = await embedding.embed_texts([query], task_type="RETRIEVAL_QUERY")
    if not vec:
        return []
    hits = await qdrant_store.search(
        qdrant_store.COL_FILE_CHUNKS,
        vec[0],
        k,
        file_ids=[str(f) for f in file_ids],
    )
    if not hits:
        return []
    # 유사도 -> 거리 변환. 포인트 id == 청크 uuid(워커 업서트 규약).
    distances = {h["id"]: 1.0 - float(h["score"]) for h in hits}
    # 본문은 USER 스코프 클라이언트로 재조회 — RLS가 소유/클래스 자료 접근을
    # 재검증한다(Qdrant 페이로드의 본문 없음 + 신뢰 경계 아님).
    rows = await client.select(
        "file_chunks",
        {
            "id": f"in.({','.join(distances)})",
            "status": "eq.embedded",
            "select": "id,file_id,seq,chunk_text",
        },
    )
    by_id = {str(r["id"]): r for r in rows}
    out: list[dict[str, Any]] = []
    for h in hits:  # Qdrant 랭킹 유지; RLS/삭제로 못 읽는 id는 조용히 탈락
        r = by_id.get(h["id"])
        if not r:
            continue
        out.append(
            {
                "file_id": r.get("file_id"),
                "chunk_id": r.get("id"),
                "seq": r.get("seq"),
                "chunk_text": r.get("chunk_text"),
                "distance": distances[h["id"]],
            }
        )
    return out


SNIPPET_CHARS = 300


def _source_label(name: str, seq: Any) -> str:
    """Inline provenance label for a chunk, e.g. "note.pdf · #12"."""
    parts: list[str] = []
    if name:
        parts.append(name)
    if seq is not None:
        parts.append(f"#{seq}")
    return " · ".join(parts)


def build_block(chunks: list[dict[str, Any]], names: dict[str, str]) -> str:
    """Render retrieved chunks as a SOURCE-LABELLED reference block (D32).

    Each line carries its provenance inline so the model — and the saved system
    prompt — show which file·chunk a passage came from.
    """
    if not chunks:
        return ""
    lines = ["[학급 자료에서 참고]"]
    for c in chunks:
        text = (c.get("chunk_text") or "").strip()
        if not text:
            continue
        label = _source_label(names.get(c.get("file_id"), ""), c.get("seq"))
        prefix = f"[{label}] " if label else ""
        lines.append(f"- {prefix}{text}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_sources(
    chunks: list[dict[str, Any]], names: dict[str, str]
) -> list[dict[str, Any]]:
    """Per-chunk provenance metadata (D32/D35): file·#seq·distance·snippet."""
    sources: list[dict[str, Any]] = []
    for c in chunks:
        fid = c.get("file_id")
        if not fid:
            continue
        sources.append(
            {
                "file_id": fid,
                # D41: keep the chunk id so the "⋯" panel can fetch the full
                # text + neighbours on demand (get_chunk_context). Older nodes
                # saved before this may lack it → frontend treats it as optional.
                "chunk_id": c.get("chunk_id"),
                "name": names.get(fid, ""),
                "seq": c.get("seq"),
                "distance": c.get("distance"),
                "snippet": (c.get("chunk_text") or "")[:SNIPPET_CHARS],
            }
        )
    return sources


async def file_names(
    client: UserClient, file_ids: list[str]
) -> dict[str, str]:
    """Map file_id -> 표시명 in one query. D79: files.name(원본 표시명) 우선,
    구파일(name NULL — 백필 전)은 storage_path basename으로 폴백."""
    if not file_ids:
        return {}
    rows = await client.select(
        "files",
        {
            "id": f"in.({','.join(file_ids)})",
            "select": "id,name,storage_path",
        },
    )
    return {
        r["id"]: (r.get("name") or _file_basename(r.get("storage_path")))
        for r in rows
    }


async def class_material_file_ids(
    client: UserClient, space_ref: str
) -> list[str]:
    """학급 자료 중 검색 가능한(indexed/partial) 파일 id들 (D73).

    교과서 텍스트 포함(0038, TASK 4): kind in (class_material, textbook) —
    교사가 올린 교과서(kind=textbook)의 텍스트 청크도 자동으로
    [학급 자료에서 참고] 후보에 합류한다. partial도 임베딩된 청크는 검색 가능.
    USER 스코프 조회 — RLS(0012/0038)가 학급 구성원 여부를 재검증한다.
    """
    rows = await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{space_ref}",
            "kind": "in.(class_material,textbook)",
            "status": "in.(indexed,partial)",
            "select": "id",
        },
    )
    return [r["id"] for r in rows if r.get("id")]


async def textbook_file_ids(client: UserClient, space_ref: str) -> list[str]:
    """학급 교과서(kind=textbook) 파일 id들 — figure 스코프 필터용 (TASK 4, D88).

    class_material_file_ids와 동형이되 kind=textbook, **status 필터 없음**:
    figure 가용성은 텍스트 청크 status와 독립이다 — Qdrant textbook_figures엔
    embedded figure 포인트만 존재하므로 텍스트가 아직 partial/미완이어도 figure는
    검색 가능해야 한다. USER 스코프 조회 — RLS(0038)가 학급 구성원 여부를
    재검증하고, 검색 히트 후 textbook_figures RLS 재조회가 최종 안전망이다.
    """
    rows = await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{space_ref}",
            "kind": "eq.textbook",
            "select": "id",
        },
    )
    return [r["id"] for r in rows if r.get("id")]


async def build_rag_context(
    client: UserClient,
    query: str,
    *,
    space_kind: str | None = None,
    space_ref: str | None = None,
) -> dict[str, Any] | None:
    """Best-effort: 학급 자료(class_material) 자동 스코프 참고 블록 + 출처 메타.

    D73/D82: 학급 세션(space_kind='class')이면 그 학급의 class_material 파일을
    링크 없이 검색해, 전(全) 청크에 거리 게이트(class_material_rag_max_distance)를
    적용한다(인사말·무관 질의 턴의 프롬프트 오염 차단). 개인 공간·비학급 세션은
    주입하지 않는다(None). enabled 킬 스위치가 off면 조회 없이 None(D62 오버레이).

    Returns ``{"block": str, "sources": [ {file_id, name, seq, distance,
    snippet} ]}`` or ``None`` when there is nothing to inject. Callers use
    ``block`` for the system prompt and ``sources`` for node/log provenance (D32).
    """
    try:
        if space_kind != "class" or not space_ref:
            return None
        overlay = await app_settings.get_overlay()
        if not app_settings.as_bool(
            overlay,
            "class_material_rag_enabled",
            settings.class_material_rag_enabled,
        ):
            return None
        file_ids = await class_material_file_ids(client, space_ref)
        if not file_ids:
            return None
        max_dist = app_settings.as_float(
            overlay,
            "class_material_rag_max_distance",
            settings.class_material_rag_max_distance,
            0.1,
            0.9,
        )
        chunks = await search(client, file_ids, query)
        # D82: 링크 개념 소멸 → 전 청크에 거리 게이트(무게이트 예외 없음).
        chunks = [
            c
            for c in chunks
            if c.get("distance") is not None and c["distance"] <= max_dist
        ]
        if not chunks:
            return None
        hit_ids = list({c.get("file_id") for c in chunks if c.get("file_id")})
        names = await file_names(client, hit_ids)
        block = build_block(chunks, names)
        if not block:
            return None
        # D76 부수: 주입 관측성 — 마무리 E2E의 주입 증거(기존 RAG 관측성 0).
        logger.info("RAG 주입: files=%d chunks=%d", len(hit_ids), len(chunks))
        return {"block": block, "sources": build_sources(chunks, names)}
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("RAG retrieval failed")
        return None

