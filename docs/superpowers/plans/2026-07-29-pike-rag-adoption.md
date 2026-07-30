# PIKE-RAG 적용 (TASK 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PIKE-RAG의 검색 품질 기법 4종(지식 원자화 이중 검색 D129, 태스크 분해 강화 D130, figure 캡션 비전 생성 D131, LLM 의미 청킹 D132)을 킬스위치 기본 off로 이식한다.

**Architecture:** 인제스트는 기존 잡 팬아웃 패턴(D88 격리)을 확장 — 신규 `atom_batch` 잡이 청크당 solar-pro2로 예상 질문을 생성해 Qdrant `chunk_atoms` 컬렉션에 embedding-passage로 적재한다. 검색은 `rag.dual_search`가 청크·원자 컬렉션을 동시 검색 후 병합한다. figure는 비전 모델이 페이지 텍스트를 컨텍스트로 캡션을 생성한다. 의미 청킹은 split 시점에 LLM이 경계를 재조정한다(실패 시 정규식 폴백).

**Tech Stack:** FastAPI · Postgres(RLS) · Qdrant · Upstage(solar-pro2, embedding-query/passage) · judge_* 비전 엔드포인트(OpenAI 호환).

## Global Constraints (스펙 §2 — 전 task 공통)

- 킬스위치 기본 off: `atom_rag_enabled=false` · `rag_query_rewrite_enabled=false` · `figure_caption_generate_enabled=false` · `semantic_chunking_enabled=false`. **off = 기존 경로 완전 보존**(기존 테스트 무수정 그린이 회귀 게이트).
- 실패 폴백: 원자화 실패 → 청크 인덱싱 무영향(files.status 불가침). LLM 청킹 실패 → `embedding.chunk_text` 폴백. 캡션 생성 실패 → parsed 캡션 폴백, 없으면 failed.
- 불변식: Qdrant 페이로드 식별자만(본문 금지) + USER 스코프 Postgres 재조회(RLS). 임베딩 비대칭(질의 `RETRIEVAL_QUERY`/문서 `RETRIEVAL_DOCUMENT`). `distance = 1 - score`.
- 워커 모듈은 **모듈 채로 임포트해 한정 호출**(`common._qdrant_upsert(...)`) — monkeypatch 규약(common.py 독스트링).
- 주석·커밋 메시지 한국어, 커밋 프리픽스 `[feat]:`/`[fix]:`, D-번호를 코드 주석에 남긴다.
- 테스트: `cd backend && uv run pytest tests/ -v` (전부 mock — 키·네트워크 불필요). 워크트리 에이전트는 메인 저장소 venv 인터프리터 절대경로 사용.
- 새 노브 = `config.py` 필드 + 호출부 `app_settings.as_*(overlay, key, default, lo, hi)` + `db/03_app_settings.sql` 시드(콘솔 노출 대상만).

## 구현 순서와 병렬성

```
task6-1 (기반: 스키마·노브·컬렉션·touch_job)   ── 선행, 단독
  ├─ task6-2 (atomize.py 순수부)      ┐ 병렬 가능 (파일 서로소)
  ├─ task6-4 (rag.dual_search)        ┘
  ├─ task6-3 (atom_batch 워커)        ← 6-2 이후 (atomize 임포트)
  └─ task6-5 (스킬 배선 + 삭제 퍼지)   ← 6-4 이후
task6-6 (단계 C: 분해 지침 + 질문 정제) ← 6-5 이후 (search_class_material 같은 파일)
  ├─ task6-7 (figure_caption.py 순수부) ┐ 6-1 이후 언제든 병렬
  └─ task6-8 (figure 워커 캡션 교체)     ← 6-7 이후 (split.py는 6-3과 겹침 — 6-3 뒤에)
task6-9 (semantic_chunker.py 순수부)    ← 6-1 이후 언제든
task6-10 (split.py 의미 청킹 분기)      ← 6-9·6-8 이후 (split.py 순차)
task6-11 (마무리 검증·문서 동기화)       ── Manager
```

**split.py 경합 주의**: task6-3(atom 팬아웃) → task6-8(page_text 팬아웃) → task6-10(청킹 분기)은 같은 파일을 만지므로 **반드시 순차**.

---

### Task 6-1: 공통 기반 — 스키마·노브·Qdrant 컬렉션·잡 하트비트

**Files:**
- Create: `db/migrations/2026-07-29-pike-rag-infra.sql`
- Modify: `db/01_schema.sql` (jobs_kind_check 537행 부근, textbook_figures 570행 부근, file_chunks RLS 정책 763행 부근을 본뜬 chunk_atoms 정책)
- Modify: `db/03_app_settings.sql`
- Modify: `backend/app/config.py`
- Modify: `backend/app/services/qdrant_store.py`
- Modify: `backend/app/services/worker/common.py`
- Test: `backend/tests/test_worker_common.py` (touch_job — 신규 또는 기존 워커 테스트 파일에 추가)

**Interfaces (Produces):**
- `qdrant_store.COL_CHUNK_ATOMS = "chunk_atoms"` — ensure_collections 루프·file_id 인덱스 합류
- `common.touch_job(svc, job_id: str) -> None` — jobs.updated_at 전진(하트비트, D133)
- config 필드(전 단계 노브 일괄 — 이후 task는 config.py를 만지지 않는다):

```python
# ── PIKE-RAG (TASK 6, D129~D132) ─────────────────────────────
# A. 지식 원자화 (D129) — 킬스위치 off 출하, 캘리브레이션 후 on
atom_rag_enabled: bool = False
atom_questions_per_chunk: int = 3      # 청크당 예상 질문 수(비용 직결)
atom_top_k: int = 5                    # chunk_atoms 컬렉션 top-K
atom_rag_max_distance: float = 0.45    # 원자 거리 게이트(질문↔질문 — 실측 후 조정)
atom_gen_concurrency: int = 4          # solar 동시 호출
atom_batch_size: int = 16              # atom_batch 팬아웃 단위(스테일 120s 여유)
# C. 질문 정제 (D130)
rag_query_rewrite_enabled: bool = False
# D. figure 캡션 비전 생성 (D131) — off면 D103 경로 그대로
figure_caption_generate_enabled: bool = False
figure_page_text_max_chars: int = 4000  # 비전 프롬프트 페이지 컨텍스트 절단
# B. LLM 의미 청킹 (D132)
semantic_chunking_enabled: bool = False
semantic_chunking_max_chars: int = 120_000   # 초과 문서는 통째로 정규식 폴백
semantic_chunking_max_llm_calls: int = 120   # 경계 판단 콜 수 2차 가드
```

