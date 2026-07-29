# PIKE-RAG 기법의 Nodi 적용 — 설계 (TASK 6)

- 상태: **사용자 승인 완료** (2026-07-29, plan 게이트 — PROCESS.md 0단계 스펙 승인)
- 참조 구현: `~/Desktop/ai-rookie/PIKE-RAG` (Microsoft, ICML 2025 — 한국어 교과서
  벤치마크 커스텀 `examples/textbook/` 포함)
- D-번호: **D116**(원자화 이중 검색) · **D117**(질문 정제·분해 지침) ·
  **D118**(figure 캡션 비전 생성) · **D119**(LLM 의미 청킹) · **D120**(잡 하트비트)

## 1. 목표와 범위

PIKE-RAG의 검색 품질 기법 4종을 Nodi RAG 파이프라인에 이식한다. 사용자 확정:

| 단계 | 기법 | 요지 |
|---|---|---|
| A (D116) | 지식 원자화 + 이중 검색 | 청크마다 solar-pro2로 예상 질문 생성 → 별도 Qdrant 컬렉션 → 검색 시 청크·원자 이중 검색 후 소스 청크 회수 |
| C (D117) | 태스크 분해 강화 | ReAct 오케스트레이터 유지, 판단 프롬프트에 서브질문 분해 지침 + 스킬 내부 질문 정제(기본 off) |
| D (D118) | figure 캡션 비전 생성 | 비전 모델(judge_* 노브)이 페이지 텍스트를 컨텍스트로 캡션을 **생성** — D93/D103 후보 선택 방식 대체 |
| B (D119) | LLM 의미 청킹 | PIKE resplit 이식 — LLM이 청크 경계를 의미론적으로 재조정 |

- 인제스트 LLM: **solar-pro2 재사용**. 비전: **judge_* 노브**(OpenAI 호환, 기본 EXAONE 계열).
- 구현 순서: **A → C → D → B** (D는 A와 병행 가능). 각 단계는 독립 롤백 가능.

## 2. 공통 원칙

- **킬스위치 기본 off 출하**: `atom_rag_enabled` · `rag_query_rewrite_enabled` ·
  `figure_caption_generate_enabled` · `semantic_chunking_enabled` 전부 기본 off.
  off = 기존 경로 완전 보존(킬스위치가 곧 롤백 수단). 캘리브레이션 후 개별 on.
- **실패 폴백 계약**: 원자화 실패 → 청크 인덱싱 무영향(D88 격리 패턴 동형).
  LLM 청킹 실패 → 정규식 청킹(`embedding.chunk_text`) 폴백. 캡션 생성 실패 →
  parsed 캡션 폴백, 둘 다 없으면 failed. **채팅·텍스트 인덱싱 불가침.**
- **불변식 유지**: Qdrant 페이로드는 식별자만 + Postgres USER 스코프 재조회(RLS),
  임베딩 비대칭(질의 `embedding-query`/문서 `embedding-passage`), `distance = 1 - score`.
- 새 노브는 `config.py` + 오버레이 clamp + `db/03_app_settings.sql` 시드(admin 콘솔 노출).
- **D120 — 잡 하트비트**: 장기 잡(LLM 다회 호출)의 스테일 복구(120초) 오탐 방지를 위해
  `worker/common.py::touch_job(svc, job_id)`(jobs.updated_at 전진)를 신설, A·B·D 공용.
  `embedding_stale_seconds` 상향은 하지 않는다(진짜 크래시 복구 지연 방지).

## 3. 단계 A — 지식 원자화 (D116)

### 인제스트

- `worker/split.py::_handle_split`: file_chunks insert 직후 `atom_batch` 잡 팬아웃
  (figure와 동형 try/except 격리, 킬스위치 off면 생략). 멱등 정리에 `COL_CHUNK_ATOMS`
  포인트 삭제 추가.
