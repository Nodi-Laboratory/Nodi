# 교과서 RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 교과서 코퍼스를 Qdrant `textbook` 컬렉션에 임베딩해 두고, 매 질문마다 유사 청크를 검색해 거리 게이트 통과분만 EXAONE 시스템 프롬프트에 `[교과서에서 참고]` 블록으로 주입한다.

**Architecture:** admin 개발자가 `backend/textbooks/` 폴더에 교과서 파일을 넣고 오프라인 스크립트(`scripts/ingest_textbook.py`)로 인제스트한다(Upstage Document Parse → 기존 청커 → `embedding-passage` → Qdrant). 런타임은 캔버스 배치용으로 이미 만드는 질문 임베딩(`qvec`)을 재사용해 `rag.build_textbook_context()`로 검색하고, `gemini.compose_system_structured()`에 새 블록 kind `"textbook_rag"`로 합류시킨다. 스펙: `docs/superpowers/specs/2026-07-13-textbook-rag-design.md`

**Tech Stack:** Python 3 / FastAPI, Qdrant(AsyncQdrantClient), Upstage API(httpx), pytest(+pytest-asyncio, monkeypatch)

## Global Constraints

- 새 pip 의존성 금지 — httpx·qdrant_client 등 기존 스택만 사용.
- 임베딩은 Upstage 비대칭 4096d: 질의 `kind="query"`, 문서 `kind="passage"` — 혼용 금지.
- 거리 규약: `distance = 1 - score` (Qdrant cosine score → 기존 거리 임계값 의미 유지).
- RAG 불변식: 검색·임베딩 실패가 채팅 턴을 절대 막지 않는다 (전체 try/except → None).
- 튜너블 해석 순서(D62): app_settings overlay > config default. 오버레이 접근은 `app_settings.as_int/as_float/as_bool` + clamp.
- 교과서 원문(.pdf/.txt/.md)은 git에 커밋하지 않는다 — `backend/textbooks/`는 README·manifest.example.json만 커밋.
- 커밋 메시지는 저장소 관례를 따른다: `[feat]:`/`[fix]:`/`[docs]:` + 한국어 요약.
- 테스트 실행 위치: `backend/` (예: `cd backend && python -m pytest tests/test_rag_textbook.py -v`).
- 코드 주석은 저장소 관례대로 한국어, 제약·근거 위주.

---

### Task 1: qdrant_store — `textbook` 컬렉션 + 포인트 id 규약 + 소스 삭제

**Files:**
- Modify: `backend/app/services/qdrant_store.py`
- Test: `backend/tests/test_qdrant_textbook.py` (신규)

**Interfaces:**
- Consumes: 기존 `get_client()`, `ensure_collections()`, `models`(qdrant_client), `EMBED_DIM`
- Produces (뒤 태스크가 사용):
  - `COL_TEXTBOOK: str = "textbook"` (Task 2 검색, Task 5 업서트)
  - `textbook_point_id(source_name: str, seq: int) -> str` (Task 5 — 결정론적 uuid5)
  - `delete_textbook_source(source_name: str) -> None` (async, Task 5 — 재인제스트 선삭제)

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_qdrant_textbook.py`:

```python
import uuid

from app.services import qdrant_store


def test_textbook_point_id_deterministic_and_distinct():
    a = qdrant_store.textbook_point_id("중학 과학 2", 0)
    # 같은 입력 → 같은 id (재실행 ingest가 덮어쓰는 규약)
    assert a == qdrant_store.textbook_point_id("중학 과학 2", 0)
    # seq / source_name이 다르면 다른 id
    assert a != qdrant_store.textbook_point_id("중학 과학 2", 1)
    assert a != qdrant_store.textbook_point_id("국어 1", 0)
    # 유효한 uuid 문자열 (Qdrant 포인트 id 요건)
    uuid.UUID(a)