**Steps:**

- [ ] **Step 1: 마이그레이션 SQL 작성** — `db/migrations/2026-07-29-pike-rag-infra.sql`:

```sql
-- TASK 6 (D129/D131): chunk_atoms 테이블 + jobs kind 확장 + figure 페이지 텍스트.
-- 원격 적용은 사용자 승인 후(README 배포 절차). 빈 볼륨 신규 기동은 01_schema.sql이 커버.
CREATE TABLE public.chunk_atoms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id uuid NOT NULL REFERENCES public.file_chunks(id) ON DELETE CASCADE,
    file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    chunk_seq integer NOT NULL,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT chunk_atoms_status_check CHECK
      ((status = ANY (ARRAY['pending'::text, 'embedded'::text, 'failed'::text])))
);
CREATE INDEX idx_chunk_atoms_file ON public.chunk_atoms (file_id, status);
CREATE INDEX idx_chunk_atoms_chunk ON public.chunk_atoms (chunk_id);
ALTER TABLE public.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK
  ((kind = ANY (ARRAY['embedding_split'::text, 'embedding_batch'::text,
                      'figure_batch'::text, 'atom_batch'::text])));
ALTER TABLE public.textbook_figures ADD COLUMN page_text text DEFAULT ''::text NOT NULL;
-- RLS: 쓰기는 워커(BYPASSRLS) 전용. SELECT는 file_chunks 정책과 동형
-- (부모 파일 접근 가능 시 열람 — 매칭된 원자 질문 관측용).
ALTER TABLE public.chunk_atoms ENABLE ROW LEVEL SECURITY;
-- 아래 정책·GRANT 본문은 01_schema.sql의 file_chunks SELECT 정책·GRANT를 복사해
-- 테이블명만 바꾼다(정책 이름: chunk_atoms_select). nodi_app에 SELECT만 GRANT.
```

01_schema.sql에 동일 내용을 동기화한다(테이블은 file_chunks 근처, kind CHECK는 537행, page_text는 textbook_figures 정의 570행 부근, 정책은 763행 file_chunks 정책 블록 다음). **file_chunks의 실제 SELECT 정책·GRANT 문을 복사해 chunk_atoms용으로 만든다** — 접근 조건(owner or 학급 자료 멤버)이 글자 그대로 같아야 한다.

- [ ] **Step 2: 03_app_settings.sql 시드 추가** (기존 insert values 목록 끝에):

```sql
    -- PIKE-RAG (TASK 6, D129~D132)
    ('atom_rag_enabled',                'false'),
    ('atom_questions_per_chunk',        '3'),
    ('atom_top_k',                      '5'),
    ('atom_rag_max_distance',           '0.45'),
    ('atom_gen_concurrency',            '4'),
    ('rag_query_rewrite_enabled',       'false'),
    ('figure_caption_generate_enabled', 'false'),
    ('semantic_chunking_enabled',       'false'),
    ('semantic_chunking_max_chars',     '120000')
```
(`atom_batch_size`·`figure_page_text_max_chars`·`semantic_chunking_max_llm_calls`는 config 전용 — 시드하지 않는다.)

- [ ] **Step 3: config.py 노브 추가** (위 Interfaces 블록 그대로, figure_* 계열 노브 근처에 배치)

- [ ] **Step 4: qdrant_store.py** — `COL_TEXTBOOK_FIGURES` 아래에:

```python
# 원자 질문 임베딩 컬렉션(TASK 6, D129). 청크당 solar가 생성한 예상 질문을
# embedding-passage로 임베딩해 저장한다. 페이로드는 {atom_id, chunk_id, file_id,
# owner_id}만(질문 본문 금지) — 히트 후 chunk_id로 file_chunks를 RLS 재조회한다.
COL_CHUNK_ATOMS = "chunk_atoms"
```
`ensure_collections()`의 컬렉션 튜플에 합류 + `COL_CHUNK_ATOMS` file_id KEYWORD 페이로드 인덱스 try/except 블록 추가(COL_TEXTBOOK_FIGURES 블록과 동형).

- [ ] **Step 5: 실패 테스트 작성** — touch_job:

```python
# tests/test_worker_common.py
import pytest
from app.services.worker import common

class _FakeSvc:
    def __init__(self):
        self.updates = []
    async def update(self, table, filters, patch):
        self.updates.append((table, filters, patch))
        return [{}]

@pytest.mark.asyncio
async def test_touch_job_updated_at_전진():
    svc = _FakeSvc()
    await common.touch_job(svc, "job-1")
    assert svc.updates and svc.updates[0][0] == "jobs"
    assert svc.updates[0][1] == {"id": "eq.job-1"}
    assert "updated_at" in svc.updates[0][2]

@pytest.mark.asyncio
async def test_touch_job_실패는_삼킨다():
    class _Boom:
        async def update(self, *a):
            raise RuntimeError("db down")
    await common.touch_job(_Boom(), "job-1")  # raise하지 않아야 한다
```

- [ ] **Step 6: 실행해 FAIL 확인** — `uv run pytest tests/test_worker_common.py -v` → `AttributeError: touch_job`

- [ ] **Step 7: common.py에 touch_job 구현**:

```python
async def touch_job(svc: Any, job_id: str) -> None:
    """장기 잡 하트비트(D133) — jobs.updated_at을 전진시켜 스테일 복구(120초)의
    오탐 재클레임을 막는다. LLM을 여러 번 부르는 잡(atom_batch·figure 캡션 생성·
    의미 청킹)이 N콜마다 부른다. 실패는 삼킨다 — 하트비트가 잡을 죽이면 본말전도."""
    try:
        await svc.update(
            "jobs", {"id": f"eq.{job_id}"}, {"updated_at": _now_iso()}
        )
    except Exception:  # noqa: BLE001
        logger.warning("touch_job 실패 job=%s", job_id, exc_info=True)
```

- [ ] **Step 8: PASS 확인 + 전체 스위트** — `uv run pytest tests/ -v`
- [ ] **Step 9: 로컬 스키마 검증** — `docker compose down -v && docker compose up -d postgres` 후 psql로 `\d chunk_atoms`·jobs CHECK 확인 (또는 빈 볼륨이 부담이면 마이그레이션 SQL을 로컬 DB에 직접 적용해 확인)
- [ ] **Step 10: 커밋** — `[feat]: PIKE-RAG 기반 — chunk_atoms 스키마·노브·컬렉션·잡 하트비트 (D129/D133)` (자기 파일만 add)