- 신규 `worker/atoms.py::_handle_atom_batch(svc, job)`: batch_range의 청크 조회 →
  청크당 solar-pro2로 원자 질문 생성 → `chunk_atoms` insert → **embedding-passage**
  임베딩 → Qdrant `COL_CHUNK_ATOMS` 업서트(페이로드 `{atom_id, chunk_id, file_id,
  owner_id}` — 질문 본문 미포함) → 행 embedded. `runner.py` 분기·`jobs.py`
  `_fail_file_for_job` atom 분기(files.status 불가침) 추가. requeue 경로에
  `_requeue_atoms` 추가.
- 신규 `services/atomize.py`(순수부): `build_atom_messages(chunk_text, n)` —
  PIKE `examples/textbook/atom_prompt_ko.py` 한국어 프롬프트 이식("이 청크로 답할 수
  있는 질문을 대명사 없이 개체명 포함, 최대 n개") / `parse_atom_questions(content,
  max_n)` — 줄 단위 파싱, 번호·빈 줄 정리, 상한 절단.

**원자 임베딩이 passage인 근거**: 원자는 "저장되는 문서"다. Upstage 비대칭 쌍은
query↔passage 정렬로 학습되어 있어 원자를 query로 임베딩하면 불변식이 깨지고
query↔query 유사도는 최적화 지표가 아니다. 짧은 질문형 passage는 질문형 query와
장문 청크보다 훨씬 가깝게 매칭되므로 PIKE의 질문↔질문 이득을 동일하게 얻는다.

### 스키마

`db/migrations/2026-07-29-pike-a-chunk-atoms.sql` + `01_schema.sql` 동기화
(**원격 적용은 사용자 승인 게이트**):

```sql
CREATE TABLE public.chunk_atoms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id uuid NOT NULL REFERENCES public.file_chunks(id) ON DELETE CASCADE,
    file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    chunk_seq integer NOT NULL,
    question text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','embedded','failed')),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chunk_atoms_file ON public.chunk_atoms (file_id, status);
CREATE INDEX idx_chunk_atoms_chunk ON public.chunk_atoms (chunk_id);
ALTER TABLE public.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK
  ((kind = ANY (ARRAY['embedding_split','embedding_batch','figure_batch','atom_batch'])));
