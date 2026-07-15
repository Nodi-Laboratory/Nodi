# 교사 자료 대용량 업로드 (D77·D78) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교사 학급 자료(class_material)는 500MB까지 업로드·인덱싱 가능하게
하고(50MB 초과 PDF는 분할 파싱), 학생 업로드는 50MB로 상향한다.

**Architecture:** kind별 상한 해석을 `resolve_upload_max_bytes` 한 곳으로
모으고(라우터·서비스 공용), `upstage.parse_document`를 디스패처로 바꿔 50MB
초과 PDF를 pypdf 페이지-range 조각(이분 재시도)으로 나눠 조각별 병렬
파싱한다. 이미지는 분할 불가라 50MB 초과 시 업로드 단계에서 422.

**Tech Stack:** FastAPI, pypdf(기존 의존성), Upstage Document Parse, pytest.

**스펙:** `docs/superpowers/specs/2026-07-15-class-material-large-upload-design.md`

## Global Constraints

- 튜너블(D62): config 기본값 + `app_settings.as_*` + clamp + 시드 마이그레이션
  (**파일만 추가 — 원격 적용 금지**). `class_material_max_bytes` 기본
  524288000, clamp 1MB~512MB. `file_max_bytes` 기본 52428800(clamp 유지).
- `async def` 안에서 블로킹 호출 금지 — pypdf 분할은 `asyncio.to_thread`.
- 주석·docstring·커밋 메시지 한국어, D-번호(D77·D78). 커밋 `[feat]:`.
- `git add`는 자기 task 파일만.
- 백엔드 테스트: 워크트리에서는
  `/Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
  (메인 저장소 `backend/.env`를 자기 워크트리로 복사 후).

## 파일 경계 (task 간 서로소 — 병렬 가능)

| task | 파일 |
|---|---|
| A (백엔드) | `backend/app/config.py`, `backend/app/routers/files.py`, `backend/app/services/files.py`, `backend/app/services/upstage.py`, `supabase/migrations/0030_app_settings_upload_limits.sql`, `backend/tests/test_upload_limits.py`, `backend/tests/test_pdf_split.py` |
| B (프론트 admin 메타) | `frontend/src/components/admin/SettingsTab.tsx` |

---

### Task A: kind별 상한(D77) + 대용량 PDF 분할 파싱(D78)

**Files:**
- Modify: `backend/app/config.py` (~110행 `file_max_bytes`)
- Modify: `backend/app/routers/files.py` (upload ~67-77행)
- Modify: `backend/app/services/files.py` (상수부 + `upload_file` 용량 검사부)
- Modify: `backend/app/services/upstage.py` (상수부 + `parse_document` ~203행)
- Create: `supabase/migrations/0030_app_settings_upload_limits.sql`
- Test: `backend/tests/test_upload_limits.py`, `backend/tests/test_pdf_split.py`

**Interfaces:**
- Consumes: 기존 `app_settings.as_int`, D75 `ALLOWED_UPLOAD_EXTENSIONS`와
  `upload_file`의 `ext` 계산부(files.py), 기존 sync→async 파싱 로직(upstage.py).
- Produces: `files.resolve_upload_max_bytes(overlay: dict, kind: str) -> int`,
  `upstage.UPSTAGE_PARSE_MAX_BYTES`(files.py가 임포트),
  `upstage._parse_single(data, filename)`(기존 parse_document 본문),
  `upstage._pdf_segments(data, target=..., hard=...) -> list[bytes]`.

- [ ] **Step 1: 실패 테스트 작성 — `backend/tests/test_upload_limits.py`**

```python
"""D77 — kind별 업로드 용량 상한 테스트.

실제 기본값(50MB/500MB)만큼 큰 페이로드는 느리므로, settings 속성을 clamp
하한 근처로 monkeypatch해 경계만 검증한다(클램프가 오버레이·기본값 공통
적용이라 오버레이 소값 주입은 불가).
"""

import pytest
from fastapi import HTTPException

from app.services import files as F

MB = 1024 * 1024


class _FakeService:
    def __init__(self):
        self.storage = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return True


async def _overlay():
    return {}


def test_default_limits():
    """스펙 기본값 — 학생 50MB, 학급 자료 500MB."""
    assert F.settings.file_max_bytes == 50 * MB
    assert F.settings.class_material_max_bytes == 500 * MB


def test_resolve_limit_by_kind():
    """① kind별 해석 — class_material만 대용량 노브를 탄다."""
    assert F.resolve_upload_max_bytes({}, "user_upload") == 50 * MB
    assert F.resolve_upload_max_bytes({}, "class_material") == 500 * MB