---

### Task 6-2: atomize.py — 원자 질문 프롬프트·파서 (순수부)

**Files:**
- Create: `backend/app/services/atomize.py`
- Test: `backend/tests/test_atomize.py`

**Interfaces (Produces):**
- `atomize.build_atom_messages(chunk_text: str, n: int) -> list[dict]` — solar.complete용 messages
- `atomize.parse_atom_questions(content: str, max_n: int) -> list[str]`

**Steps:**

- [ ] **Step 1: 실패 테스트**:

```python
# tests/test_atomize.py
from app.services import atomize

def test_build_atom_messages_프롬프트_구성():
    msgs = atomize.build_atom_messages("가야는 철과 토기 문화로 유명하다.", 3)
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"
    assert "가야는 철과 토기" in msgs[1]["content"]
    assert "3개" in msgs[1]["content"]
    assert "지시대명사" in msgs[1]["content"]

def test_parse_번호_기호_제거():
    content = "1. 가야 토기의 특징은?\n- 가야는 어디에 있었나?\n③ 철기 문화란?"
    out = atomize.parse_atom_questions(content, 5)
    assert out == ["가야 토기의 특징은?", "가야는 어디에 있었나?", "철기 문화란?"]

def test_parse_빈줄_중복_상한():
    content = "질문 하나?\n\n질문 하나?\n질문 둘?\n질문 셋?"
    assert atomize.parse_atom_questions(content, 2) == ["질문 하나?", "질문 둘?"]

def test_parse_빈_응답():
    assert atomize.parse_atom_questions("", 3) == []
```

- [ ] **Step 2: FAIL 확인** — `uv run pytest tests/test_atomize.py -v`

- [ ] **Step 3: 구현** — `backend/app/services/atomize.py`:

```python
"""원자 질문 생성 프롬프트·파서 (TASK 6, D129) — PIKE-RAG atom_prompt_ko 이식.

청크 하나에서 "이 청크로 답할 수 있는 핵심 질문 n개"를 뽑는다. 질문은
embedding-passage로 임베딩되어 chunk_atoms 컬렉션에 들어가고, 학생 질의
(embedding-query)와 질문↔질문 매칭으로 검색 재현율을 높인다.

순수 함수만 둔다 — solar 호출·DB는 워커(worker/atoms.py)가 한다.
"""
from __future__ import annotations

import re

_SYSTEM = "당신은 글의 내용을 정확히 이해하고 좋은 질문을 만드는 한국어 AI 도우미입니다."

# 줄머리 번호·기호 제거: "1.", "1)", "①", "-", "*", "·" 등.
_LEAD_RE = re.compile(r"^\s*(?:[-*·•]|\(?\d{1,2}[.)]|[①-⑳])\s*")


def build_atom_messages(chunk_text: str, n: int) -> list[dict]:
    """PIKE atom_question_tagging_ko_template 이식 — 개체명 포함·지시대명사 금지."""
    user = (
        "# 과제\n"
        f"아래 내용으로 답할 수 있는 가장 핵심적인 질문 {n}개만 뽑아내세요. "
        "서로 다른 내용으로, 중복·유사 질문은 피하세요.\n"
        "각 질문에는 필요한 고유명사·용어를 포함하고, "
        "'그것/이것/그 사람' 같은 지시대명사는 쓰지 마세요.\n\n"
        "# 출력 형식\n"
        "질문을 한 줄에 하나씩, 번호나 기호 없이 출력하세요.\n\n"
        f"# 내용\n{chunk_text}\n\n# 출력:"
    )
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]


def parse_atom_questions(content: str, max_n: int) -> list[str]:
    """줄 단위 파싱 — 번호·기호 제거, 빈 줄·중복 제거, max_n 절단."""
    out: list[str] = []
    seen: set[str] = set()
    for line in (content or "").splitlines():
        q = _LEAD_RE.sub("", line).strip()
        if not q or q in seen:
            continue
        seen.add(q)
        out.append(q)
        if len(out) >= max_n:
            break
    return out
```

- [ ] **Step 4: PASS 확인** — `uv run pytest tests/test_atomize.py -v`
- [ ] **Step 5: 커밋** — `[feat]: 원자 질문 프롬프트·파서 — PIKE atom_prompt_ko 이식 (D129)`

---

### Task 6-3: atom_batch 워커 — 팬아웃·생성·임베딩·적재

**Files:**
- Create: `backend/app/services/worker/atoms.py`
- Modify: `backend/app/services/worker/split.py` (팬아웃 + 멱등 정리)
- Modify: `backend/app/services/worker/runner.py` (`_process` 분기 + `requeue_file`)
- Modify: `backend/app/services/worker/jobs.py` (`_fail_file_for_job` atom 분기)
- Test: `backend/tests/test_worker_atoms.py`

**Interfaces:**
- Consumes: `atomize.build_atom_messages`/`parse_atom_questions` (6-2), `common.touch_job`·`qdrant_store.COL_CHUNK_ATOMS`·config 노브 (6-1), `solar.complete(messages, max_tokens=…) -> Completion(message={"content": …})`
- Produces: `atoms._handle_atom_batch(svc, job)` · `atoms._requeue_atoms(svc, f, file_id) -> str | None` · split의 atom_batch 팬아웃(잡 shape는 figure_batch와 동형: `{owner_id, kind: "atom_batch", target_id, parent_job_id, batch_range: {from_seq, to_seq}, status: "queued", space_ref}`)

**핵심 동작 (figures.py `_handle_figure_batch`를 본뜬다):**

1. batch_range의 `file_chunks`(seq 범위, `select: id,seq,chunk_text`) 조회 — status 무관(청크 본문만 필요).
2. **행 단위 멱등**: `chunk_atoms`에서 이 청크 id들의 기존 행을 조회해, 이미 원자가 있는 청크는 스킵(재시도·재큐 시 중복 insert 방지).
3. 킬스위치 재확인(`atom_rag_enabled` — 팬아웃 후 off로 바꾼 경우 잡을 done으로 조용히 마감).
4. 청크당 `solar.complete(atomize.build_atom_messages(chunk_text, n), max_tokens=256)` → `parse_atom_questions`. 동시성은 `asyncio.Semaphore(atom_gen_concurrency)`. **4청크마다 `common.touch_job`**(하트비트). 개별 실패는 그 청크만 건너뜀(질문 0개) — 연속 5회 실패 시 회로차단(figure_judge CIRCUIT_BREAK 패턴, 배치 실패 처리).
5. `chunk_atoms` insert(status='pending') → `embedding.embed_texts(questions, task_type="RETRIEVAL_DOCUMENT")` → 개수 검증 → `common._qdrant_upsert(points, collection=qdrant_store.COL_CHUNK_ATOMS)` — 포인트 id=원자 uuid(insert가 returning으로 id 회수), 페이로드 `{"atom_id", "chunk_id", "file_id", "owner_id"}` → 행 embedded.
6. 임베딩·Qdrant 실패 = 행 failed + `jobs._fail_job`(attempts 재시도 상속). **files.status·_finalize_file 절대 건드리지 않는다**(D88 동형).

