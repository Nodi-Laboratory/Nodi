# 교과서 전역 코퍼스(RAG) 완전 제거 — 구현 계획 (TASK 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채팅 턴·인제스트·저장소·설정·테스트에서 교과서 전역 코퍼스 경로를 완전 제거한다 (스펙: `docs/superpowers/specs/2026-07-14-remove-textbook-rag-design.md`).

**Architecture:** 참조 방향(chat → rag·gemini → qdrant_store·config)의 역순으로 3개 웨이브로 제거한다. 각 웨이브의 워크트리에서 전체 스위트가 GREEN이어야 한다. 웨이브 2는 3개 task 병렬, 웨이브 3은 2개 task 병렬 — 각 task의 파일은 서로소.

**Tech Stack:** FastAPI(Python), pytest, Qdrant, Supabase 마이그레이션(SQL).

## Global Constraints

- **제거 task이므로 TDD RED→GREEN 대신** (PROCESS.md DoD 예외): ① 전체 스위트 GREEN + ② 제거 심볼 잔존 참조 grep 0건이 증거.
- 전체 스위트 실행(워크트리 안, 메인 저장소 venv 절대경로):
  `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
- 워크트리 시작 시 1회: `cp /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.env <워크트리>/backend/.env` (gitignore라 커밋 혼입 없음).
- 커밋은 **자기 파일만 `git add`** (`git add -A`/`git add .`/`-a` 금지). 커밋 메시지는 한국어, 프리픽스 `[chore]:`.
- 주석·docstring 한국어 유지. 제거하며 남는 주석이 현실과 어긋나지 않게 함께 갱신.

---

## 웨이브 1 (단독 — 호출부 먼저 끊는다)

### Task 1-1: chat.py 호출부 제거 + 배선 테스트 정리

**Files:**
- Modify: `backend/app/routers/chat.py` (import 1줄 + 질의 임베딩 블록 + gather leg + compose 인자)
- Modify: `backend/tests/test_chat_place.py` (textbook 몽키패치·테스트 제거)

**Interfaces:**
- Consumes: 없음 (첫 task).
- Produces: chat.py가 `rag.build_textbook_context`·`upstage.embed_query`를 더 이상 호출하지 않음 → 웨이브 2에서 rag.py·gemini.py의 textbook 코드를 제거할 수 있게 된다. `gemini.compose_system_structured`는 이 시점부터 `textbook_context`/`textbook_sources` 키워드 인자 **없이** 호출된다 (파라미터 자체는 Task 1-3이 제거).

- [ ] **Step 1: chat.py에서 upstage import 제거**

`backend/app/routers/chat.py`의 import 절에서 아래 1줄을 삭제한다 (`upstage`는 이 파일에서 질의 임베딩 전용 — 다른 사용처 없음, 실측):

```python
from ..services import upstage
```

- [ ] **Step 2: 질의 임베딩 블록 + gather의 textbook leg 제거**

같은 파일 `chat_stream` 안의 아래 블록 전체를:

```python
    # 질의 임베딩 1회 — 교과서 RAG 검색용(카드 배치는 프론트 소유라 서버 임베딩 불필요).
    # 실패해도 턴을 죽이지 않는다: 빈 벡터 → 교과서 블록만 생략.
    try:
        qvec = await upstage.embed_query(body.question)
    except Exception:  # noqa: BLE001
        logger.warning(
            "질의 임베딩 실패 — 교과서 RAG 생략 session=%s",
            body.session_id,
            exc_info=True,
        )
        qvec = []

    # All four context builders read the same ancestor chain but are otherwise
    # independent, and each is internally best-effort (own try/except, safe
    # defaults on failure). Run them concurrently to cut first-token latency —
    # the RAG builder's question-embedding Gemini call is the heaviest leg (D66).
    #   - reference:  imported other-branch context (node connections, LCA-trimmed, 3a, D35)
    #   - rag:        chunks from files linked to this branch (Stage 3b-2, D32 sources)
    #   - comparison: one-time branch references for THIS turn (D15/D46, LCA-trimmed)
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