@pytest.mark.asyncio
async def test_user_upload_over_limit_413(monkeypatch):
    """② user_upload 상한 초과 → 413, 스토리지 업로드 전 거절."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", 2048)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "u1", "personal", None,
            "big.pdf", None, b"\0" * 4096,
        )
    assert ei.value.status_code == 413
    assert svc.storage == []


@pytest.mark.asyncio
async def test_class_material_uses_own_larger_limit(monkeypatch):
    """③ class_material은 file_max_bytes를 넘어도 자기 상한 이내면 통과."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", 2048)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(), "t1", "class", "c1",
        "book.pdf", None, b"\0" * 4096, kind="class_material",
    )
    assert row["status"] == "uploaded"
    assert len(svc.storage) == 1


@pytest.mark.asyncio
async def test_class_material_over_own_limit_413(monkeypatch):
    """④ class_material 자기 상한 초과 → 413 (clamp 하한 1MB로 검증)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F.settings, "class_material_max_bytes", MB)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "t1", "class", "c1",
            "book.pdf", None, b"\0" * (MB + 1), kind="class_material",
        )
    assert ei.value.status_code == 413


@pytest.mark.asyncio
async def test_oversized_image_rejected_422(monkeypatch):
    """⑤ 이미지는 분할 불가 — class_material이어도 파서 리밋 초과 시 422."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _overlay)
    monkeypatch.setattr(F, "UPSTAGE_PARSE_MAX_BYTES", 1024)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await F.upload_file(
            svc, _FakeUserClient(), "t1", "class", "c1",
            "scan.png", None, b"\0" * 2048, kind="class_material",
        )
    assert ei.value.status_code == 422
    assert "이미지" in ei.value.detail
    assert svc.storage == []
```

- [ ] **Step 2: 실패 테스트 작성 — `backend/tests/test_pdf_split.py`**

```python
"""D78 — 대용량 PDF 분할 파싱 테스트 (실제 Upstage 호출 없음).

블랭크 페이지 PDF의 절대 크기는 pypdf 버전에 따라 다르므로, 단일 페이지
직렬화 크기(unit)를 기준으로 하드 리밋을 상대 설정해 결정론을 확보한다.
"""

import io

import pytest
from pypdf import PdfReader, PdfWriter

from app.services import upstage as U


def _make_pdf(pages: int) -> bytes:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _single_page_size(data: bytes) -> int:
    r = PdfReader(io.BytesIO(data))
    w = PdfWriter()
    w.add_page(r.pages[0])
    buf = io.BytesIO()
    w.write(buf)
    return len(buf.getvalue())


def test_segments_cover_all_pages_within_hard_limit():
    """⑥ 조각이 전 페이지를 커버하고 각 조각이 하드 리밋 이하."""
    data = _make_pdf(10)
    unit = _single_page_size(data)
    hard = unit * 2 + 200  # 조각당 최대 ~2페이지 — 분할 강제, 1페이지는 항상 수용
    segs = U._pdf_segments(data, target=hard - 100, hard=hard)
    assert len(segs) >= 2
    assert all(len(s) <= hard for s in segs)
    assert sum(len(PdfReader(io.BytesIO(s)).pages) for s in segs) == 10


def test_small_pdf_single_segment():
    """기본 타깃(48MB)에서는 소형 PDF가 분할되지 않는다."""
    data = _make_pdf(2)
    assert len(U._pdf_segments(data)) == 1


@pytest.mark.asyncio
async def test_parse_document_dispatches_large_pdf(monkeypatch):
    """⑦ 50MB 초과 PDF → 분할 경로, 조각 결과가 페이지 순으로 연결."""
    data = _make_pdf(6)
    # 하드 리밋을 원본보다 1B 작게 → 디스패치 강제. 타깃도 동일값 →
    # 페이지당 평균 기준 5페이지 1차 그룹 → 2조각(5p+1p), 각각 리밋 이하.
    monkeypatch.setattr(U, "UPSTAGE_PARSE_MAX_BYTES", len(data) - 1)
    monkeypatch.setattr(U, "_SEGMENT_TARGET_BYTES", len(data) - 1)

    calls: list[str] = []

    async def fake_single(seg, filename):
        calls.append(filename)
        return f"[{filename}]"

    monkeypatch.setattr(U, "_parse_single", fake_single)
    out = await U.parse_document(data, "big.pdf")
    assert len(calls) >= 2
    part_no = [int(n.split(".part")[1].split(".")[0]) for n in calls]
    assert sorted(part_no) == list(range(1, len(calls) + 1))
    # 연결은 조각 인덱스(페이지) 순 — gather 결과 순서 보장.
    assert out == "\n\n".join(f"[big.pdf.part{i}.pdf]" for i in range(1, len(calls) + 1))