**split.py 수정 지점** (경합 주의 — 이 task가 split.py를 만지는 첫 task):
- 멱등 정리: `await common._qdrant_delete_file_points(file_id)` 다음 줄에 `await common._qdrant_delete_file_points(file_id, collection=qdrant_store.COL_CHUNK_ATOMS)` 추가(chunk_atoms 행은 file_chunks delete의 FK CASCADE로 함께 지워진다).
- embedding_batch 팬아웃 직후(마지막 `svc.update(jobs … done)` 전에), **figure와 동형의 독립 try/except**로:

```python
    # D129: 원자 질문 팬아웃 — 실패해도 텍스트 인덱싱을 막지 않는다(D88 동형).
    try:
        if app_settings.as_bool(overlay, "atom_rag_enabled", settings.atom_rag_enabled):
            asize = max(1, settings.atom_batch_size)
            atom_jobs = [
                {
                    "owner_id": f.get("owner_id"),
                    "kind": "atom_batch",
                    "target_id": file_id,
                    "parent_job_id": job["id"],
                    "batch_range": {"from_seq": start, "to_seq": min(start + asize, len(chunks))},
                    "status": "queued",
                    "space_ref": f.get("space_ref"),
                }
                for start in range(0, len(chunks), asize)
            ]
            await svc.insert("jobs", atom_jobs, returning=False)
            logger.info("원자 팬아웃 file=%s -> %d batches", file_id, len(atom_jobs))
    except Exception:  # noqa: BLE001 - D129: 원자화 실패 격리
        logger.exception("원자 팬아웃 실패 — 텍스트 인덱싱은 계속 file=%s", file_id)
```

**runner.py**: `_process`에 `elif job["kind"] == "atom_batch": await atoms._handle_atom_batch(svc, job)` 분기(+ `from . import atoms`). `requeue_file`의 textbook figure 재큐 블록 다음에 `atoms._requeue_atoms` 호출 합류(액션 문자열 `+atoms_requeued` 방식, `_requeue_figures`와 동형 — failed 행 pending 리셋 + 중복 잡 가드 + 전 범위 재팬아웃).

**jobs.py**: `_fail_file_for_job`에 `elif kind == "atom_batch":` 분기 — 범위 내 pending `chunk_atoms`만 failed(`chunk_seq` 컬럼 기준 `and=(chunk_seq.gte.N,chunk_seq.lt.M)`), files.status 불가침, `_finalize_file` 호출 금지(figure_batch 분기와 동형).

**Steps:**

- [ ] **Step 1: 실패 테스트 작성** — `tests/test_worker_atoms.py`. `tests/test_worker_figures.py`의 `_FakeService` 패턴을 복제(테이블별 핸들러 dict + 호출 기록). 필수 케이스:

```python
# 개요만 — _FakeService는 test_worker_figures.py의 것을 이 파일에 맞게 복제한다.
# monkeypatch 대상(모듈 한정 호출 규약):
#   atoms.solar.complete           → 고정 질문 텍스트 Completion 반환
#   atoms.embedding.embed_texts    → [[0.1]*4]*n (task_type 인자 assert: RETRIEVAL_DOCUMENT)
#   common._qdrant_upsert          → 호출 기록(컬렉션 인자 assert: chunk_atoms)
#   atoms.app_settings.get_overlay → 노브 주입

@pytest.mark.asyncio
async def test_정상_경로_생성_임베딩_적재():
    # pending 청크 2개 → solar 2회 → chunk_atoms insert(각 3질문) →
    # embed_texts 1회(6질문, RETRIEVAL_DOCUMENT) → _qdrant_upsert(collection=chunk_atoms,
    # 페이로드 4키 {atom_id, chunk_id, file_id, owner_id}) → 행 embedded → 잡 done
    ...

@pytest.mark.asyncio
async def test_킬스위치_off면_생성_없이_done():
    # atom_rag_enabled=false 오버레이 → solar 미호출, 잡 done
    ...

@pytest.mark.asyncio
async def test_이미_원자가_있는_청크는_스킵():
    # chunk_atoms에 기존 행 → 그 청크는 solar 미호출(행 단위 멱등)
    ...

@pytest.mark.asyncio
async def test_solar_개별_실패는_그_청크만_스킵():
    # 청크 2개 중 1개 실패 → 나머지는 정상 적재, files 테이블 update 없음(불가침)
    ...

@pytest.mark.asyncio
async def test_임베딩_실패는_행_failed_잡_failed_files_불가침():
    ...

@pytest.mark.asyncio
async def test_split_팬아웃_킬스위치():
    # split 경로: atom_rag_enabled=false → atom_batch 잡 0개 /
    # true → ceil(n/atom_batch_size)개, batch_range 정확성
    ...
```

- [ ] **Step 2: FAIL 확인** — `uv run pytest tests/test_worker_atoms.py -v`
- [ ] **Step 3: atoms.py 구현** (위 핵심 동작 1~6, figures.py 구조·주석 스타일을 따른다. 모듈 독스트링에 D116과 "files.status 불가침" 계약 명시)
- [ ] **Step 4: split.py·runner.py·jobs.py 배선** (위 수정 지점)
- [ ] **Step 5: PASS + 전체 스위트** — `uv run pytest tests/ -v` (기존 split·figure 테스트 무수정 그린 = 킬스위치 off 회귀 게이트)
- [ ] **Step 6: 커밋** — `[feat]: atom_batch 잡 — 청크당 예상 질문 생성·chunk_atoms 적재 (D129)`

---

### Task 6-4: rag.dual_search — 청크·원자 이중 검색

**Files:**
- Modify: `backend/app/services/rag.py`
- Test: `backend/tests/test_rag_dual_search.py`