def test_textbook_collection_constant():
    assert qdrant_store.COL_TEXTBOOK == "textbook"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_qdrant_textbook.py -v`
Expected: FAIL — `AttributeError: module 'app.services.qdrant_store' has no attribute 'textbook_point_id'`

- [ ] **Step 3: 구현**

`backend/app/services/qdrant_store.py` 수정 — 4곳:

(a) 컬렉션 상수 (기존 상수 블록에 추가):

```python
COL_FILE_CHUNKS = "file_chunks"
COL_ART = "art_assets"
COL_EBS = "ebs"
COL_CANVAS_CARDS = "canvas_cards"
COL_TEXTBOOK = "textbook"
```

(b) 포인트 id 헬퍼 (`canvas_card_point_id` 아래에 추가):

```python
def textbook_point_id(source_name: str, seq: int) -> str:
    """textbook 포인트 id — 재실행 ingest가 덮어쓰도록 결정론 uuid5."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"textbook:{source_name}:{seq}"))
```

(c) `ensure_collections()` 수정 — 생성 루프 튜플에 `COL_TEXTBOOK` 추가:

```python
        for name in (COL_FILE_CHUNKS, COL_ART, COL_EBS, COL_CANVAS_CARDS, COL_TEXTBOOK):
```

그리고 canvas_cards 인덱스 블록 아래(같은 바깥 try 안)에 textbook 페이로드 인덱스 추가:

```python
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
```

또한 `ensure_collections()` docstring 첫 줄의 "3개 컬렉션"류 수치가 남아 있으면 "전체 컬렉션"으로 고친다.

(d) 소스 삭제 함수 (`upsert()` 아래에 추가):

```python
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_qdrant_textbook.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: 기존 테스트 회귀 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 전부 PASS (기존 test_qdrant_canvas 등 영향 없음)

- [ ] **Step 6: 커밋**

```bash
git add backend/app/services/qdrant_store.py backend/tests/test_qdrant_textbook.py
git commit -m "[feat]: Qdrant textbook 컬렉션 + 결정론 포인트 id + 소스 단위 삭제"
```

---

### Task 2: config 노브 3종 + `rag.build_textbook_context`

**Files:**
- Modify: `backend/app/config.py` (rag_top_k 근처, ~137행)
- Modify: `backend/app/services/rag.py`
- Test: `backend/tests/test_rag_textbook.py` (신규)

**Interfaces:**
- Consumes: `qdrant_store.COL_TEXTBOOK`, `qdrant_store.search(collection, vector, k)` (Task 1), `app_settings.get_overlay/as_bool/as_int/as_float`, 기존 `rag._source_label`, `rag.SNIPPET_CHARS`
- Produces (뒤 태스크가 사용):
  - `rag.build_textbook_context(query_vector: list[float]) -> dict | None` (async) — 반환 `{"block": str, "sources": [{"name","seq","page","distance","snippet"}]}` 또는 None (Task 4가 호출)
  - config: `textbook_rag_enabled: bool = True`, `textbook_rag_top_k: int = 4`, `textbook_rag_max_distance: float = 0.45`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_rag_textbook.py`:

```python
import pytest

from app.services import rag


def _hit(score, text, name="중학 과학 2", page=None, seq=0):
    payload = {
        "chunk_text": text,
        "source_name": name,
        "subject": "과학",
        "grade": "중2",
        "seq": seq,
    }
    if page is not None:
        payload["page"] = page
    return {"id": f"pt-{seq}", "score": score, "payload": payload}


@pytest.fixture
def overlay(monkeypatch):
    """app_settings 오버레이를 빈 dict로 고정(설정은 config 기본값으로)."""
    data = {}

    async def fake_overlay():
        return data

    monkeypatch.setattr(rag.app_settings, "get_overlay", fake_overlay)
    return data


@pytest.mark.asyncio
async def test_gate_pass_builds_block_and_sources(overlay, monkeypatch):
    async def fake_search(collection, vector, k, **kw):
        assert collection == rag.qdrant_store.COL_TEXTBOOK
        assert k == 4  # config 기본 textbook_rag_top_k
        return [_hit(0.9, "광합성은 빛에너지로 양분을 만드는 과정", page=12, seq=3)]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert out is not None
    lines = out["block"].splitlines()
    assert lines[0] == "[교과서에서 참고]"
    # page가 있으면 p.N 라벨 (seq 미표기)
    assert "[중학 과학 2 · p.12]" in lines[1]
    src = out["sources"][0]
    assert src["name"] == "중학 과학 2"
    assert src["page"] == 12
    assert src["seq"] == 3
    assert abs(src["distance"] - 0.1) < 1e-9  # 1 - 0.9
    assert src["snippet"].startswith("광합성")


@pytest.mark.asyncio
async def test_label_falls_back_to_seq_without_page(overlay, monkeypatch):
    async def fake_search(*a, **k):
        return [_hit(0.9, "본문", page=None, seq=7)]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert "[중학 과학 2 · #7]" in out["block"]


@pytest.mark.asyncio
async def test_all_gated_out_returns_none(overlay, monkeypatch):
    async def fake_search(*a, **k):
        # distance = 1 - 0.3 = 0.7 > 기본 게이트 0.45 → 탈락
        return [_hit(0.3, "관련 없는 청크")]

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    assert await rag.build_textbook_context([0.1] * 4) is None


@pytest.mark.asyncio
async def test_empty_vector_returns_none(overlay):
    assert await rag.build_textbook_context([]) is None


@pytest.mark.asyncio
async def test_qdrant_error_returns_none(overlay, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("qdrant down")

    monkeypatch.setattr(rag.qdrant_store, "search", boom)
    # 불변식: 검색 실패는 None으로 강등될 뿐 raise하지 않는다
    assert await rag.build_textbook_context([0.1] * 4) is None


@pytest.mark.asyncio
async def test_disabled_via_overlay_skips_search(overlay, monkeypatch):
    overlay["textbook_rag_enabled"] = False
    called = {"n": 0}

    async def fake_search(*a, **k):
        called["n"] += 1
        return []

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    assert await rag.build_textbook_context([0.1] * 4) is None
    assert called["n"] == 0  # 비활성 시 Qdrant 왕복 자체가 없어야 한다


@pytest.mark.asyncio
async def test_overlay_overrides_gate(overlay, monkeypatch):
    overlay["textbook_rag_max_distance"] = 0.8

    async def fake_search(*a, **k):
        return [_hit(0.3, "느슨한 게이트로 통과")]  # distance 0.7 <= 0.8

    monkeypatch.setattr(rag.qdrant_store, "search", fake_search)
    out = await rag.build_textbook_context([0.1] * 4)
    assert out is not None and "느슨한 게이트로 통과" in out["block"]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_rag_textbook.py -v`
Expected: FAIL — `AttributeError: module 'app.services.rag' has no attribute 'build_textbook_context'`

- [ ] **Step 3: config 노브 추가**

`backend/app/config.py` — `rag_top_k: int = 5` 라인(~137행) 아래에 추가:

```python
    # --- Textbook RAG (전역 교과서 코퍼스, Qdrant `textbook` 컬렉션) ---
    textbook_rag_enabled: bool = True  # 교과서 블록 주입 전체 on/off
    textbook_rag_top_k: int = 4  # 질문당 검색·주입 최대 청크 수
    textbook_rag_max_distance: float = 0.45  # 거리 게이트(1-score), 초과분 탈락
```

- [ ] **Step 4: `build_textbook_context` 구현**

`backend/app/services/rag.py` — `build_rag_context()` 아래에 추가:

```python
# --- 교과서 RAG (전역 코퍼스, 스펙 2026-07-13-textbook-rag-design) ---------
# file_chunks와 달리 교과서는 시스템 공용 지식 베이스라 RLS 재검증이 없다 —
# 본문은 Qdrant 페이로드(chunk_text)에서 바로 읽는다. Supabase 왕복 없음.
TEXTBOOK_BLOCK_HEADER = "[교과서에서 참고]"


async def build_textbook_context(
    query_vector: list[float],
) -> dict[str, Any] | None:
    """질문 벡터로 교과서 컬렉션을 검색해 참고 블록 + 출처 메타를 조립.

    호출부(chat)가 캔버스 배치용으로 이미 임베딩한 질문 벡터를 재사용한다
    (추가 임베딩 API 호출 없음). 거리 게이트(textbook_rag_max_distance)를
    통과한 청크가 없으면 None — 인사·잡담·교과 외 질문은 여기서 탈락한다.
    Best-effort: 어떤 실패도 None으로 강등, 채팅을 절대 막지 않는다.
    """
    try:
        if not query_vector:
            return None
        overlay = await app_settings.get_overlay()
        if not app_settings.as_bool(
            overlay, "textbook_rag_enabled", settings.textbook_rag_enabled
        ):
            return None
        k = app_settings.as_int(
            overlay, "textbook_rag_top_k", settings.textbook_rag_top_k, 1, 20
        )
        max_distance = app_settings.as_float(
            overlay,
            "textbook_rag_max_distance",
            settings.textbook_rag_max_distance,
            0.1,
            0.9,
        )
        hits = await qdrant_store.search(
            qdrant_store.COL_TEXTBOOK, query_vector, k
        )
        lines = [TEXTBOOK_BLOCK_HEADER]
        sources: list[dict[str, Any]] = []
        for h in hits:
            distance = 1.0 - float(h["score"])
            if distance > max_distance:
                continue
            payload = h.get("payload") or {}
            text = (payload.get("chunk_text") or "").strip()
            if not text:
                continue
            name = payload.get("source_name") or ""
            page = payload.get("page")
            seq = payload.get("seq")
            # 라벨은 page 우선, 없으면 #seq (둘 다 표기하지 않는다)
            label = _source_label(name, None if page is not None else seq, page)
            lines.append(f"- [{label}] {text}" if label else f"- {text}")
            sources.append(
                {
                    # file_id/chunk_id 없음 — 프론트는 optional로 처리(D41),
                    # 이웃 청크("⋯") 패널은 미지원(Supabase에 본문 없음).
                    "name": name,
                    "seq": seq,
                    "page": page,
                    "distance": distance,
                    "snippet": text[:SNIPPET_CHARS],
                }
            )
        if len(lines) <= 1:
            return None
        return {"block": "\n".join(lines), "sources": sources}
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("Textbook RAG retrieval failed")
        return None
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_rag_textbook.py -v`
Expected: PASS (7 passed)

- [ ] **Step 6: 기존 테스트 회귀 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 7: 커밋**

```bash
git add backend/app/config.py backend/app/services/rag.py backend/tests/test_rag_textbook.py
git commit -m "[feat]: 교과서 RAG 검색 — build_textbook_context + 거리 게이트, D62 튜너블 3종"
```

---

### Task 3: gemini.compose_system_structured — `textbook_rag` 블록

**Files:**
- Modify: `backend/app/services/gemini.py` (67–164행: WRAP 상수 + compose 함수)
- Test: `backend/tests/test_compose_textbook.py` (신규)

**Interfaces:**
- Consumes: 기존 `compose_system_structured` parts 구조 (kind, segment, source, raw_text, node_ids, sources)
- Produces (Task 4가 사용):
  - `compose_system_structured(..., *, textbook_context: str | None = None, textbook_sources: list[dict] | None = None, ...)` — 키워드 전용 파라미터 2개 추가. `textbook_context`가 truthy면 `"rag"` 블록 뒤에 kind `"textbook_rag"`, source `"교과서 참고"` 블록을 넣는다. 기존 위치 인자 시그니처는 그대로(하위 호환).

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_compose_textbook.py`:

```python
from app.services import gemini


def test_textbook_block_span_and_order():
    sp, blocks = gemini.compose_system_structured(
        None,
        "[연결된 자료에서 참고]\n- 파일 청크",
        None,
        textbook_context="[교과서에서 참고]\n- [중학 과학 2 · p.12] 광합성",
        textbook_sources=[{"name": "중학 과학 2", "page": 12}],
        base_instruction="base",
    )
    kinds = [b["kind"] for b in blocks]
    # textbook_rag는 rag 뒤 (스펙 3장)
    assert kinds == ["system_base", "rag", "textbook_rag"]
    tb = blocks[2]
    start, end = tb["prompt_span"]
    # D35 불변식: span이 가리키는 조각 == wrapper + raw_text
    assert sp[start:end] == gemini._WRAP_TEXTBOOK + tb["raw_text"]
    assert tb["raw_text"].startswith("[교과서에서 참고]")
    assert tb["source"] == "교과서 참고"
    assert tb["sources"] == [{"name": "중학 과학 2", "page": 12}]


def test_no_textbook_context_no_block():
    sp, blocks = gemini.compose_system_structured(None, base_instruction="base")
    assert [b["kind"] for b in blocks] == ["system_base"]
    assert "[교과서에서 참고]" not in sp


def test_existing_positional_call_unchanged():
    # 기존 호출부(위치 인자 3개 + 기존 kwargs)가 그대로 동작해야 한다
    sp, blocks = gemini.compose_system_structured(
        "참고", "자료", "비교", base_instruction="base"
    )
    assert [b["kind"] for b in blocks] == [
        "system_base", "memory_link", "rag", "comparison",
    ]
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_compose_textbook.py -v`
Expected: FAIL — `TypeError: compose_system_structured() got an unexpected keyword argument 'textbook_context'`

- [ ] **Step 3: 구현**

`backend/app/services/gemini.py` 수정 — 3곳:

(a) WRAP 상수 블록(`_WRAP_COMPARISON` 아래)에 추가:

```python
_WRAP_TEXTBOOK = (
    "아래는 한국 교과서에서 질문과 관련해 검색된 내용입니다. 답변의 근거로 "
    "우선 활용해 교과 과정에 맞는 정확한 설명을 하고, 교과서에 없는 내용은 "
    "일반 지식으로 보완하되 출처를 구분하세요.\n\n"
)
```

(b) 시그니처 — 키워드 전용 파라미터 2개 추가:

```python
def compose_system_structured(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
    *,
    textbook_context: str | None = None,
    rag_sources: list[dict] | None = None,
    textbook_sources: list[dict] | None = None,
    reference_node_ids: list[str] | None = None,
    comparison_node_ids: list[str] | None = None,
    base_instruction: str | None = None,
) -> tuple[str, list[dict]]:
```

docstring의 컨텍스트 목록에 한 줄 추가:

```python
    - `textbook_context`: 전역 교과서 코퍼스에서 검색된 청크 (교과서 RAG).
```

(c) parts 조립 — 기존 `if rag_context:` 블록 **바로 뒤**(=`if comparison_context:` 앞)에 추가:

```python
    if textbook_context:
        parts.append(
            (
                "textbook_rag",
                _WRAP_TEXTBOOK + textbook_context,
                "교과서 참고",
                textbook_context,
                None,
                textbook_sources or [],
            )
        )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_compose_textbook.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: 기존 테스트 회귀 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/services/gemini.py backend/tests/test_compose_textbook.py
git commit -m "[feat]: 시스템 프롬프트에 textbook_rag 블록 — D35 span 규약 유지"
```

---

### Task 4: chat.py 배선 — qvec 선행 + 4번째 gather leg

**Files:**
- Modify: `backend/app/routers/chat.py` (341–389행: gather / compose 호출 / qvec 블록)
- Modify: `backend/tests/test_chat_place.py` (`_consume` 헬퍼 + 신규 테스트)

**Interfaces:**
- Consumes: `rag.build_textbook_context(qvec)` (Task 2), `compose_system_structured(textbook_context=, textbook_sources=)` (Task 3), 기존 `upstage.embed_query`
- Produces: 없음 (최종 배선). 단 `_consume`에 `textbook_result`/`spy` 파라미터가 생긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_chat_place.py` 수정 — 2곳:

(a) `_consume` 시그니처와 목 확장. 함수 정의를 다음으로 교체:

```python
async def _consume(
    monkeypatch, *, settle_raises: bool, textbook_result=None, spy: dict | None = None
):
```

그리고 본문에서 기존 두 곳을 교체한다.

기존:

```python
    monkeypatch.setattr(C.memory, "build_reference_context", fake_reference)
    monkeypatch.setattr(C.rag, "build_rag_context", fake_rag)
    monkeypatch.setattr(C.memory, "build_comparison_context", fake_comparison)
    monkeypatch.setattr(
        C.gemini, "compose_system_structured", lambda *a, **k: ("sys", [])
    )
```

교체:

```python
    monkeypatch.setattr(C.memory, "build_reference_context", fake_reference)
    monkeypatch.setattr(C.rag, "build_rag_context", fake_rag)
    monkeypatch.setattr(C.memory, "build_comparison_context", fake_comparison)

    async def fake_textbook(qv):
        if spy is not None:
            spy["textbook_qvec"] = qv
        return textbook_result

    monkeypatch.setattr(C.rag, "build_textbook_context", fake_textbook)

    def fake_compose(*a, **k):
        if spy is not None:
            spy["compose_kwargs"] = k
        return ("sys", [])

    monkeypatch.setattr(C.gemini, "compose_system_structured", fake_compose)
```

(b) 파일 끝에 배선 테스트 추가:

```python
@pytest.mark.asyncio
async def test_textbook_context_wired_qvec_reused_and_composed(monkeypatch):
    """교과서 RAG 배선: 캔버스용 질문 임베딩(qvec)이 재사용되고,
    결과 block/sources가 compose_system_structured에 전달된다."""
    spy = {}
    tb = {
        "block": "[교과서에서 참고]\n- [중학 과학 2 · p.12] 광합성",
        "sources": [{"name": "중학 과학 2", "page": 12}],
    }
    events, _ = await _consume(
        monkeypatch, settle_raises=False, textbook_result=tb, spy=spy
    )
    # qvec 재사용 — fake_embed_query가 준 벡터가 그대로 전달됨
    assert spy["textbook_qvec"] == [0.1] * 10
    assert spy["compose_kwargs"]["textbook_context"] == tb["block"]
    assert spy["compose_kwargs"]["textbook_sources"] == tb["sources"]
    assert "done" in _event_names(events)


@pytest.mark.asyncio
async def test_textbook_none_composes_without_block(monkeypatch):
    spy = {}
    await _consume(monkeypatch, settle_raises=False, textbook_result=None, spy=spy)
    assert spy["compose_kwargs"]["textbook_context"] is None
    assert spy["compose_kwargs"]["textbook_sources"] == []
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_chat_place.py -v`
Expected: 신규 2건 FAIL — `KeyError: 'textbook_qvec'` (chat.py가 아직 `build_textbook_context`를 호출하지 않음). 기존 4건은 PASS 유지.

- [ ] **Step 3: chat.py 구현**

`backend/app/routers/chat.py` 수정 — 3곳:

(a) **qvec 블록 이동**: 기존 gather(341–351행) **앞**에 다음을 넣는다 (기존 376–389행의 `session_cards`/`qvec` 블록에서 qvec try/except만 가져와 주석 갱신 — `session_cards = await _scroll_session_cards(...)` 줄은 원래 자리에 남긴다):

```python
    # 질의 임베딩 1회 — (1) 교과서 RAG 검색과 (2) 기존 카드 코사인 유사도
    # (솔버 sim) 근거로 재사용한다(추가 임베딩 호출 없음). 실패해도 턴을
    # 죽이지 않는다: 빈 벡터 → 교과서 블록 생략 + sim 0.0 degraded 배치.
    try:
        qvec = await upstage.embed_query(body.question)
    except Exception:  # noqa: BLE001
        logger.warning(
            "질의 임베딩 실패 — 교과서 RAG 생략 + sim 0.0(degraded)로 배치 session=%s",
            body.session_id,
            exc_info=True,
        )
        qvec = []
```

(b) **gather에 4번째 leg 추가** — 기존 gather를 다음으로 교체 (주석의 컨텍스트 빌더 목록에도 textbook 한 줄 추가):

```python
    #   - textbook:   전역 교과서 코퍼스에서 질문과 유사한 청크 (거리 게이트)
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
        textbook_result,
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(client, chain, body.question),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
        rag.build_textbook_context(qvec),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    textbook_context = textbook_result["block"] if textbook_result else None
    textbook_sources = textbook_result["sources"] if textbook_result else []
```

(c) **compose 호출에 전달** — 기존 호출(359–367행)을 다음으로 교체:

```python
    system_prompt, context_blocks_list = gemini.compose_system_structured(
        reference_context,
        rag_context,
        comparison_context,
        textbook_context=textbook_context,
        rag_sources=rag_sources,
        textbook_sources=textbook_sources,
        reference_node_ids=reference_node_ids,
        comparison_node_ids=comparison_node_ids,
        base_instruction=exaone.CONCEPT_CARD_SYSTEM_PROMPT,
    )
```

마지막으로 기존 376–389행에서 옮겨간 qvec try/except 블록(원본)을 삭제한다. `session_cards = await _scroll_session_cards(user.id, body.session_id)` 줄과 그 주석은 그대로 둔다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_chat_place.py -v`
Expected: PASS (기존 4 + 신규 2 = 6 passed)

- [ ] **Step 5: 전체 테스트 회귀 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add backend/app/routers/chat.py backend/tests/test_chat_place.py
git commit -m "[feat]: 채팅 턴에 교과서 RAG 합류 — qvec 재사용, 4번째 컨텍스트 leg"
```

---

### Task 5: `backend/textbooks/` 폴더 + .gitignore + 인제스트 스크립트

**Files:**
- Create: `backend/textbooks/README.md`
- Create: `backend/textbooks/manifest.example.json`
- Create: `backend/scripts/ingest_textbook.py`
- Modify: `.gitignore` (저장소 루트)
- Test: `backend/tests/test_ingest_textbook.py` (신규)

**Interfaces:**
- Consumes: `qdrant_store.COL_TEXTBOOK`, `textbook_point_id`, `delete_textbook_source`, `upsert`, `ensure_collections` (Task 1), `embedding.chunk_text`, `upstage.parse_document`, `upstage.embed_texts(kind="passage")`
- Produces: admin 운영 CLI `python scripts/ingest_textbook.py [--dir PATH] [--dry-run]`

- [ ] **Step 1: 실패하는 테스트 작성**

`backend/tests/test_ingest_textbook.py`:

```python
import json
import os
import sys

# scripts/는 패키지가 아니므로 경로를 직접 추가해 모듈로 임포트
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "scripts")
)
import ingest_textbook as I  # noqa: E402

from app.services import qdrant_store  # noqa: E402


def test_scan_files_filters_supported_exts(tmp_path):
    (tmp_path / "b.pdf").write_bytes(b"%PDF")
    (tmp_path / "a.txt").write_text("텍스트", encoding="utf-8")
    (tmp_path / "note.md").write_text("# md", encoding="utf-8")
    (tmp_path / "manifest.json").write_text("[]", encoding="utf-8")
    (tmp_path / "README.md.bak").write_text("x", encoding="utf-8")
    # 정렬된 지원 확장자만 (manifest/기타 제외)
    assert I.scan_files(str(tmp_path)) == ["a.txt", "b.pdf", "note.md"]


def test_load_manifest_missing_returns_empty(tmp_path):
    assert I.load_manifest(str(tmp_path)) == {}


def test_meta_for_merges_manifest_and_falls_back(tmp_path):
    manifest_entries = [
        {
            "filename": "science.pdf",
            "source_name": "중학 과학 2 (2022 개정)",
            "subject": "과학",
            "grade": "중2",
        }
    ]
    (tmp_path / "manifest.json").write_text(
        json.dumps(manifest_entries), encoding="utf-8"
    )
    manifest = I.load_manifest(str(tmp_path))
    m = I.meta_for("science.pdf", manifest)
    assert m == {
        "source_name": "중학 과학 2 (2022 개정)",
        "subject": "과학",
        "grade": "중2",
    }
    # manifest에 없는 파일 → source_name = 파일명 stem, 나머지 빈 값
    m2 = I.meta_for("국어1.txt", manifest)
    assert m2 == {"source_name": "국어1", "subject": "", "grade": ""}


def test_build_points_ids_and_payload():
    meta = {"source_name": "중학 과학 2", "subject": "과학", "grade": "중2"}
    chunks = ["청크 하나", "청크 둘"]
    vectors = [[0.1] * 4, [0.2] * 4]
    points = I.build_points(meta, chunks, vectors)
    assert len(points) == 2
    assert points[0]["id"] == qdrant_store.textbook_point_id("중학 과학 2", 0)
    assert points[1]["id"] == qdrant_store.textbook_point_id("중학 과학 2", 1)
    p = points[1]["payload"]
    assert p["chunk_text"] == "청크 둘"
    assert p["source_name"] == "중학 과학 2"
    assert p["subject"] == "과학"
    assert p["grade"] == "중2"
    assert p["seq"] == 1
    assert points[1]["vector"] == [0.2] * 4
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd backend && python -m pytest tests/test_ingest_textbook.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ingest_textbook'`

- [ ] **Step 3: 스크립트 구현**

`backend/scripts/ingest_textbook.py` 생성:

```python
"""Offline: backend/textbooks/ 폴더의 교과서를 Qdrant `textbook` 컬렉션에 인덱싱.