@pytest.mark.asyncio
async def test_parse_document_small_uses_single_path(monkeypatch):
    """⑧ 리밋 이하 PDF는 기존 단일 요청 경로."""
    async def fake_single(seg, filename):
        return "ok"

    monkeypatch.setattr(U, "_parse_single", fake_single)
    assert await U.parse_document(b"%PDF-1.4 tiny", "small.pdf") == "ok"
```

- [ ] **Step 3: RED 확인**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/test_upload_limits.py tests/test_pdf_split.py -v`
Expected: FAIL — `class_material_max_bytes`/`resolve_upload_max_bytes`/`_pdf_segments`/`_parse_single` 부재(AttributeError), 기본값 불일치.

- [ ] **Step 4: `backend/app/config.py` — 기본값 변경 + 신규 노브**

`file_max_bytes: int = 25 * 1024 * 1024` 라인(~110행)을 다음으로 교체:

```python
    # Upper bound on a single uploaded file (bytes) — guard before processing.
    # D77: 학생·개인 업로드 25→50MB 상향(2026-07-15 사용자 결정).
    file_max_bytes: int = 50 * 1024 * 1024
    # D77: 학급 자료(class_material, 교사 전용) 전용 상한 — 대용량 교과서 PDF.
    # Upstage 파서 하드 리밋(요청당 50MB)은 D78 PDF 분할 파싱으로 우회한다.
    class_material_max_bytes: int = 500 * 1024 * 1024
```

- [ ] **Step 5: `backend/app/services/upstage.py` — 분할 파싱(D78)**

(a) 상수부(`_POLL_MAX_SECONDS` 아래)에 추가:

```python
# D78: Document Parse 요청당 파일 크기 하드 리밋(공식 문서 50MB). 초과 PDF는
# 페이지 분할 후 조각별 파싱(이미지는 분할 불가 — 업로드 단계 D77이 거절).
UPSTAGE_PARSE_MAX_BYTES = 50 * 1024 * 1024
_SEGMENT_TARGET_BYTES = 48 * 1024 * 1024  # 직렬화 오버헤드 마진
_SEGMENT_CONCURRENCY = 3  # 조각 파싱 동시성(요청 폭주 방지)
```

(b) 기존 `parse_document`(~203행)의 이름을 `_parse_single`로 바꾸고(본문·
docstring 그대로 유지하되 첫 줄에 `"""단일 요청 파싱 — sync(<=100p) 우선,
페이지 상한 초과 시 async 폴백."""`으로 교체), 그 위에 새 디스패처와 분할
함수를 추가:

```python
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
```

- [ ] **Step 6: `backend/app/services/files.py` — kind별 상한 + 이미지 예외(D77)**

(a) 임포트에 추가: `from .upstage import UPSTAGE_PARSE_MAX_BYTES`

(b) `UNSUPPORTED_TYPE_DETAIL` 아래에 추가:

```python
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
```

(c) `upload_file`의 기존 용량 검사 블록(`overlay = await app_settings.get_overlay()`
부터 413 raise까지)을 다음으로 교체 — D75 `ext` 계산부 **아래**에 위치:

```python
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
```

- [ ] **Step 7: `backend/app/routers/files.py` — 사전 거절도 kind별로**

upload의 기존 사전 거절 블록(~69-77행)에서 `max_bytes` 산출만 교체:

```python
    overlay = await app_settings.get_overlay()
    # D77: kind별 상한 — class_material은 대용량 허용(서비스가 재검증).
    max_bytes = svc.resolve_upload_max_bytes(overlay, kind)
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {max_bytes} bytes.",
        )
```

- [ ] **Step 8: `supabase/migrations/0030_app_settings_upload_limits.sql` 생성**

```sql
-- ============================================================================
-- nodi — migration 0030 (D77 — kind별 업로드 상한 시드 + 기본 상향)
-- 스펙: docs/superpowers/specs/2026-07-15-class-material-large-upload-design.md
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 미적용 상태에서도 런타임은
-- config.py 기본값으로 동작한다(D62 오버레이 폴백). 비파괴: 신규 키 시드 +
-- admin이 손대지 않은 시드값일 때만 조건부 갱신.
-- ============================================================================

insert into public.app_settings (key, value) values
    -- 학급 자료(class_material) 전용 상한. 524288000 = 500MB.
    ('class_material_max_bytes', '524288000'::jsonb)
on conflict (key) do nothing;

-- 학생·개인 업로드 기본 25→50MB: 0022 시드값 그대로일 때만 갱신(커스텀 보존).
update public.app_settings
   set value = '52428800'::jsonb
 where key = 'file_max_bytes' and value = '26214400'::jsonb;

-- End of 0030_app_settings_upload_limits.sql
```