**Interfaces:**
- Consumes: `qdrant_store.COL_CHUNK_ATOMS` (6-1), 기존 `qdrant_store.search(collection, vector, k, *, file_ids=…)`
- Produces:

```python
async def dual_search(
    client: UserClient, file_ids: list[str], query: str, k: int | None = None
) -> list[dict[str, Any]]
# 반환 shape: {file_id, chunk_id, seq, chunk_text, distance, via, atom_distance}
#   via: "chunk"(직접 히트) | "atom"(원자 경유). atom_distance는 via="atom"일 때만.
#   distance는 직접 히트면 청크 거리, 원자 경유면 청크 거리를 알 수 없어 None일 수
#   있다 — 게이트는 이미 여기서 끝났으므로 호출부는 재게이트하지 않는다.
```

**동작 (기존 `search()`는 무수정 — 레거시 경로 보존):**

1. 질의 임베딩 1회(`embedding.embed_texts([query], task_type="RETRIEVAL_QUERY")`).
2. `asyncio.gather`로 두 컬렉션 동시 검색: COL_FILE_CHUNKS(k=`rag_top_k`), COL_CHUNK_ATOMS(k=`atom_top_k` 오버레이).
3. **게이트 분리**: 직접 히트는 `class_material_rag_max_distance`(0.60), 원자 히트는 `atom_rag_max_distance`(0.45)를 **원자 거리**(1-score)에 적용. 원자 경유 청크에 청크 게이트를 재적용하지 않는다(D129 — "청크 벡터로는 멀지만 원자 질문으로는 정확한" 케이스가 원자화의 목적).
4. 원자 히트의 `payload["chunk_id"]`로 소스 청크 식별. 병합: 직접 히트(Qdrant 랭킹순) 먼저 → 원자 경유 청크 중 미포함분을 원자 거리순 append. chunk_id dedupe(직접 히트 우선). 총량 `rag_top_k + 3` 캡.
5. **Postgres USER 스코프 재조회 1회**(전 chunk_id 합집합, `status=eq.embedded` — 기존 search()와 동일 필터). 못 읽는 id 조용히 탈락.
6. 관측 로그: `logger.info("이중 검색: direct=%d atom_via=%d merged=%d", …)`.

**Steps:**

- [ ] **Step 1: 실패 테스트**:

```python
# tests/test_rag_dual_search.py — test_rag_class_scope.py의 _FakeClient·패치 패턴 복제.
# qdrant_store.search를 collection 인자에 따라 다른 히트를 주는 fake로 patch.

@pytest.mark.asyncio
async def test_직접_원자_병합_dedupe():
    # 직접 히트: chunk-1(0.5), chunk-2(0.55) / 원자 히트: atom-a(0.3, chunk_id=chunk-2),
    # atom-b(0.35, chunk_id=chunk-3)
    # → 병합: [chunk-1(via=chunk), chunk-2(via=chunk — 직접 우선), chunk-3(via=atom)]
    ...

@pytest.mark.asyncio
async def test_게이트_분리():
    # 직접 0.65(>0.60 탈락) / 원자 0.40(≤0.45 통과, 소스 chunk-9)
    # → chunk-9만, via=atom, atom_distance=0.40
    ...

@pytest.mark.asyncio
async def test_postgres_재조회는_1회():
    # _FakeClient.calls에서 file_chunks select가 정확히 1번인지
    ...

@pytest.mark.asyncio
async def test_질의_임베딩은_1회_RETRIEVAL_QUERY():
    ...

@pytest.mark.asyncio
async def test_rls_탈락은_조용히():
    # 원자 경유 chunk_id가 Postgres 재조회에 없음 → 결과에서 제외, 예외 없음
    ...
```

- [ ] **Step 2: FAIL 확인** → **Step 3: rag.py에 dual_search 구현** (search() 아래, 독스트링에 D129·게이트 분리 근거) → **Step 4: PASS + 전체 스위트**
- [ ] **Step 5: 커밋** — `[feat]: rag.dual_search — 청크·원자 이중 검색과 병합 게이트 (D129)`

---

### Task 6-5: 스킬 배선 + 파일 삭제 퍼지

**Files:**
- Modify: `backend/app/ai/skills/search_class_material.py`
- Modify: `backend/app/services/files.py` (delete_file의 Qdrant 퍼지)
- Test: `backend/tests/test_ai_skills_data.py` (기존 파일에 케이스 추가 — search_class_material 테스트가 있는 파일을 확인해 그곳에)

**Interfaces:**
- Consumes: `rag.dual_search` (6-4), `qdrant_store.COL_CHUNK_ATOMS` (6-1)

**Steps:**

- [ ] **Step 1: 실패 테스트** — 스킬이 `atom_rag_enabled` on이면 `rag.dual_search`, off면 `rag.search`를 부르는지(monkeypatch로 양쪽을 기록 fake로 대체). **off일 때 기존 거리 게이트 동작 불변**(기존 테스트 그대로 통과).
- [ ] **Step 2: FAIL 확인**
- [ ] **Step 3: 스킬 수정** — `run()`의 검색 지점:

```python
        use_atoms = app_settings.as_bool(
            overlay, "atom_rag_enabled", settings.atom_rag_enabled
        )
        if use_atoms:
            # D129: 이중 검색은 게이트(직접 0.60/원자 0.45)를 내부에서 끝냈다 —
            # 여기서 재게이트하면 원자 경유 청크(distance=None)가 다 죽는다.
            chunks = await rag.dual_search(ctx.client, file_ids, query)
        else:
            chunks = await rag.search(ctx.client, file_ids, query)
            chunks = [
                c for c in chunks
                if c.get("distance") is not None and c["distance"] <= max_dist
            ]
```
(기존 게이트 리스트 컴프리헨션을 else 분기 안으로 이동. items·sources 조립은 공통 — `distance`가 None인 원자 경유 항목은 `round()` 전에 `c.get("distance")` None 가드 추가.)

- [ ] **Step 4: files.py delete_file** — 기존 `COL_TEXTBOOK_FIGURES` 퍼지 호출과 동형으로 `COL_CHUNK_ATOMS` 한 줄 추가(파일에서 textbook_figures Qdrant 정리 지점을 찾아 바로 아래).
- [ ] **Step 5: PASS + 전체 스위트** → **Step 6: 커밋** — `[feat]: 자료 검색 스킬 이중 검색 배선 + 삭제 시 원자 퍼지 (D129)`

---

### Task 6-6: 단계 C — 분해 지침 + 질문 정제