admin 개발자가 폴더에 .pdf/.txt/.md를 넣고 실행하는 운영 파이프라인
(스펙: docs/superpowers/specs/2026-07-13-textbook-rag-design.md).

파일별로:
  1. 텍스트 추출 — PDF는 Upstage Document Parse, .txt/.md는 그대로 읽음.
  2. embedding.chunk_text()로 청킹 (config chunk_size/overlap).
  3. Upstage embedding-passage(4096d) 배치 임베딩.
  4. 같은 source_name 포인트 선삭제 후 Qdrant `textbook` 업서트
     (포인트 id = uuid5("textbook:{source_name}:{seq}") — 결정론적).

메타는 폴더의 manifest.json(선택)에서 읽는다: [{filename, source_name,
subject, grade}]. 항목이 없으면 source_name=파일명 stem, subject/grade 빈 값.

Run (from backend/, with root .env populated: UPSTAGE_API_KEY, QDRANT_URL):

    python scripts/ingest_textbook.py             # backend/textbooks/ 스캔
    python scripts/ingest_textbook.py --dry-run   # 파싱·청킹 미리보기만
    python scripts/ingest_textbook.py --dir /path/to/folder
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

# `python scripts/ingest_textbook.py`로 실행 시 `app` 임포트 가능하도록.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import get_settings  # noqa: E402
from app.services import embedding, qdrant_store, upstage  # noqa: E402