- [ ] **Step 9: GREEN 확인 (전체 스위트)**

Run: `cd backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전체 PASS (test_upload_whitelist 등 기존 테스트 무회귀 — 기존
페이로드는 전부 소형이라 상한 변화 무영향).

- [ ] **Step 10: 커밋**

```bash
git add backend/app/config.py backend/app/routers/files.py backend/app/services/files.py backend/app/services/upstage.py supabase/migrations/0030_app_settings_upload_limits.sql backend/tests/test_upload_limits.py backend/tests/test_pdf_split.py
git commit -m "[feat]: kind별 업로드 상한(D77) + 대용량 PDF 분할 파싱(D78) — 교사 자료 500MB·학생 50MB"
```

---

### Task B: admin 설정 메타 등록 (SettingsTab)

**Files:**
- Modify: `frontend/src/components/admin/SettingsTab.tsx` (SETTINGS 맵)

**Interfaces:**
- Consumes: 기존 SETTINGS 엔트리 형태(`file_max_bytes` number형 ~288행,
  `file_suggestion_enabled` toggle형 ~93행, `file_suggestion_suggest_max_distance`
  slider형 ~101행 — 실제 필드 구성은 파일에서 확인해 동일 형태 유지).
- Produces: 없음(표시 메타).

- [ ] **Step 1: `file_max_bytes` 엔트리 갱신 + 신규 3키 추가**

`file_max_bytes` 엔트리의 `description`을 다음으로 교체(다른 필드 유지):

```ts
    description: "학생·개인 업로드 한 파일의 최대 크기(바이트). 52428800 = 50MB(기본).",
```

`file_max_bytes` 엔트리 **바로 아래**에 추가:

```ts
  class_material_max_bytes: {
    label: "학급 자료 업로드 최대 크기",
    group: "임베딩",
    widget: "number",
    min: 1048576,
    max: 536870912,
    step: 10485760,
    unit: "B",
    description:
      "교사 학급 자료(class_material) 한 파일의 최대 크기. 524288000 = 500MB(기본). 50MB 초과 PDF는 분할 파싱(D78)로 처리.",
    effect: "교사 자료 업로드 크기",
    wired: "live",
    risk: "safe",
  },
```

"RAG 주입" 그룹(`rag_top_k` 근처, ~173행)에 D73 노브 2종 추가:

```ts
  class_material_rag_enabled: {
    label: "학급 자료 자동 주입",
    group: "RAG 주입",
    widget: "toggle",
    description:
      "학급 세션에서 링크 없이도 학급 자료(class_material)를 검색 후보에 넣습니다(D73). 끄면 링크된 파일만 검색합니다.",
    effect: "학급 자료 자동 RAG 여부",
    wired: "live",
  },
  class_material_rag_max_distance: {
    label: "학급 자료 거리 게이트",
    group: "RAG 주입",
    widget: "slider",
    min: 0.1,
    max: 0.9,
    step: 0.05,
    description:
      "자동 스코프(비링크) 청크에만 적용하는 거리 컷오프(distance = 1 - score). 낮을수록 엄격 — 링크된 파일 청크는 게이트 없음.",
    effect: "자동 주입 엄격도",
    wired: "live",
  },
```

(필드 구성이 기존 slider/toggle 엔트리와 다르면 **기존 엔트리 형태에 맞춰
조정**한다 — 타입 오류는 tsc가 잡는다.)

- [ ] **Step 2: 타입 확인**

Run: `cd frontend && npx tsc --noEmit`
Expected: exit 0. (`npm run build` 스모크는 게이트에서 Manager가 실행.)

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/admin/SettingsTab.tsx
git commit -m "[feat]: admin 설정 메타 — 학급 자료 상한(D77)·자동 RAG 노브(D73) 위젯 등록"
```

---

## 게이트·마무리 (Manager)

1. 두 task 회수 → 리뷰어 게이트(각 1회) + 메인 저장소 tsc/build 스모크.
2. TASK 2 마무리 E2E와 통합 실측(대용량 실파일은 유닛 갈음) → 최종 브랜치
   리뷰(TASK 2 + 본 확장 전체 diff) → TASKS.md·원장 동기화.