**Files:**
- Modify: `backend/app/ai/orchestrator.py` (`_DECIDE_SYSTEM`)
- Modify: `backend/app/ai/skills/search_class_material.py` (`_refine_query`)
- Test: `backend/tests/test_ai_skills_data.py` 확장 (정제 on/off/실패 폴백)

**Interfaces:**
- Consumes: `solar.complete`, config `rag_query_rewrite_enabled` (6-1)

**Steps:**

- [ ] **Step 1: 실패 테스트** — ① `rag_query_rewrite_enabled=true` + `solar.complete` fake(정제문 반환) → 검색 fake에 정제문이 전달됨 ② off → 원문 그대로 ③ solar 예외 → 원문 그대로(예외 삼킴) ④ 정제 결과가 빈 문자열 → 원문 유지.
- [ ] **Step 2: FAIL 확인**
- [ ] **Step 3: `_refine_query` 구현** (search_class_material.py 모듈 함수):

```python
async def _refine_query(query: str) -> str:
    """D130: 검색어 정제 — 지시대명사·구어체 잔재를 풀어낸 자연어 의문문으로.

    best-effort: 실패·빈 응답이면 원문 그대로. **키워드화 금지** — embedding-query는
    자연어 질문으로 학습돼 있어 줄일수록 거리가 나빠진다(위 parameters 실측 주석).
    """
    try:
        completion = await solar.complete(
            [
                {"role": "system", "content": (
                    "학생 질문을 검색용으로 정제한다. 지시대명사('그것/이거')를 "
                    "구체적 명사로 바꾸고 오탈자를 고치되, **완전한 자연어 의문문 "
                    "형태를 유지**하라. 키워드 나열로 줄이지 마라. 이미 명확하면 "
                    "그대로 돌려줘라. 정제된 질문 한 문장만 출력하라."
                )},
                {"role": "user", "content": query},
            ],
            max_tokens=128,
        )
        refined = (completion.message.get("content") or "").strip()
        return refined or query
    except Exception:  # noqa: BLE001 - 정제 실패가 검색을 막지 않는다
        logger.warning("검색어 정제 실패 — 원문으로 검색", exc_info=True)
        return query
```
`run()`의 검색 직전에: `if app_settings.as_bool(overlay, "rag_query_rewrite_enabled", settings.rag_query_rewrite_enabled): query = await _refine_query(query)` (+ `from ...services import solar` 임포트).

- [ ] **Step 4: `_DECIDE_SYSTEM` 지침 추가** — 기존 불릿 다음에 두 줄:

```
- 여러 개념을 묻는 복합 질문(비교·차이·원인과 결과 등)은 **서브질문으로 나눠 각각 검색**하라.
- 검색 결과가 질문의 일부만 덮으면, 부족한 부분을 다른 검색어로 다시 찾아라.
```
(`react_max_steps`는 코드 변경 없음 — 기본 3 유지, admin 오버레이 실험 영역.)

- [ ] **Step 5: PASS + 전체 스위트** → **Step 6: 커밋** — `[feat]: ReAct 분해 지침 + 검색어 정제 노브 (D130)`

---

### Task 6-7: figure_caption.py — 비전 캡션 생성 (순수부 + 호출부)

**Files:**
- Create: `backend/app/services/figure_caption.py`
- Test: `backend/tests/test_figure_caption.py`

**Interfaces:**
- Consumes: `figure_judge.image_data_uri`·`figure_judge.is_configured`·judge_* 설정(같은 엔드포인트), `common.touch_job` 시그니처(하트비트 콜백)
- Produces:

```python
def build_caption_messages(page_text: str, parsed_caption: str, alt: str,
                           image_data_uri: str) -> list[dict]
def parse_caption(content: str) -> str          # 공백 정규화 + 500자 캡, 실패 시 ""
async def caption_all(items: list[dict], *, concurrency: int,
                      heartbeat: Callable[[], Awaitable[None]] | None = None
                      ) -> list[str | None]
# items[i] = {"image_bytes": bytes, "ext": str, "page_text": str,
#             "parsed_caption": str, "alt": str}
# 반환: items 순서 그대로, 실패는 None(호출부가 폴백/failed 처리).
```

**Steps:**

- [ ] **Step 1: 실패 테스트**:

```python
# tests/test_figure_caption.py — test_figure_judge 패턴.
def test_build_caption_messages_페이지_컨텍스트_포함():
    msgs = figure_caption.build_caption_messages(
        "가야 토기는 회청색이다.", "그림 3 가야 토기", "토기 사진", "data:image/png;base64,xx"
    )
    assert msgs[0]["role"] == "user"
    parts = msgs[0]["content"]
    assert parts[0]["type"] == "image_url"
    text = parts[1]["text"]
    assert "가야 토기는 회청색" in text          # 페이지 본문
    assert "그림 3 가야 토기" in text            # parsed 캡션(고유명사 보존 지시)
    assert "지어내" in text                      # 환각 금지 지시

def test_parse_caption_정규화_절단():
    assert figure_caption.parse_caption("  가야   토기\t사진  ") == "가야 토기 사진"
    assert len(figure_caption.parse_caption("가" * 900)) == 500

@pytest.mark.asyncio
async def test_caption_all_회로차단(monkeypatch):
    # _call_caption을 항상 예외로 patch → 연속 5회 실패 후 잔여 None(호출 수 5회)
    ...

@pytest.mark.asyncio
async def test_caption_all_하트비트_호출(monkeypatch):
    ...
```

- [ ] **Step 2: FAIL 확인**
- [ ] **Step 3: 구현** — figure_judge.py와 동형 구조(JUDGE_TIMEOUT·회로차단 5·재시도 1회 재사용, judge_base_url/judge_model/judge_api_key로 호출). 프롬프트:

```python
def build_caption_messages(page_text, parsed_caption, alt, image_data_uri):
    """D131: 캡션 '생성' — D93/D103의 후보 '선택'을 대체한다. 페이지 본문 용어를
    흡수해 검색력을 높이되, parsed 캡션의 고유명사를 보존하고 지어내기를 금지한다."""
    hints = []
    if parsed_caption:
        hints.append(f"파서가 찾은 원문 캡션: {parsed_caption}")
    if alt:
        hints.append(f"대체 텍스트: {alt}")
    hint_block = ("\n".join(hints) + "\n") if hints else ""
    prompt = (
        "당신은 교과서 편집자다. 위 이미지는 교과서 페이지에서 잘라낸 그림이고,\n"
        "아래는 그 페이지의 본문 텍스트다.\n"
        f"{hint_block}"
        "본문의 용어를 사용해 이 그림을 설명하는 **검색용 캡션을 한국어 1~2문장**으로 써라.\n"
        "원문 캡션이 있으면 그 고유명사(작품명·인물명·소장처)를 그대로 보존하라.\n"
        "그림에 없는 내용을 지어내지 마라. 캡션 문장만 출력하라.\n\n"
        f"페이지 본문:\n{page_text}"
    )
    return [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": image_data_uri}},
        {"type": "text", "text": prompt},
    ]}]
```
`caption_all`은 `figure_judge.judge_all`을 복제해 판정 파싱 대신 `parse_caption`을 쓰고, 각 항목 완료 시 `heartbeat`가 있으면 await. 빈 캡션(파싱 후 "")은 None과 동일 취급.

