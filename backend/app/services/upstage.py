"""Upstage API 클라이언트 — 임베딩(4096d) + 문서 파싱(Document Parse).

임베딩은 비대칭 모델: 질의는 `embedding-query`, 문서는 `embedding-passage`
(혼용 시 검색 품질 저하 — 반드시 kind로 구분). 출력은 4096차원이며 문서상
정규화되어 나오지만, 코사인=내적 불변식을 위해 방어적으로 L2 정규화한다.

문서 파싱(Document Parse)은 PDF와 이미지를 하나의 엔드포인트로 커버
(기존 Gemini OCR 텍스트 추출 대체). 100p 초과 문서는 async 폴링 경로.

로컬 모델/torch 없음 — 전부 HTTP 호출(httpx).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.upstage")
settings = get_settings()

# Upstage 임베딩 모델의 고정 출력 차원. Qdrant 컬렉션(size=4096)과의 계약.
EMBED_DIM = 4096

# 요청당 입력 상한(배치 <=100) / 텍스트당 <=4000토큰 — 토크나이저 없이
# 문자 기준으로 방어적 절단(~8000자, 한글 기준 넉넉히 토큰 한도 아래).
_MAX_BATCH = 100
_MAX_CHARS = 8000

_TIMEOUT = 30.0  # 임베딩 요청 타임아웃(초)
_PARSE_TIMEOUT = 120.0  # 문서 파싱은 업로드/처리로 더 김
_MAX_RETRIES = 3  # 429/5xx/전송 오류 재시도 상한
_POLL_SECONDS = 5.0  # async 파싱 폴링 간격
_POLL_MAX_SECONDS = 900.0  # async 파싱 전체 대기 상한(무한 루프 방지)

# D78: Document Parse 요청당 파일 크기 하드 리밋(공식 문서 50MB). 초과 PDF는
# 페이지 분할 후 조각별 파싱(이미지는 분할 불가 — 업로드 단계 D77이 거절).
UPSTAGE_PARSE_MAX_BYTES = 50 * 1024 * 1024
_SEGMENT_TARGET_BYTES = 48 * 1024 * 1024  # 직렬화 오버헤드 마진
_SEGMENT_CONCURRENCY = 3  # 조각 파싱 동시성(요청 폭주 방지)


def _base() -> str:
    return settings.upstage_base_url.rstrip("/")


def _headers() -> dict[str, str]:
    if not settings.upstage_api_key:
        raise RuntimeError("UPSTAGE_API_KEY is not configured.")
    return {"Authorization": f"Bearer {settings.upstage_api_key}"}


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def _truncate(text: str) -> str:
    # 빈 입력은 API가 거부할 수 있어 공백 하나로 치환(호출부 방어).
    return (text or " ")[:_MAX_CHARS]


async def _post_with_retry(
    client: httpx.AsyncClient, url: str, **kwargs
) -> httpx.Response:
    """POST + 재시도: 429/5xx는 지수 백오프(Retry-After 존중), 그 외 4xx는 즉시 raise."""
    delay = 1.0
    last_exc: Exception | None = None
    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            resp = await client.post(url, **kwargs)
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt == _MAX_RETRIES:
                raise
            logger.warning(
                "Upstage 전송 오류(%s) — %.1fs 후 재시도 %d/%d",
                exc, delay, attempt, _MAX_RETRIES,
            )
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt == _MAX_RETRIES:
                resp.raise_for_status()
            wait = delay
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                try:
                    wait = max(wait, float(retry_after))
                except ValueError:
                    pass
            logger.warning(
                "Upstage HTTP %d — %.1fs 후 재시도 %d/%d",
                resp.status_code, wait, attempt, _MAX_RETRIES,
            )
            await asyncio.sleep(wait)
            delay *= 2
            continue
        resp.raise_for_status()
        return resp
    raise last_exc or RuntimeError("Upstage retry loop exhausted")  # 방어


# ---------------------------------------------------------------------------
# 임베딩 (OpenAI 호환 /embeddings)
# ---------------------------------------------------------------------------
def _model_for(kind: str) -> str:
    if kind == "query":
        return settings.upstage_embedding_query_model
    if kind == "passage":
        return settings.upstage_embedding_passage_model
    raise ValueError(f"unknown embedding kind: {kind!r} (expected 'query'|'passage')")


async def embed_texts(
    texts: list[str], *, kind: str = "passage"
) -> list[list[float]]:
    """텍스트 목록 -> L2 정규화된 4096d 벡터 목록.

    비대칭 모델이므로 kind를 반드시 구분: 질의="query", 문서="passage".
    배치 <=100 단위로 분할 호출하고, 응답은 index로 정렬해 입력 순서를 보존.
    """
    if not texts:
        return []
    model = _model_for(kind)
    prepared = [_truncate(t) for t in texts]
    out: list[list[float]] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for i in range(0, len(prepared), _MAX_BATCH):
            batch = prepared[i : i + _MAX_BATCH]
            resp = await _post_with_retry(
                client,
                f"{_base()}/embeddings",
                json={"model": model, "input": batch},
                headers=_headers(),
            )
            data = sorted(resp.json().get("data") or [], key=lambda d: d["index"])
            if len(data) != len(batch):
                raise RuntimeError(
                    f"Upstage embeddings: {len(batch)}개 입력에 {len(data)}개 응답"
                )
            for item in data:
                vec = [float(v) for v in item["embedding"]]
                if len(vec) != EMBED_DIM:
                    raise RuntimeError(
                        f"Upstage embeddings: 기대 차원 {EMBED_DIM}, 실제 {len(vec)}"
                    )
                out.append(_l2_normalize(vec))
    return out


async def embed_query(text: str) -> list[float]:
    """단일 질의 임베딩 편의 함수 (embedding-query)."""
    return (await embed_texts([text], kind="query"))[0]


async def embed_passages(texts: list[str]) -> list[list[float]]:
    """여러 문서 임베딩 편의 함수 (embedding-passage). 빈 입력 → []."""
    return await embed_texts(texts, kind="passage")


# ---------------------------------------------------------------------------
# 문서 파싱 (Document Parse — PDF/이미지 -> markdown)
# ---------------------------------------------------------------------------
def _extract_markdown(payload: dict) -> str:
    """파싱 응답 -> markdown (폴백: text -> elements 이어붙이기)."""
    content = payload.get("content") or {}
    md = (content.get("markdown") or "").strip()
    if md:
        return md
    text = (content.get("text") or "").strip()
    if text:
        return text
    parts: list[str] = []
    for el in payload.get("elements") or []:
        c = el.get("content") or {}
        seg = (c.get("markdown") or c.get("text") or c.get("html") or "").strip()
        if seg:
            parts.append(seg)
    return "\n\n".join(parts)


def _is_page_limit_error(resp: httpx.Response) -> bool:
    """sync 경로의 페이지 상한(>100p) 초과 오류인지 판별(방어적 문자열 매칭)."""
    if resp.status_code == 413:
        return True
    if resp.status_code != 400:
        return False
    body = resp.text.lower()
    return "page" in body and ("limit" in body or "exceed" in body or "maximum" in body)


def _parse_form() -> dict:
    return {
        "model": settings.upstage_document_parse_model,
        "output_formats": json.dumps(["markdown"]),
        "ocr": "auto",
    }


async def parse_document(data: bytes, filename: str) -> str:
    """PDF/이미지 바이트 -> markdown 텍스트.

    D78: 50MB 초과 PDF는 페이지-range 조각으로 분할해 조각별로 파싱한 뒤
    페이지 순으로 연결한다(Upstage 요청당 하드 리밋 우회). 그 외는 단일
    요청 경로. 파싱 실패는 raise — 호출부(워커)가 잡 실패로 처리한다.
    """
    if filename.lower().endswith(".pdf") and len(data) > UPSTAGE_PARSE_MAX_BYTES:
        return await _parse_large_pdf(data, filename)
    return await _parse_single(data, filename)


def _pdf_segments(
    data: bytes,
    target: int = _SEGMENT_TARGET_BYTES,
    hard: int = UPSTAGE_PARSE_MAX_BYTES,
) -> list[bytes]:
    """PDF를 페이지-range 조각(각 직렬화 크기 <= hard)으로 나눈다(순서 보존).

    페이지당 평균 바이트로 1차 그룹(타깃 이하 목표)을 잡고, 직렬화가 hard를
    넘는 그룹은 이분해 재시도한다(pypdf가 공유 리소스를 조각마다 복사해
    조각 합이 원본보다 커질 수 있음). 단일 페이지가 hard를 넘으면 분할
    불가 — raise. CPU 바운드 — 호출부가 asyncio.to_thread로 감싼다.
    """
    from io import BytesIO

    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(BytesIO(data))
    total_pages = len(reader.pages)
    if total_pages == 0:
        return []

    def serialize(start: int, end: int) -> bytes:  # [start, end)
        writer = PdfWriter()
        for i in range(start, end):
            writer.add_page(reader.pages[i])
        buf = BytesIO()
        writer.write(buf)
        return buf.getvalue()

    out: list[bytes] = []

    def emit(start: int, end: int) -> None:
        seg = serialize(start, end)
        if len(seg) <= hard:
            out.append(seg)
            return
        if end - start <= 1:
            raise RuntimeError(
                f"PDF 페이지 {start + 1}이 단독으로 {hard}B 초과 — 분할 불가"
            )
        mid = (start + end) // 2
        emit(start, mid)
        emit(mid, end)

    per_page = max(1, len(data) // total_pages)
    step = max(1, target // per_page)
    for s in range(0, total_pages, step):
        emit(s, min(s + step, total_pages))
    return out


async def _parse_large_pdf(data: bytes, filename: str) -> str:
    """D78: 대용량 PDF — 분할(스레드) 후 조각별 병렬 파싱, 페이지 순 연결."""
    segments = await asyncio.to_thread(
        _pdf_segments, data, _SEGMENT_TARGET_BYTES, UPSTAGE_PARSE_MAX_BYTES
    )
    logger.info(
        "D78 분할 파싱: %s %dB -> %d조각", filename, len(data), len(segments)
    )
    sem = asyncio.Semaphore(_SEGMENT_CONCURRENCY)

    async def parse_one(idx: int, seg: bytes) -> str:
        async with sem:
            return await _parse_single(seg, f"{filename}.part{idx + 1}.pdf")

    parts = await asyncio.gather(*(parse_one(i, s) for i, s in enumerate(segments)))
    return "\n\n".join(p for p in parts if p)


async def _parse_single(data: bytes, filename: str) -> str:
    """단일 요청 파싱 — sync(<=100p) 우선, 페이지 상한 초과 시 async 폴백.

    파싱 실패는 raise — 호출부(워커)가 잡 실패로 처리한다.
    """
    async with httpx.AsyncClient(timeout=_PARSE_TIMEOUT) as client:
        try:
            resp = await _post_with_retry(
                client,
                f"{_base()}/document-digitization",
                files={"document": (filename, data)},
                data=_parse_form(),
                headers=_headers(),
            )
            return _extract_markdown(resp.json())
        except httpx.HTTPStatusError as exc:
            if not _is_page_limit_error(exc.response):
                raise
            logger.info(
                "Document Parse sync 페이지 상한 초과 — async 경로로 전환: %s",
                filename,
            )
        return await _parse_document_async(client, data, filename)


async def _parse_document_async(
    client: httpx.AsyncClient, data: bytes, filename: str
) -> str:
    """async 제출 -> 5s 간격 폴링 -> 배치 download_url을 페이지 순으로 연결."""
    resp = await _post_with_retry(
        client,
        f"{_base()}/document-digitization/async",
        files={"document": (filename, data)},
        data=_parse_form(),
        headers=_headers(),
    )
    request_id = resp.json()["request_id"]

    waited = 0.0
    while True:
        await asyncio.sleep(_POLL_SECONDS)
        waited += _POLL_SECONDS
        st = await client.get(
            f"{_base()}/document-digitization/requests/{request_id}",
            headers=_headers(),
        )
        st.raise_for_status()
        body = st.json()
        status_ = body.get("status")
        if status_ == "completed":
            batches = body.get("batches") or []
            break
        if status_ == "failed":
            raise RuntimeError(
                f"Upstage document parse failed: {body.get('failure_message')!r}"
            )
        if waited >= _POLL_MAX_SECONDS:
            raise TimeoutError(
                f"Upstage async parse timed out after {int(waited)}s: {request_id}"
            )

    parts: list[str] = []
    # start_page 기준 정렬(동률은 안정 정렬로 응답 순서 유지) — 페이지 순 연결.
    for batch in sorted(batches, key=lambda b: b.get("start_page") or 0):
        url = batch.get("download_url")
        if not url:
            continue
        # download_url은 프리사인 URL — Authorization 헤더를 붙이지 않는다.
        dl = await client.get(url)
        dl.raise_for_status()
        md = _extract_markdown(dl.json())
        if md:
            parts.append(md)
    return "\n\n".join(parts)