settings = get_settings()

SUPPORTED_EXTS = (".pdf", ".txt", ".md")


def scan_files(dir_path: str) -> list[str]:
    """폴더의 지원 확장자 파일명 목록(정렬). manifest.json 등은 제외."""
    return sorted(
        name
        for name in os.listdir(dir_path)
        if name.lower().endswith(SUPPORTED_EXTS)
        and name != "README.md"
    )


def load_manifest(dir_path: str) -> dict[str, dict]:
    """manifest.json -> {filename: entry}. 없으면 {} (메타 없이도 동작)."""
    path = os.path.join(dir_path, "manifest.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    return {e["filename"]: e for e in entries if e.get("filename")}


def meta_for(filename: str, manifest: dict[str, dict]) -> dict:
    """파일의 인제스트 메타 — manifest 항목 우선, 없으면 파일명 폴백."""
    entry = manifest.get(filename) or {}
    stem = os.path.splitext(filename)[0]
    return {
        "source_name": entry.get("source_name") or stem,
        "subject": entry.get("subject") or "",
        "grade": entry.get("grade") or "",
    }


async def extract_text(path: str) -> str:
    """PDF는 Upstage Document Parse(마크다운), .txt/.md는 그대로."""
    if path.lower().endswith(".pdf"):
        with open(path, "rb") as f:
            data = f.read()
        return await upstage.parse_document(data, os.path.basename(path))
    with open(path, encoding="utf-8") as f:
        return f.read()


def build_points(
    meta: dict, chunks: list[str], vectors: list[list[float]]
) -> list[dict]:
    """청크+벡터 -> Qdrant 포인트 (id는 source_name·seq 결정론 uuid5)."""
    return [
        {
            "id": qdrant_store.textbook_point_id(meta["source_name"], seq),
            "vector": vec,
            "payload": {
                "chunk_text": chunk,
                "source_name": meta["source_name"],
                "subject": meta["subject"],
                "grade": meta["grade"],
                "seq": seq,
            },
        }
        for seq, (chunk, vec) in enumerate(zip(chunks, vectors))
    ]


async def ingest_file(
    dir_path: str, filename: str, manifest: dict[str, dict], dry_run: bool
) -> int:
    """파일 하나 인제스트. 반환: 청크 수. 실패는 raise(호출부가 집계)."""
    meta = meta_for(filename, manifest)
    text = await extract_text(os.path.join(dir_path, filename))
    chunks = embedding.chunk_text(text)
    if not chunks:
        raise RuntimeError("no extractable text")
    if dry_run:
        preview = chunks[0][:80].replace("\n", " ")
        print(
            f"dry-run: {filename} -> source={meta['source_name']!r} "
            f"chunks={len(chunks)}\n  head: {preview}"
        )
        return len(chunks)
    vectors = await upstage.embed_texts(chunks, kind="passage")
    points = build_points(meta, chunks, vectors)
    # 재인제스트 정합성: 청크 수가 줄어든 경우의 옛 tail 포인트 제거.
    await qdrant_store.delete_textbook_source(meta["source_name"])
    await qdrant_store.upsert(qdrant_store.COL_TEXTBOOK, points)
    print(
        f"  upserted: {filename} -> source={meta['source_name']!r} "
        f"chunks={len(points)}"
    )
    return len(points)


async def main() -> int:
    ap = argparse.ArgumentParser(
        description="Ingest textbook files into the Qdrant `textbook` collection."
    )
    default_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "textbooks"
    )
    ap.add_argument("--dir", default=default_dir, help="교과서 폴더 경로")
    ap.add_argument(
        "--dry-run", action="store_true", help="파싱·청킹까지만 (임베딩/업서트 생략)"
    )
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"ERROR: not a directory: {args.dir}", file=sys.stderr)
        return 2
    files = scan_files(args.dir)
    if not files:
        print(f"ERROR: no {SUPPORTED_EXTS} files in {args.dir}", file=sys.stderr)
        return 2
    manifest = load_manifest(args.dir)

    if not args.dry_run:
        if not settings.upstage_api_key:
            print("ERROR: UPSTAGE_API_KEY is not set (root .env).", file=sys.stderr)
            return 2
        await qdrant_store.ensure_collections()

    ok = 0
    failed: list[str] = []
    for name in files:
        try:
            await ingest_file(args.dir, name, manifest, args.dry_run)
            ok += 1
        except Exception as exc:  # noqa: BLE001 - 파일별 실패는 계속 진행
            failed.append(name)
            print(f"FAILED: {name} — {exc}", file=sys.stderr)

    suffix = " (dry-run)" if args.dry_run else ""
    print(f"\nDone{suffix}. ok={ok} failed={len(failed)}")
    if failed:
        print("failed files: " + ", ".join(failed), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
```

주의: `scan_files`는 `.md`를 지원하면서 폴더의 `README.md`(문서)는 제외해야 한다 — 위 구현의 `name != "README.md"` 조건이 그 역할이다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd backend && python -m pytest tests/test_ingest_textbook.py -v`
Expected: PASS (4 passed)

주의: `test_scan_files_filters_supported_exts`는 `README.md.bak`(비지원)만 제외를 검증한다. `README.md` 제외를 추가 검증하려면 해당 테스트에 `(tmp_path / "README.md").write_text("doc", encoding="utf-8")`를 추가해도 기대 목록은 그대로다 — 구현 후 추가하고 다시 실행한다.

- [ ] **Step 5: 폴더 문서 + 예시 매니페스트 생성**

`backend/textbooks/README.md`:

```markdown
# 교과서 임베딩 폴더

admin 개발자가 교과서 원문을 넣고 인제스트 파이프라인을 돌리는 폴더입니다.
서비스 런타임은 결과물(Qdrant `textbook` 컬렉션)만 읽습니다.

## 사용법

1. 이 폴더에 교과서 파일(`.pdf` / `.txt` / `.md`)을 넣는다.
2. (선택) `manifest.json`에 파일별 메타를 적는다 — `manifest.example.json`
   참고. 항목이 없는 파일은 `source_name = 파일명(확장자 제외)`,
   과목/학년 빈 값으로 인제스트된다.
3. `backend/`에서 실행한다 (root `.env`에 `UPSTAGE_API_KEY`, `QDRANT_URL` 필요):

       python scripts/ingest_textbook.py             # 이 폴더 스캔 → 업서트
       python scripts/ingest_textbook.py --dry-run   # 파싱·청킹 미리보기만

같은 `source_name`으로 재실행하면 기존 포인트를 지우고 새로 넣는다(중복 없음).
PDF는 dry-run에서도 Upstage Document Parse를 호출하므로 API 키가 필요하다.

교과서 원문은 저작권·용량 문제로 git에 커밋하지 않는다(.gitignore 처리 —
이 README와 manifest.example.json만 커밋).
```

`backend/textbooks/manifest.example.json`:

```json
[
  {
    "filename": "science-2-2022.pdf",
    "source_name": "중학 과학 2 (2022 개정)",
    "subject": "과학",
    "grade": "중2"
  }
]
```

- [ ] **Step 6: .gitignore 규칙 추가**

저장소 루트 `.gitignore` 끝에 추가:

```gitignore
# 교과서 원문(저작권·용량) — 폴더 문서·예시 매니페스트만 커밋
backend/textbooks/*
!backend/textbooks/README.md
!backend/textbooks/manifest.example.json
```

- [ ] **Step 7: dry-run 스모크 (수동 검증)**

```bash
cd backend
printf '광합성은 빛에너지를 화학 에너지로 바꾸는 과정이다.\n\n엽록체에서 일어난다.\n' > textbooks/_smoke.txt
python scripts/ingest_textbook.py --dry-run
rm textbooks/_smoke.txt
```

Expected: `dry-run: _smoke.txt -> source='_smoke' chunks=1` 형태 출력 + `Done (dry-run). ok=1 failed=0`, exit 0. (API 키·Qdrant 불필요 — .txt는 로컬 파싱.)

- [ ] **Step 8: git 상태 확인 — 원문 제외 검증**

```bash
git status --short | grep textbooks
```

Expected: `backend/textbooks/README.md`, `backend/textbooks/manifest.example.json`만 untracked로 보임 (스모크 파일을 지웠으므로 다른 항목 없음).

- [ ] **Step 9: 전체 테스트 회귀 확인**

Run: `cd backend && python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 10: 커밋**

```bash
git add backend/scripts/ingest_textbook.py backend/textbooks/README.md backend/textbooks/manifest.example.json backend/tests/test_ingest_textbook.py .gitignore
git commit -m "[feat]: 교과서 인제스트 파이프라인 — textbooks/ 폴더 스캔 → Qdrant textbook 업서트"
```

---

## 완료 후 수동 확인 (선택, 실환경)

1. `backend/textbooks/`에 실제 교과서 파일 + `manifest.json` 배치.
2. `python scripts/ingest_textbook.py` 실행 → `upserted:` 로그 확인.
3. 앱에서 교과 관련 질문 → admin 턴 로그에서 `textbook_rag` 블록 확인.
4. 인사("안녕")를 보내 블록이 주입되지 **않는** 것 확인 (거리 게이트).
5. admin 콘솔에서 `textbook_rag_max_distance` 조정 → 다음 턴 반영 확인.