- [ ] **Step 4: PASS** → **Step 5: 커밋** — `[feat]: figure 캡션 비전 생성 클라이언트 (D131)`

---

### Task 6-8: figure 워커 — 캡션 확정 경로 교체 + 페이지 텍스트

**Files:**
- Modify: `backend/app/services/figure_extract.py` (`page_texts` 신설, `extract_figures` 레코드에 `page_text` — 아님, 아래 참고)
- Modify: `backend/app/services/worker/split.py` (`_fanout_figures` rows에 page_text)
- Modify: `backend/app/services/worker/figures.py` (`_handle_figure_batch` 캡션 확정 분기)
- Test: `backend/tests/test_figure_extract.py`·`backend/tests/test_worker_figures.py` 확장

**Interfaces:**
- Consumes: `figure_caption.caption_all`/`build_caption_messages` (6-7), `textbook_figures.page_text` 컬럼 (6-1), `common.touch_job` (6-1)
- Produces: `figure_extract.page_texts(elements: list[dict], max_chars: int = 4000) -> dict[int, str]`

**동작:**

- `page_texts`: 페이지별로 figure 카테고리 제외 요소의 `element_text`를 순서대로 이어붙여 `" ".join(text.split())` 정규화 후 max_chars 절단(탭이 비전 모델 reasoning 폭주 유발 — figure_judge `_clean` 실측과 동일 근거). **`extract_figures` 레코드 shape은 건드리지 않는다**(계약 고정 주석) — page_text는 `_fanout_figures`가 `page_texts()` 결과에서 `r["page"]`로 얻어 rows에만 싣는다.
- `_fanout_figures`: `page_map = figure_extract.page_texts(elements, settings.figure_page_text_max_chars)` 계산 후 rows에 `"page_text": page_map.get(r["page"], "")` 추가.
- `_handle_figure_batch`: select에 `page_text` 컬럼 추가. **분기**:
  - `figure_caption_generate_enabled` off → **기존 코드 그대로**(D103 2단 — 이 블록은 이동 없이 보존).
  - on → parsed/판정 분류 대신 **전 행을 생성 대상으로**: `figure_judge.is_configured()` 확인(미설정이면 전 행 `match_kind='no-caption'` failed — 기존 미설정 처리와 동형), 이미지 다운로드 후 `figure_caption.caption_all(items, concurrency=…, heartbeat=lambda: common.touch_job(svc, job["id"]))`. 행별:
    - 캡션 성공 → `to_embed` append, patch `{"selected_index": None, "judge_reason": None, "match_kind": "generated", "embed_text": 캡션}`
    - 실패 + `row["caption"]`(parsed) 존재 → patch `match_kind: "parsed"`, embed_text=parsed (D131 폴백)
    - 실패 + parsed 없음 → 행 failed `match_kind='caption-error'`
  - 이후 임베딩→Qdrant→`_mark`는 기존 코드 공용(무수정).
- 모듈 독스트링 갱신: D131 결정(생성 일원화, parsed는 프롬프트 입력·폴백으로 격하) 명시.

**Steps:**

- [ ] **Step 1: 실패 테스트** — ① `page_texts` 페이지 분리·figure 제외·절단·공백 정규화 ② `_fanout_figures` rows에 page_text 포함 ③ 노브 on: `match_kind='generated'`·embed_text=생성 캡션·하트비트 호출 ④ 생성 실패+parsed 존재 → parsed 폴백 ⑤ 생성 실패+parsed 없음 → `caption-error` failed ⑥ **노브 off: 기존 test_worker_figures 전체가 무수정 그린**.
- [ ] **Step 2: FAIL 확인** → **Step 3: 구현** → **Step 4: PASS + 전체 스위트**
- [ ] **Step 5: 커밋** — `[feat]: figure 캡션 비전 생성 경로 — 페이지 텍스트 영속·parsed 폴백 (D131)`

---

### Task 6-9: semantic_chunker.py — LLM 경계 재조정 (순수부 + 호출부)

**Files:**
- Create: `backend/app/services/semantic_chunker.py`
- Test: `backend/tests/test_semantic_chunker.py`

**Interfaces:**
- Consumes: `embedding.chunk_text`, `solar.complete`, config `semantic_chunking_max_llm_calls`
- Produces:

```python
async def chunk_text_semantic(
    text: str, size: int, overlap: int,
    *, heartbeat: Callable[[], Awaitable[None]] | None = None,
) -> list[str]
def build_resplit_messages(lined_text: str, max_line: int) -> list[dict]
def parse_endline(content: str, max_line: int) -> int | None
```

**알고리즘 (PIKE LLMPoweredRecursiveSplitter resplit 이식, 요약 전파는 v1 생략):**

1. `base = embedding.chunk_text(text, size, 0)` — **내부 1차 분할은 오버랩 0**: 인접 청크를 이어붙여 창을 만들 때 오버랩이 있으면 텍스트가 중복된다. 의미 경계가 오버랩의 목적을 대체한다(호출부가 넘긴 overlap 인자는 폴백 경로에서만 쓴다).
2. `len(base) < 2`면 그대로 반환.
3. 루프: `window = (remainder + base[idx] + base[idx+1])`을 줄 단위로 번호 매겨(`1: …`) `build_resplit_messages`로 solar에 "의미가 끊기는 가장 적절한 줄 번호"를 `{"endline": N}` JSON으로 질의(max_tokens=128). 유효하면 `lines[:N]`을 확정 청크로, `lines[N:]`을 remainder로 넘기고 idx += 2. `parse_endline`이 None(깨진 JSON·범위 밖)이면 그 경계만 정규식 유지(`base[idx]` 확정, idx += 1)하고 연속 실패 카운트 증가.
4. 가드: 총 콜 수 `semantic_chunking_max_llm_calls` 도달 또는 연속 5회 파싱 실패(회로차단) → 잔여는 정규식 경계 그대로 확정. **10콜마다 heartbeat await**.
5. `parse_endline`: `json.loads` → 실패 시 `re.search(r'"endline"\s*:\s*(\d+)')` salvage(figure_judge `_SALVAGE_RE` 패턴) → `1 <= N <= max_line` 검증, 밖이면 None.
6. 어떤 예외든 함수 밖으로 내보내지 않는다 — 호출부(split.py, 6-10)가 전체를 try/except로 감싸 `embedding.chunk_text(text, size, overlap)` 폴백하지만, 여기서도 solar 예외는 해당 경계 정규식 유지로 강등한다.

