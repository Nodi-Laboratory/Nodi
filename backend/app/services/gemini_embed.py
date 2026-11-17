"""Gemini 임베딩(1024d) — Upstage 임베딩의 같은 얼굴을 한 대체 구현 (2026-11-17).

사용자 결정 "모두 gemini로"에 따라 공개 배포는 임베딩도 Gemini로 간다. 단 **문서
파싱은 Upstage에 남는다**(구조화 요소·좌표·도판 크롭에 대응하는 Gemini API가
없다 — services/upstage.py `parse_document*`).

## 어떻게 고르나 — 키가 아니라 설정이다

`settings.embedding_provider`("upstage"|"gemini", env EMBEDDING_PROVIDER)가 정한다.
`upstage.embed_*`가 그 값으로 이쪽을 부른다(호출부 8곳은 그대로다). **키 유무로
고르지 않는 이유**: 색인 때와 질의 때 제공자가 갈리면 두 벡터가 서로 다른 공간에
있어 코사인이 의미를 잃는데, **오류는 나지 않고 검색만 조용히 빈손이 된다.**
대회 운영 서버는 Upstage 벡터가 이미 Qdrant에 있고 Gemini 키가 없다 — 기본값이
"upstage"인 이유다.

## 비대칭 불변식

Upstage의 `embedding-query` / `embedding-passage` 짝은 여기서 taskType
`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`다. 같은 모델이 taskType으로 벡터를
달리 만들므로 **혼용하면 같은 식으로 품질이 떨어진다**(kind로 구분).

## 실측으로 정한 것 (2026-11-17, 실물 호출)

  · 모델 `gemini-embedding-001`(안정판). `-2`/`-2-preview`도 있으나 이쪽으로 충분했다.
  · `outputDimensionality=1024` — Qdrant 컬렉션이 1024d/Cosine이다(Upstage와 같다).
  · ⚠️ **축소 출력은 정규화돼 있지 않다**(1024d 노름 0.6165 — 3072d 원본만 단위
    벡터다). 그대로 쓰면 내적이 코사인이 아니라서 거리 게이트(`1 - score`)가
    통째로 틀어진다. 그래서 **반드시 L2 정규화**한다.
  · 배치는 `batchEmbedContents`, 요청당 입력 <=100.

키는 `api_keys.gemini_key()`(env 우선, 없으면 이 요청의 헤더 키 — 질의는 요청
범위라 헤더 키가 닿고, 워커는 env만 본다). **키는 `x-goog-api-key` 헤더로만
보낸다** — URL 쿼리(`?key=`)에 넣으면 httpx 오류 문자열·접근 로그에 그대로 남는다.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re

import httpx

from ..config import get_settings
from . import api_keys

logger = logging.getLogger("nodi.gemini_embed")
settings = get_settings()

# 차원 계약 — Qdrant 컬렉션 size와 같다(upstage.EMBED_DIM과 일치해야 한다. 테스트가 지킨다).
EMBED_DIM = 1024

# batchEmbedContents 요청당 입력 상한(문서 100). upstage.EMBED_MAX_BATCH와 같은
# 값이라 워커가 같은 단위로 청크를 쪼개도 조각 하나가 상한을 넘지 않는다.
EMBED_MAX_BATCH = 100

# gemini-embedding-001 입력 상한은 2048토큰이다. 토크나이저 없이 문자로 방어적
# 절단한다 — 한국어는 1토큰이 대략 1~2자라 3000자면 한도 아래다.
_MAX_CHARS = 3000

_TASK_TYPES = {"query": "RETRIEVAL_QUERY", "passage": "RETRIEVAL_DOCUMENT"}

_TIMEOUT = 30.0
_MAX_RETRIES = 6  # Gemini 429는 분당 한도라 Upstage(3회)보다 오래 기다린다(1+2+4+8+16 = 31s)
_MAX_WAIT_S = 60.0  # 서버가 길게 기다리라 해도 한 번에 이 이상은 안 잔다


def _model() -> str:
    return (settings.gemini_embedding_model or "gemini-embedding-001").strip()


def _headers() -> dict[str, str]:
    key = api_keys.gemini_key()
    if not key:
        # upstage._headers와 같은 종류의 예외 — 호출부는 "RAG 건너뜀"으로 다룬다.
        raise RuntimeError("GEMINI_API_KEY is not configured.")
    return {"x-goog-api-key": key, "Content-Type": "application/json"}


def _url() -> str:
    return f"{settings.gemini_base_url.rstrip('/')}/models/{_model()}:batchEmbedContents"


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _truncate(text: str) -> str:
    return (text or " ")[:_MAX_CHARS]


_RETRY_DELAY = re.compile(r'"retryDelay"\s*:\s*"([\d.]+)s"')


def _retry_wait(resp: httpx.Response, fallback: float) -> float:
    """429 대기 시간 — Retry-After 헤더, 없으면 본문 `retryDelay`("34s"), 없으면 백오프."""
    wait = fallback
    header = resp.headers.get("Retry-After")
    candidates: list[float] = []
    if header:
        try:
            candidates.append(float(header))
        except ValueError:
            pass
    m = _RETRY_DELAY.search(resp.text or "")
    if m:
        candidates.append(float(m.group(1)))
    if candidates:
        wait = max(wait, *candidates)
    return min(wait, _MAX_WAIT_S)


async def _post_with_retry(client: httpx.AsyncClient, **kwargs) -> httpx.Response:
    """POST + 재시도: 429/5xx/전송 오류는 지수 백오프, 그 외 4xx는 즉시 raise.

    로그에는 상태 코드와 대기만 적는다 — 요청 헤더(키)·본문(사용자 텍스트)은 남기지 않는다.
    """
    delay = 1.0
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = await client.post(_url(), **kwargs)
        except httpx.TransportError as exc:
            if attempt == _MAX_RETRIES:
                raise
            logger.warning(
                "Gemini 임베딩 전송 오류(%s) — %.1fs 후 재시도 %d/%d",
                type(exc).__name__, delay, attempt, _MAX_RETRIES,
            )
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == _MAX_RETRIES:
                resp.raise_for_status()
            wait = _retry_wait(resp, delay)
            logger.warning(
                "Gemini 임베딩 HTTP %d — %.1fs 후 재시도 %d/%d",
                resp.status_code, wait, attempt, _MAX_RETRIES,
            )
            await asyncio.sleep(wait)
            delay *= 2
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError("Gemini embedding retry loop exhausted")  # 방어


async def embed_texts(
    texts: list[str], *, kind: str = "passage", concurrency: int | None = None
) -> list[list[float]]:
    """텍스트 목록 -> L2 정규화된 EMBED_DIM 차원 벡터 목록 (upstage.embed_texts와 같은 계약).

    질의="query"(RETRIEVAL_QUERY), 문서="passage"(RETRIEVAL_DOCUMENT). 100개 단위로
    쪼개 동시에 보내고(D195), 응답 순서가 곧 입력 순서다 — Gemini 배치 응답에는
    index가 없으므로 **gather가 돌려주는 입력 순서**로만 조각을 잇는다.
    """
    if not texts:
        return []
    task = _TASK_TYPES.get(kind)
    if task is None:
        raise ValueError(f"unknown embedding kind: {kind!r} (expected 'query'|'passage')")
    model_ref = f"models/{_model()}"
    prepared = [_truncate(t) for t in texts]
    slices = [
        prepared[i : i + EMBED_MAX_BATCH] for i in range(0, len(prepared), EMBED_MAX_BATCH)
    ]

    async def _one(client: httpx.AsyncClient, batch: list[str]) -> list[list[float]]:
        resp = await _post_with_retry(
            client,
            json={
                "requests": [
                    {
                        "model": model_ref,
                        "content": {"parts": [{"text": t}]},
                        "taskType": task,
                        # 이 값이 빠지면 3072가 돌아와 아래 차원 검증에서 즉시 실패한다.
                        "outputDimensionality": EMBED_DIM,
                    }
                    for t in batch
                ]
            },
            headers=_headers(),
        )
        items = resp.json().get("embeddings") or []
        if len(items) != len(batch):
            raise RuntimeError(f"Gemini embeddings: {len(batch)}개 입력에 {len(items)}개 응답")
        vectors: list[list[float]] = []
        for item in items:
            vec = [float(v) for v in item["values"]]
            if len(vec) != EMBED_DIM:
                raise RuntimeError(f"Gemini embeddings: 기대 차원 {EMBED_DIM}, 실제 {len(vec)}")
            vectors.append(_l2_normalize(vec))
        return vectors

    limit = max(1, concurrency or settings.embedding_request_concurrency)
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        if len(slices) == 1:
            return await _one(client, slices[0])
        sem = asyncio.Semaphore(limit)

        async def _guarded(batch: list[str]) -> list[list[float]]:
            async with sem:
                return await _one(client, batch)

        parts = await asyncio.gather(*(_guarded(s) for s in slices))
    return [vec for part in parts for vec in part]


async def embed_query(text: str) -> list[float]:
    return (await embed_texts([text], kind="query"))[0]


async def embed_passages(texts: list[str]) -> list[list[float]]:
    return await embed_texts(texts, kind="passage")