아래로 교체한다:

```python
    # All three context builders read the same ancestor chain but are otherwise
    # independent, and each is internally best-effort (own try/except, safe
    # defaults on failure). Run them concurrently to cut first-token latency —
    # the RAG builder's question-embedding Gemini call is the heaviest leg (D66).
    #   - reference:  imported other-branch context (node connections, LCA-trimmed, 3a, D35)
    #   - rag:        chunks from files linked to this branch (Stage 3b-2, D32 sources)
    #   - comparison: one-time branch references for THIS turn (D15/D46, LCA-trimmed)
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(client, chain, body.question),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
```

- [ ] **Step 3: compose 호출에서 textbook 인자 2줄 제거**

같은 파일의 `gemini.compose_system_structured(...)` 호출에서 아래 2줄을 삭제한다 (다른 인자는 그대로):

```python
        textbook_context=textbook_context,
        textbook_sources=textbook_sources,
```

- [ ] **Step 4: test_chat_place.py에서 textbook 배선 제거**

`backend/tests/test_chat_place.py`를 다음과 같이 고친다.

`_consume` 시그니처에서 `textbook_result`·`spy` 파라미터 제거:

```python
async def _consume(monkeypatch, *, retrieved=None):
```

`_consume` 본문에서 아래 세 블록을 삭제한다:

```python
    async def fake_textbook(qv):
        if spy is not None:
            spy["textbook_qvec"] = qv
        return textbook_result

    monkeypatch.setattr(C.rag, "build_textbook_context", fake_textbook)
```

```python
    async def fake_embed_query(q):
        return [0.1] * 10

    monkeypatch.setattr(C.upstage, "embed_query", fake_embed_query)
```

(`C.upstage`는 Step 1 이후 존재하지 않으므로 반드시 삭제해야 한다.)

`fake_compose`의 spy 캡처를 제거하고 단순화한다:

```python
    def fake_compose(*a, **k):
        return ("sys", [])
```

파일 끝의 textbook 테스트 2개(`test_textbook_context_wired_qvec_reused_and_composed`, `test_textbook_none_composes_without_block`)를 함수 전체로 삭제한다.

- [ ] **Step 5: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "textbook|upstage|qvec|교과서" backend/app/routers/chat.py backend/tests/test_chat_place.py`
Expected: 0건 (출력 없음)

- [ ] **Step 6: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS (기존 textbook 테스트 파일들은 아직 존재하며 rag/gemini 미변경이라 그대로 통과)

- [ ] **Step 7: 커밋**

```bash
git add backend/app/routers/chat.py backend/tests/test_chat_place.py
git commit -m "[chore]: 채팅 턴에서 교과서 RAG 호출부 제거 — 질의 임베딩·gather leg·compose 인자