**Steps:**

- [ ] **Step 1: 실패 테스트** — ① 정상 endline(fake solar가 `{"endline": 3}` 반환) → 경계가 3행에서 갈림 ② 깨진 JSON + salvage 가능 → 복구 ③ salvage 불가 → 해당 경계 정규식 유지 ④ solar 예외 → 정규식 유지(전체 결과는 base와 동일) ⑤ 연속 5회 실패 → 이후 solar 미호출(호출 횟수 assert) ⑥ max_llm_calls 도달 → 잔여 미호출 ⑦ heartbeat 10콜마다 ⑧ 청크 수 1개면 solar 미호출 ⑨ **전 청크 이어붙이면 원문과 동일**(텍스트 유실·중복 없음 — `"".join` 비교는 공백 정규화 후).
- [ ] **Step 2: FAIL 확인** → **Step 3: 구현**(모듈 독스트링에 D132·PIKE 이식·v1 요약 생략 근거) → **Step 4: PASS**
- [ ] **Step 5: 커밋** — `[feat]: LLM 의미 청킹 — resplit 경계 재조정 (D132)`

---

### Task 6-10: split.py 의미 청킹 분기

**Files:**
- Modify: `backend/app/services/worker/split.py` (청킹 지점 — `chunks = embedding.chunk_text(...)` 행)
- Test: `backend/tests/test_worker_semantic_split.py` (신규 — 기존 split 테스트 파일 패턴)

**Interfaces:**
- Consumes: `semantic_chunker.chunk_text_semantic` (6-9), `common.touch_job` (6-1), config·오버레이 노브 (6-1)

**Steps:**

- [ ] **Step 1: 실패 테스트** — ① 노브 on + 소형 문서 → `semantic_chunker.chunk_text_semantic` 호출(monkeypatch 기록) ② 노브 off → 미호출·`embedding.chunk_text` 결과 그대로 ③ user_upload → 미호출 ④ `len(text) > semantic_chunking_max_chars` → 미호출 ⑤ semantic 예외 → 정규식 폴백으로 청크 산출(파일 failed 아님).
- [ ] **Step 2: FAIL 확인**
- [ ] **Step 3: 구현** — 청킹 지점 교체:

```python
    chunks: list[str] = []
    sem_on = app_settings.as_bool(
        overlay, "semantic_chunking_enabled", settings.semantic_chunking_enabled
    )
    sem_max = app_settings.as_int(
        overlay, "semantic_chunking_max_chars",
        settings.semantic_chunking_max_chars, 10_000, 500_000,
    )
    if sem_on and not is_session_upload and len(text) <= sem_max:
        # D132: LLM 의미 청킹 — 어떤 실패든 정규식 폴백(인덱싱 불가침).
        try:
            chunks = await semantic_chunker.chunk_text_semantic(
                text, chunk_size, chunk_overlap,
                heartbeat=lambda: common.touch_job(svc, job["id"]),
            )
        except Exception:  # noqa: BLE001
            logger.exception("의미 청킹 실패 — 정규식 폴백 file=%s", file_id)
            chunks = []
    if not chunks:
        chunks = embedding.chunk_text(text, chunk_size, chunk_overlap)
```
(`is_session_upload`·`chunk_size`·`chunk_overlap` 계산을 이 블록 앞으로 끌어올린다. `from .. import semantic_chunker` 추가.)

- [ ] **Step 4: PASS + 전체 스위트**(기존 split 테스트 무수정 그린 — off 회귀 게이트)
- [ ] **Step 5: 커밋** — `[feat]: split 의미 청킹 분기 — 크기 가드·정규식 폴백 (D132)`

---

### Task 6-11: 마무리 (Manager)

- [ ] 전체 스위트 그린 + `cd frontend && npx tsc --noEmit && npm run build`(프론트 무변경 확인용 스모크)
- [ ] E2E(시드 계정, README 로컬 실행): ① `atom_rag_enabled` on → 교사 자료 업로드 → `chunk_atoms` 행·Qdrant 포인트 확인 → 학생 복합 질문("A와 B의 차이") → turn_log `skill_traces`에서 다중 검색·via=atom 히트 관측 ② `figure_caption_generate_enabled` on(judge_* 설정 시) → 교과서 업로드 → `match_kind='generated'` 확인 ③ `semantic_chunking_enabled` on → 소형 문서 업로드 → 청크 경계 확인 ④ 전 노브 off → 현행과 동일 동작 회귀 확인
- [ ] CLAUDE.md 갱신: 핵심 파이프라인 절에 D129~D133 반영(원자화·이중 검색·캡션 생성·의미 청킹·하트비트), "비전 판정 미구현" 서술 현행화
- [ ] TASKS.md TASK 6 체크박스·완료 기록, 원장(.superpowers/sdd/progress.md) 마감
- [ ] 마이그레이션 원격 적용은 **사용자 승인 요청**(배포 게이트 — 여기서만 묻는다)

## Self-Review 결과

- 스펙 §3(A) → 6-1~6-5, §4(C) → 6-6, §5(D) → 6-1·6-7·6-8, §6(B) → 6-9·6-10, §7 검증 → 각 task Step + 6-11, §8 배포 → 6-1 마이그레이션·6-11 승인 게이트. 커버리지 공백 없음.
- 타입 일관성: `dual_search` 반환 shape(6-4 정의)를 6-5가 소비, `caption_all` items shape(6-7)를 6-8이 공급, `chunk_text_semantic` 시그니처(6-9)를 6-10이 호출 — 명칭 일치 확인.
- 03_app_settings 시드 목록의 표기 오류(semantic_chunking_enabled)는 본문에 'false'로 명시했다 — 구현자는 `('semantic_chunking_enabled', 'false')`로 쓴다.
