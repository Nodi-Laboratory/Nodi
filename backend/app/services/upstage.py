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
# D86: 교과서 구조화 파싱은 조각당 sync 페이지 상한(<=100p) 이하로 사전 분할해
# async(>100p) 경로를 원천 회피한다 — 페이지 오프셋을 결정론적으로 소유(D78 확장).
_FULL_MAX_PAGES = 100


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


def _parse_form(figures: bool = False) -> dict:
    """Document Parse 폼 데이터.

    figures=False: class_material 경로용 — markdown만(기존 dict 불변).
    figures=True(D86): 교과서 구조화 파싱 — coordinates로 위치기반 캡션 매칭의
    전제(좌표)를 확보하고, markdown(텍스트 청킹용)과 html/elements(figure용)를
    **한 응답에서** 함께 받고, base64_encoding으로 figure 크롭 이미지를 받는다.
    텍스트·figure를 2회로 나눠 요청하면 항상 더 비싸므로 한 응답을 공유한다(D86).

    D92(사용자 결정 2026-07-18): mode=enhanced 제거 — enhanced 산출물(영어
    figure-description/figure-type)은 D91로 임베딩에서 빠져 소비처가 없고,
    표준 모드도 figure 요소·크롭·좌표를 동일하게 반환함을 동일 PDF 실측으로
    확인(figure 8/8, base64·coordinates 전부 존재). 판정(EXAONE 비전)은
    크롭+후보만 쓰므로 무영향. 표준 단가로 페이지당 과금 절감.
    """
    form = {
        "model": settings.upstage_document_parse_model,
        "output_formats": json.dumps(["markdown"]),
        "ocr": "auto",
    }
    if figures:
        form["coordinates"] = "true"
        form["output_formats"] = json.dumps(["markdown", "html"])
        form["base64_encoding"] = json.dumps(["figure"])
    return form


async def parse_document(data: bytes, filename: str) -> str:
    """PDF/이미지 바이트 -> markdown 텍스트.

    D78: 50MB 초과 PDF는 페이지-range 조각으로 분할해 조각별로 파싱한 뒤
    페이지 순으로 연결한다(Upstage 요청당 하드 리밋 우회). 그 외는 단일
    요청 경로. 파싱 실패는 raise — 호출부(워커)가 잡 실패로 처리한다.
    """
    if filename.lower().endswith(".pdf") and len(data) > UPSTAGE_PARSE_MAX_BYTES:
        return await _parse_large_pdf(data, filename)
    return await _parse_single(data, filename)