교과서 전역 코퍼스 폐기(TASK 1, 스펙 2026-07-14-remove-textbook-rag-design).
qvec은 textbook 검색 전용이었으므로 질의 임베딩 호출 자체를 제거 — 첫 토큰
지연 소폭 개선. 컨텍스트 빌더 gather는 4-leg → 3-leg."
```

---

## 웨이브 2 (병렬 3 — 웨이브 1 회수 후 착수, 파일 서로소)

### Task 1-2: rag.py 교과서 빌더 제거

**Files:**
- Modify: `backend/app/services/rag.py` (교과서 섹션 전체)
- Delete: `backend/tests/test_rag_textbook.py`

**Interfaces:**
- Consumes: Task 1-1 완료 — chat.py가 `build_textbook_context`를 더 이상 호출하지 않음.
- Produces: rag.py가 `qdrant_store.COL_TEXTBOOK`·`settings.textbook_rag_*`를 더 이상 참조하지 않음 → 웨이브 3(Task 1-5, 1-6) 착수 가능.

- [ ] **Step 1: rag.py에서 교과서 섹션 삭제**

`backend/app/services/rag.py`에서 `build_rag_context`의 `return None` 직후부터 `def _branch_query_text(` 직전까지, 아래 블록 전체(섹션 주석 + `TEXTBOOK_BLOCK_HEADER` + `build_textbook_context`)를 삭제한다:

```python
# --- 교과서 RAG (전역 코퍼스, 스펙 2026-07-13-textbook-rag-design) ---------
# file_chunks와 달리 교과서는 시스템 공용 지식 베이스라 RLS 재검증이 없다 —
# 본문은 Qdrant 페이로드(chunk_text)에서 바로 읽는다. Supabase 왕복 없음.
TEXTBOOK_BLOCK_HEADER = "[교과서에서 참고]"


async def build_textbook_context(
    query_vector: list[float],
) -> dict[str, Any] | None:
```

(위 시그니처부터 함수 본문 끝 `return None`까지 전부 — 함수 하나 통째로. 삭제 후 `build_rag_context`와 `_branch_query_text` 사이에 빈 줄 2개만 남긴다. import 절은 변경하지 않는다 — `app_settings`·`qdrant_store`·`settings`는 파일 RAG·파일 제안이 계속 사용.)

- [ ] **Step 2: 테스트 파일 삭제**

```bash
git rm backend/tests/test_rag_textbook.py
```

- [ ] **Step 3: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "textbook|TEXTBOOK|교과서" backend/app/services/rag.py backend/tests/`
Expected: rag.py 0건. tests에는 다른 task 담당 파일(`test_compose_textbook.py`·`test_qdrant_textbook.py`·`test_ingest_textbook.py`)만 남아 있음 — **건드리지 않는다.**

- [ ] **Step 4: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/rag.py backend/tests/test_rag_textbook.py
git commit -m "[chore]: rag.py 교과서 전역 코퍼스 빌더 제거 — build_textbook_context·전용 테스트

호출부는 이전 커밋에서 제거됨(TASK 1). 파일 RAG·파일 제안 경로는 무변경."
```

### Task 1-3: gemini.py 교과서 블록 제거

**Files:**
- Modify: `backend/app/services/gemini.py` (`_WRAP_TEXTBOOK`·파라미터 2개·블록 분기·docstring)
- Delete: `backend/tests/test_compose_textbook.py`

**Interfaces:**
- Consumes: Task 1-1 완료 — 호출부(chat.py)가 textbook 키워드 인자를 더 이상 넘기지 않음.
- Produces: `compose_system_structured(reference_context, rag_context=None, comparison_context=None, *, rag_sources=None, reference_node_ids=None, comparison_node_ids=None, base_instruction=None) -> tuple[str, list[dict]]` — textbook 파라미터가 사라진 최종 시그니처.

- [ ] **Step 1: `_WRAP_TEXTBOOK` 상수 삭제**

`backend/app/services/gemini.py`에서 아래 블록을 삭제한다:

```python
_WRAP_TEXTBOOK = (
    "아래는 한국 교과서에서 질문과 관련해 검색된 내용입니다. 답변의 근거로 "
    "우선 활용해 교과 과정에 맞는 정확한 설명을 하고, 교과서에 없는 내용은 "
    "일반 지식으로 보완하되 출처를 구분하세요.\n\n"
)
```

- [ ] **Step 2: 시그니처에서 textbook 파라미터 2개 삭제**

`compose_system_structured`의 파라미터 목록에서 아래 2줄을 삭제한다:

```python
    textbook_context: str | None = None,
```

```python
    textbook_sources: list[dict] | None = None,
```

- [ ] **Step 3: docstring의 textbook 항목 삭제**

docstring에서 아래 1줄을 삭제한다:

```python
    - `textbook_context`: 전역 교과서 코퍼스에서 검색된 청크 (교과서 RAG).
```

- [ ] **Step 4: textbook_rag 블록 분기 삭제**

함수 본문에서 아래 블록 전체를 삭제한다:

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

- [ ] **Step 5: 테스트 파일 삭제**

```bash
git rm backend/tests/test_compose_textbook.py
```

- [ ] **Step 6: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "textbook|TEXTBOOK|교과서" backend/app/services/gemini.py`
Expected: 0건

- [ ] **Step 7: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 8: 커밋**

```bash
git add backend/app/services/gemini.py backend/tests/test_compose_textbook.py
git commit -m "[chore]: compose_system_structured에서 textbook_rag 블록 제거 (TASK 1)

D35 블록 span 규약은 나머지 블록(memory_link·rag·comparison)에 그대로 유지."
```

### Task 1-4: 인제스트 경로 삭제 (스크립트·폴더·.gitignore)

**Files:**
- Delete: `backend/scripts/ingest_textbook.py`
- Delete: `backend/textbooks/README.md`, `backend/textbooks/manifest.example.json`
- Modify: `.gitignore` (textbooks 규칙 3줄)
- Delete: `backend/tests/test_ingest_textbook.py`

**Interfaces:**
- Consumes: 없음 (오프라인 스크립트 — 런타임 참조 없음).
- Produces: `qdrant_store.textbook_point_id`·`delete_textbook_source`·`COL_TEXTBOOK`의 마지막 스크립트 사용처 소멸 → Task 1-5 착수 가능.

- [ ] **Step 1: 파일 삭제**

```bash
git rm backend/scripts/ingest_textbook.py backend/tests/test_ingest_textbook.py
git rm backend/textbooks/README.md backend/textbooks/manifest.example.json
```

- [ ] **Step 2: .gitignore에서 textbooks 규칙 삭제**

`.gitignore`에서 아래 3줄을 삭제한다:

```
backend/textbooks/*
!backend/textbooks/README.md
!backend/textbooks/manifest.example.json
```

- [ ] **Step 3: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "ingest_textbook|textbooks" .gitignore backend/ 2>/dev/null; ls backend/textbooks 2>&1`
Expected: grep 0건 + `ls`는 "No such file or directory" (워크트리 기준 — 메인 저장소에는 gitignore돼 있던 실제 교과서 파일이 남을 수 있으며, 그 물리 삭제는 Manager가 마무리 단계에서 처리하므로 이 task 범위 아님)

- [ ] **Step 4: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add .gitignore
git commit -m "[chore]: 교과서 인제스트 경로 삭제 — 스크립트·textbooks/·gitignore 규칙 (TASK 1)

admin이 교과서를 입력하지 않는다 — 교과서는 선생님이 워크스페이스에 업로드(TASK 2)."
```

(`git rm`은 이미 스테이징되므로 `.gitignore`만 추가 add.)

---

## 웨이브 3 (병렬 2 — 웨이브 2 회수 후 착수, 파일 서로소)

### Task 1-5: qdrant_store.py 교과서 저장소 코드 제거

**Files:**
- Modify: `backend/app/services/qdrant_store.py` (상수·id 함수·컬렉션 튜플·인덱스 루프·삭제 함수)
- Delete: `backend/tests/test_qdrant_textbook.py`

**Interfaces:**
- Consumes: Task 1-2(rag.py)·1-4(ingest 스크립트) 완료 — `COL_TEXTBOOK`·`textbook_point_id`·`delete_textbook_source`의 프로덕션 사용처 0.
- Produces: 없음 (말단).

- [ ] **Step 1: `COL_TEXTBOOK` 상수 삭제**

```python
COL_TEXTBOOK = "textbook"
```

- [ ] **Step 2: `textbook_point_id` 함수 삭제**

```python
def textbook_point_id(source_name: str, seq: int) -> str:
    """textbook 포인트 id — 재실행 ingest가 덮어쓰도록 결정론 uuid5."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"textbook:{source_name}:{seq}"))
```

- [ ] **Step 3: `ensure_collections`의 컬렉션 튜플에서 제거**

```python
        for name in (COL_FILE_CHUNKS, COL_ART, COL_EBS, COL_CANVAS_CARDS, COL_TEXTBOOK):
```

를 아래로 교체:

```python
        for name in (COL_FILE_CHUNKS, COL_ART, COL_EBS, COL_CANVAS_CARDS):
```

- [ ] **Step 4: textbook 페이로드 인덱스 루프 삭제**

`ensure_collections` 안의 아래 블록 전체(주석 포함)를 삭제한다:

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

- [ ] **Step 5: `delete_textbook_source` 함수 삭제**

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

- [ ] **Step 6: 테스트 파일 삭제**

```bash
git rm backend/tests/test_qdrant_textbook.py
```

- [ ] **Step 7: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "textbook|TEXTBOOK|교과서" backend/app/services/qdrant_store.py backend/`
Expected: qdrant_store.py 0건. backend 전체에서는 config.py(Task 1-6 담당)만 잔존 가능 — **건드리지 않는다.**

- [ ] **Step 8: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 9: 커밋**

```bash
git add backend/app/services/qdrant_store.py backend/tests/test_qdrant_textbook.py
git commit -m "[chore]: qdrant_store 교과서 컬렉션 코드 제거 — COL_TEXTBOOK·id·인덱스·삭제 함수

기존 로컬 textbook 컬렉션 데이터는 건드리지 않는다(스펙 비범위) —
ensure_collections에서 빠져 새 환경에는 생성되지 않음."
```

### Task 1-6: config.py 노브·0029 마이그레이션 삭제

**Files:**
- Modify: `backend/app/config.py` (textbook 섹션 4줄)
- Delete: `supabase/migrations/0029_app_settings_textbook_seed.sql`

**Interfaces:**
- Consumes: Task 1-2 완료 — `settings.textbook_rag_*`의 마지막 사용처(rag.py) 소멸.
- Produces: 없음 (말단).

- [ ] **Step 1: config.py에서 textbook 노브 삭제**

`backend/app/config.py`에서 아래 4줄을 삭제한다:

```python
    # --- Textbook RAG (전역 교과서 코퍼스, Qdrant `textbook` 컬렉션) ---
    textbook_rag_enabled: bool = True  # 교과서 블록 주입 전체 on/off
    textbook_rag_top_k: int = 4  # 질문당 검색·주입 최대 청크 수
    textbook_rag_max_distance: float = 0.45  # 거리 게이트(1-score), 초과분 탈락
```

- [ ] **Step 2: 0029 마이그레이션 삭제**

원격 DB 미적용 실측(2026-07-14, `list_migrations` 결과 0028까지 + `app_settings` textbook 행 0건) — 역방향 마이그레이션 불필요, 파일 삭제로 충분:

```bash
git rm supabase/migrations/0029_app_settings_textbook_seed.sql
```

- [ ] **Step 3: 잔존 참조 grep 확인**

Run: `cd <워크트리> && rg -n "textbook|TEXTBOOK|교과서" backend/app/config.py supabase/`
Expected: 0건

- [ ] **Step 4: 전체 스위트 GREEN 확인**

Run: `cd <워크트리>/backend && /Users/dhkim/Desktop/ai-rookie/Nodi/backend/.venv/bin/python -m pytest tests/ -v`
Expected: 전부 PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/config.py
git commit -m "[chore]: textbook_rag 튜너블 3종·0029 시드 마이그레이션 삭제 (TASK 1)

0029는 원격 DB 미적용 실측(0028까지 적용, app_settings textbook 행 0건) —
역방향 마이그레이션 없이 파일 삭제로 정리."
```

---

## 마무리 (Manager — 웨이브 3 회수 후)

1. 최종 grep: `rg -n -i "textbook" backend/ supabase/ .gitignore` → 0건,
   `rg -n "교과서" backend/ supabase/` → 0건.
2. 전체 스위트 메인 저장소에서 1회: `cd backend && .venv/bin/python -m pytest tests/ -v`.
3. 메인 저장소에 gitignore로 남은 `backend/textbooks/` 물리 잔재 확인 후 제거.
4. E2E 검증(프론트엔드 리뷰어): 채팅 턴 정상 + textbook 블록 부재.
5. 문서 동기화: `CLAUDE.md` 제품 모델 "⚠️ 폐기된 방향" 항목·핵심 파이프라인 leg 갱신,
   `docs/TASKS.md` TASK 1 체크박스, 원장 마감.
