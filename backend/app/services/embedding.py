"""텍스트 임베딩(Upstage 위임) + 청킹.

임베딩은 services/upstage.py가 담당 — 비대칭 4096d 모델(질의=embedding-query,
문서=embedding-passage), 배치 분할·재시도·L2 정규화 포함. 기존 호출부 호환을
위해 Gemini식 task_type 파라미터를 유지하고 kind로 매핑한다.

벡터는 더 이상 Supabase에 저장하지 않는다(Qdrant 이전, migration 0028) —
과거 vector(768) 컬럼 계약 상수(DB_VECTOR_DIM)와 차원 가드는 폐기. 차원
검증은 upstage.embed_texts(EMBED_DIM=4096)와 Qdrant 컬렉션이 수행한다.
"""

from __future__ import annotations

import logging
import re

from ..config import get_settings
from . import upstage

logger = logging.getLogger("nodi.embedding")
settings = get_settings()


def _kind_for(task_type: str) -> str:
    """Gemini task_type -> Upstage 비대칭 모델 kind 매핑(호출부 호환)."""
    return "query" if task_type == "RETRIEVAL_QUERY" else "passage"


async def embed_texts(
    texts: list[str],
    *,
    task_type: str = "RETRIEVAL_DOCUMENT",
) -> list[list[float]]:
    """텍스트 목록 -> L2 정규화된 4096d 벡터 목록 (Upstage).

    RETRIEVAL_QUERY -> kind="query", 그 외(RETRIEVAL_DOCUMENT) -> "passage".
    질의/문서 임베딩이 같은 비대칭 모델 쌍을 쓰므로 검색 공간이 일치한다.
    """
    if not texts:
        return []
    return await upstage.embed_texts(texts, kind=_kind_for(task_type))


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------
_PARA_SPLIT = re.compile(r"\n\s*\n")


def _hard_split(text: str, size: int, overlap: int) -> list[str]:
    """Fixed-window split with overlap for an over-long paragraph."""
    chunks: list[str] = []
    start = 0
    n = len(text)
    step = max(1, size - overlap)
    while start < n:
        chunks.append(text[start : start + size])
        start += step
    return chunks


def chunk_text(
    text: str, size: int | None = None, overlap: int | None = None
) -> list[str]:
    """Greedy paragraph-aware chunker with character overlap.

    Accumulates paragraphs up to `size`; paragraphs longer than `size` are
    hard-split. Carries `overlap` trailing chars between adjacent chunks for
    context continuity.
    """
    size = size or settings.chunk_size_chars
    overlap = overlap if overlap is not None else settings.chunk_overlap_chars
    text = (text or "").strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in _PARA_SPLIT.split(text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(para) > size:
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.extend(_hard_split(para, size, overlap))
            continue
        if buf and len(buf) + 1 + len(para) > size:
            chunks.append(buf)
            # carry overlap from the end of the flushed chunk
            tail = buf[-overlap:] if overlap else ""
            buf = (tail + "\n" + para).strip() if tail else para
        else:
            buf = f"{buf}\n{para}".strip() if buf else para
    if buf:
        chunks.append(buf)
    return [c for c in (c.strip() for c in chunks) if c]