def _pdf_segment_ranges(
    data: bytes,
    target: int = _SEGMENT_TARGET_BYTES,
    hard: int = UPSTAGE_PARSE_MAX_BYTES,
    max_pages: int | None = None,
) -> list[tuple[int, bytes]]:
    """PDF를 페이지-range 조각으로 나눠 (시작 페이지 0-base, 직렬화 bytes) 목록 반환.

    페이지당 평균 바이트로 1차 그룹(타깃 이하 목표)을 잡고, 직렬화가 hard를
    넘는 그룹은 이분해 재시도한다(pypdf가 공유 리소스를 조각마다 복사해
    조각 합이 원본보다 커질 수 있음). 단일 페이지가 hard를 넘으면 분할
    불가 — raise. 결과는 페이지 순(시작 페이지 오름차순) — 조각별 요소의
    page/id 오프셋 보정을 위해 시작 페이지를 함께 돌려준다.

    max_pages(D86): 조각당 페이지 수 상한. figures 경로에서 조각당 ≤100페이지를
    강제해 전 조각이 sync 경로만 타게 한다(기본 None이면 크기만으로 분할).
    이분해는 페이지 수를 줄이므로 상한은 계속 유지된다. CPU 바운드 —
    호출부가 asyncio.to_thread로 감싼다.
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

    out: list[tuple[int, bytes]] = []

    def emit(start: int, end: int) -> None:
        seg = serialize(start, end)
        if len(seg) <= hard:
            out.append((start, seg))
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
    if max_pages is not None:
        step = min(step, max_pages)
    for s in range(0, total_pages, step):
        emit(s, min(s + step, total_pages))
    return out


def _pdf_segments(
    data: bytes,
    target: int = _SEGMENT_TARGET_BYTES,
    hard: int = UPSTAGE_PARSE_MAX_BYTES,
) -> list[bytes]:
    """`_pdf_segment_ranges`의 bytes-only 얇은 래퍼(기존 호출부·계약 보존)."""
    return [seg for _, seg in _pdf_segment_ranges(data, target, hard)]


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


async def _parse_single_payload(
    client: httpx.AsyncClient,
    data: bytes,
    filename: str,
    *,
    figures: bool = False,
) -> dict:
    """단일 sync 요청 파싱 -> 응답 payload dict(재시도/백오프는 기존 규약 재사용).

    markdown뿐 아니라 elements(figure)까지 필요한 교과서 경로가 payload 전체를
    쓸 수 있게 공통부를 분리한다 — `_parse_single`은 이 위의 얇은 래퍼.
    페이지 상한(>100p) 초과 async 폴백은 포함하지 않는다(호출부가 판단).
    """
    resp = await _post_with_retry(
        client,
        f"{_base()}/document-digitization",
        files={"document": (filename, data)},
        data=_parse_form(figures=figures),
        headers=_headers(),
    )
    return resp.json()


async def _parse_single(data: bytes, filename: str) -> str:
    """단일 요청 파싱 — sync(<=100p) 우선, 페이지 상한 초과 시 async 폴백.

    파싱 실패는 raise — 호출부(워커)가 잡 실패로 처리한다.
    """
    async with httpx.AsyncClient(timeout=_PARSE_TIMEOUT) as client:
        try:
            payload = await _parse_single_payload(client, data, filename)
            return _extract_markdown(payload)
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


async def parse_document_full(data: bytes, filename: str) -> tuple[str, list[dict]]:
    """교과서(D86) 전용 구조화 파싱 — enhanced 1회 공유로 (markdown, elements) 동시 취득.

    반환: (markdown 전체, elements 전체). elements의 page는 **전역 1-base**
    (Upstage 응답 규약 유지), id는 조각 오프셋 보정으로 **전역 유일**.

    PDF는 **무조건 사전 분할**(조각당 ≤48MB 그리고 ≤100페이지)해 전 조각이 sync
    단일 요청 경로만 탄다. async(>100p) 경로는 배치별 elements의 page 기준이
    전역/로컬 중 무엇인지 문서상 불명확하므로, 사전 페이지 분할로 오프셋을 우리가
    결정론적으로 소유한다(D78 확장). 작은 PDF(≤48MB·≤100p)는 조각 1개로 동일 경로.
    PDF가 아닌 입력은 분할 불가 — 단일 sync 요청(방어적: 교과서는 PDF 전용이나
    함수 자체는 안전해야 함). 파싱 실패는 raise — 호출부(워커)가 잡 실패로 처리.
    """
    is_pdf = filename.lower().endswith(".pdf")
    if is_pdf:
        ranges = await asyncio.to_thread(
            _pdf_segment_ranges,
            data,
            _SEGMENT_TARGET_BYTES,
            UPSTAGE_PARSE_MAX_BYTES,
            _FULL_MAX_PAGES,
        )
    else:
        ranges = [(0, data)]  # 분할 불가 — 시작 페이지 0(page 오프셋 없음)
    multi = len(ranges) > 1

    async with httpx.AsyncClient(timeout=_PARSE_TIMEOUT) as client:
        sem = asyncio.Semaphore(_SEGMENT_CONCURRENCY)

        async def parse_seg(idx: int, seg: bytes) -> dict:
            name = f"{filename}.part{idx + 1}.pdf" if multi else filename
            async with sem:
                return await _parse_single_payload(client, seg, name, figures=True)

        # gather는 입력 순서를 보존 — ranges(페이지 순)와 순서가 일치한다.
        payloads = await asyncio.gather(
            *(parse_seg(i, seg) for i, (_start, seg) in enumerate(ranges))
        )

    md_parts: list[str] = []
    elements: list[dict] = []
    id_offset = 0  # 이전 조각까지의 누적 요소 수(전역 유일 id 오프셋)
    for (start_page, _seg), payload in zip(ranges, payloads):
        md = _extract_markdown(payload)
        if md:
            md_parts.append(md)
        seg_elements = payload.get("elements") or []
        for el in seg_elements:
            if el.get("page") is not None:
                # 로컬 1-base + 조각 시작(0-base) = 전역 1-base.
                el["page"] += start_page
            if el.get("id") is not None:
                el["id"] += id_offset
            elements.append(el)
        id_offset += len(seg_elements)

    return "\n\n".join(md_parts), elements