```

RLS: 쓰기는 워커(BYPASSRLS) 전용. 검색은 본문을 file_chunks에서 재조회하므로 사용자
정책 필수는 아니나, 관측성(매칭된 원자 질문 표시)을 위해 file_chunks와 동형 SELECT
정책(부모 파일 접근 가능 시 열람)을 추가한다.

### 검색

`rag.py`에 `dual_search(client, file_ids, query, k=None)` 신설(기존 `search()` 시그니처
불변 — 레거시 경로 무영향):

1. 질의 임베딩 1회(embedding-query, 두 컬렉션 공용).
2. `COL_FILE_CHUNKS`·`COL_CHUNK_ATOMS` gather 동시 검색(file_ids 페이로드 필터).
3. **거리 게이트 경로별 분리**: 직접 청크 히트 = `class_material_rag_max_distance`(0.60),
   원자 히트 = `atom_rag_max_distance`(0.45)를 **원자 거리에** 적용. 원자 경유 소스
   청크에 청크 게이트 재적용 금지 — "청크 벡터로는 멀지만 원자 질문으로는 정확한"
   케이스를 살리는 것이 원자화의 목적.
4. 병합: 직접 히트(Qdrant 랭킹순) 먼저 → 원자 경유 청크 중 미포함분을 원자 거리순
   append, chunk_id dedupe(직접 히트 우선), 총량 `rag_top_k + 3` 캡.
5. Postgres USER 스코프 재조회 **1회**(RLS 재검증, 못 읽는 id 조용히 탈락).
6. 반환 shape 확장: `{..., "via": "chunk"|"atom", "atom_distance": float|None}`.

`ai/skills/search_class_material.py`: `atom_rag_enabled` on이면 `dual_search` 사용.
`services/files.py::delete_file`: `COL_CHUNK_ATOMS` 퍼지 추가.

### 노브 (A)

| 키 | 기본 | clamp | 역할 |
|---|---|---|---|
| `atom_rag_enabled` | false | — | 킬스위치(팬아웃·검색 동시 게이트) |
| `atom_questions_per_chunk` | 3 | 1~8 | 청크당 질문 수(비용 직결) |
| `atom_top_k` | 5 | 1~20 | 원자 컬렉션 top-K |
| `atom_rag_max_distance` | 0.45 | 0.1~0.9 | 원자 거리 게이트(질문↔질문은 청크보다 가까움, 실측 후 조정) |
| `atom_gen_concurrency` | 4 | 1~16 | solar 동시 호출 |
| `atom_batch_size` | 16 | config 전용 | 팬아웃 단위(16×~1.5s/동시4 ≈ 10초 — 스테일 여유) |

## 4. 단계 C — 태스크 분해 강화 (D117)

- `ai/orchestrator.py::_DECIDE_SYSTEM` 지침 추가: "여러 개념을 묻는 복합 질문(비교·
  차이·원인+결과 등)은 서브질문으로 나눠 각각 검색하라. 검색 결과가 질문의 일부만
  덮으면 부족한 부분을 다른 검색어로 다시 찾아라."
- `search_class_material`에 `_refine_query(query)` — solar 1콜 best-effort 정제,
  실패·off 시 원문 그대로. 노브 `rag_query_rewrite_enabled` **기본 off**: 판단 단계가
  이미 대화 맥락으로 검색어를 구성하고 정제는 턴당 +0.8s. 정제 프롬프트는 자연어
  의문문 형태 유지 강제(키워드화 금지 — 키워드화는 embedding-query 거리 악화 실측).
- `react_max_steps` 코드 변경 없음 — 기본 3 유지, 배포 후 admin 오버레이로 4~5 실험.
  스텝당 ~1.5–2.5s이나 상한은 천장일 뿐(단순 질문은 도구 미호출로 즉시 생성 단계행).
  turn_log의 `llm_calls`·`skill_traces`로 관측 후 시드 상향 여부 결정.

## 5. 단계 D — figure 캡션 비전 생성 (D118)

D93("추측하지 않는다")·D103(파서 라벨 우선 2단)을 **생성 일원화로 대체**하되, parsed
캡션을 (a) 생성 프롬프트 입력으로 넣어 고유명사를 보존하고 (b) 생성 실패 시 폴백으로
유지해 독트린 손실을 최소화한다. `worker/figures.py` 독스트링에 결정을 명시한다.

- 신규 `services/figure_caption.py`(figure_judge와 동형 — 재시도·회로차단·
  `is_configured()` 재사용): `build_caption_messages(page_text, parsed_caption, alt,
  image_data_uri)` — "교과서 p.N 그림, 페이지 본문 용어를 사용해 검색용 캡션 1~2문장
  한국어, parsed 캡션의 고유명사 보존, 그림에 없는 내용 지어내기 금지" /
  `parse_caption(content)` — 평문 정규화·500자 캡 / `caption_all(items, concurrency,
  heartbeat)` — judge_all 동형 + touch_job 하트비트.
- **페이지 텍스트**: `figure_extract.py::page_texts(elements, max_chars=4000)` 신설
  (전역 1-base `page` 기준, figure 카테고리 제외) → split 시점에
  `textbook_figures.page_text` 컬럼으로 영속(requeue 재판정 시 재파싱 불필요).
  마이그레이션: `ALTER TABLE public.textbook_figures ADD COLUMN page_text text NOT NULL DEFAULT ''`.
- `worker/figures.py::_handle_figure_batch` 캡션 확정 교체:
  - 노브 **on**: 전 pending 행 비전 생성 → `match_kind='generated'`, embed_text=생성
    캡션. 실패 행은 parsed 캡션 폴백(`match_kind='parsed'`), 둘 다 없으면 failed.
  - 노브 **off**: 현행 D103 경로 코드 보존(회귀 게이트 = 기존 테스트 무수정 그린).
- 검색 툴(`search_textbook_figure`)·`figure_search.py`·Qdrant 컬렉션 무변경.
- 노브: `figure_caption_generate_enabled`(false, 킬스위치),
  `figure_page_text_max_chars`(4000, config 전용). 동시성은 `figure_judge_concurrency`
  재사용. 비용: figure당 비전 1콜 — 현행 판정과 동수(parsed 행만 순증).

## 6. 단계 B — LLM 의미 청킹 (D119)

- 신규 `services/semantic_chunker.py::chunk_text_semantic(text, size, overlap, *,
  heartbeat=None)`: ① `embedding.chunk_text` 1차 분할(베이스이자 폴백) ② PIKE resplit
  이식 — 앞 두 청크를 합쳐 라인 번호를 매기고 solar에 `{"endline": N}` JSON으로
  경계를 물어 확정, 잔여 재분할 반복(순차 — 확정 경계가 다음 입력을 정의하므로
  병렬화 불가). 요약 전파는 v1 생략(비용 절반). 보조: `build_resplit_messages`,
  `parse_endline`(깨진 JSON → None → 해당 경계만 정규식 폴백).
- `worker/split.py` 분기: 노브 on + user_upload 아님 + `semantic_chunking_max_chars`
  이하일 때만. 전체 try/except — 어떤 실패든 정규식 폴백. 하트비트 10콜마다
  `touch_job`. 연속 5회 파싱 실패 시 회로차단(figure_judge CIRCUIT_BREAK 패턴)
  → 잔여 정규식.
- 노브: `semantic_chunking_enabled`(false), `semantic_chunking_max_chars`(120K,
  clamp 10K~500K — 500MB급 문서 폭주 1차 가드), `semantic_chunking_max_llm_calls`
  (120, config 전용 — 2차 가드, 도달 시 잔여 정규식 경계 유지). 스키마 변경 없음.

## 7. 테스트·검증

- 단위(기존 mock 패턴 — monkeypatch: `solar.complete`·`embedding.embed_texts`·
  `qdrant_store.search`·`get_overlay` + `_FakeClient`/`_FakeService`, 워커 모듈 한정
  호출 규약): 신규 `test_atomize.py` / `test_worker_atoms.py`(킬스위치 off 팬아웃 0,
  solar 실패 시 files.status 불변, 멱등 스킵, 페이로드 shape) /
  `test_rag_dual_search.py`(dedupe·게이트 분리·랭킹·재조회 1회) /
  `test_semantic_chunker.py`(폴백 3종·하트비트·max_chars 무호출) /
  `test_figure_caption.py`(메시지 구성·절단·회로차단). 기존 `test_worker_figures.py`
  확장 — **노브 off 시 기존 테스트 무수정 그린**이 각 단계의 회귀 게이트.
- 전체 스위트: `cd backend && uv run pytest tests/ -v` 그린. 프론트 무변경.
- E2E(마무리 단계, 시드 계정): 교사 업로드 → chunk_atoms 적재 → 학생 복합 질문 →
  skill_traces에서 다중 검색·via=atom 히트 관측 → 교과서 업로드 →
  match_kind='generated' → figure 검색 히트. 킬스위치 off 회귀 확인.

## 8. 배포 메모

- 마이그레이션 2건(chunk_atoms+jobs_kind_check, textbook_figures.page_text)은
  날짜별 `db/migrations/` + `01_schema.sql` 동기화. **원격 적용은 사용자 승인 후.**
- Qdrant `chunk_atoms` 컬렉션은 백엔드 재기동 시 `ensure_collections()`가 생성.
- 기존 파일 소급은 new-only — 재업로드 또는 admin requeue로만.
- 캘리브레이션 순서: 각 노브를 admin 콘솔에서 개별 on → turn_log·거리 분포 관측 →
  `atom_rag_max_distance` 실측 조정 → 기본값 시드 갱신 여부 결정.
