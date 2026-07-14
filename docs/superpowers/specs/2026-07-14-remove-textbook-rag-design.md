# 교과서 전역 코퍼스(RAG) 완전 제거 — 설계 (TASK 1)

- 날짜: 2026-07-14
- 상태: 승인 (사용자 무개입 지시에 따라 Manager 자율 승인 — 근거는 원장 기록)
- 관련: `docs/TASKS.md` TASK 1, 폐기 대상 스펙 `2026-07-13-textbook-rag-design.md`

## 배경·목적

admin 개발자가 `backend/textbooks/` + `scripts/ingest_textbook.py`로 구축하는
전역 교과서 RAG(Qdrant `textbook` 컬렉션, 2026-07-13 구축)는 제품 방향이
"교과서도 선생님이 워크스페이스에 업로드"(TASK 2)로 바뀌며 불필요해졌다.
채팅 턴에서 교과서 전역 코퍼스 검색이 일어나지 않도록 관련 코드를 정리한다.

## 결정: 완전 제거 (vs 플래그 오프 보존)

**완전 제거를 채택한다.** 근거:

1. TASK 1 완료 기준이 "남는 죽은 코드가 없다"를 명시 — 플래그 오프 보존은
   죽은 코드(빌더·컬렉션·노브·인제스트 스크립트)를 남겨 기준과 모순된다.
2. 마이그레이션 0029는 **원격 DB에 미적용**이고(`list_migrations` 실측,
   원격은 0028까지) `app_settings`에 `textbook*` 행도 0건 — 역방향
   마이그레이션 없이 파일 삭제만으로 무손실 정리가 된다.
3. 복원 경로는 git 히스토리 + 보존되는 스펙·플랜 문서
   (`2026-07-13-textbook-rag-design.md` 등)로 충분하다.
4. TASK 2(선생님 워크스페이스 업로드 → `class_material` RAG)가 동일 기능을
   제품 방향에 맞게 대체한다.

## 제거 범위

| 파일 | 제거 내용 |
|---|---|
| `backend/app/routers/chat.py` | 질의 임베딩(`qvec`) try/except 블록, gather의 textbook leg, `textbook_context`/`textbook_sources` 변수와 compose 전달 인자, `upstage` import(이 파일에서 textbook 전용), 관련 주석("four context builders"→3개) |
| `backend/tests/test_chat_place.py` | `fake_textbook`·`build_textbook_context` 몽키패치, `fake_embed_query`·`upstage` 몽키패치, `textbook_result`·`spy` 파라미터, textbook 테스트 2개 |
| `backend/app/services/rag.py` | `TEXTBOOK_BLOCK_HEADER`, `build_textbook_context` 및 섹션 주석 전체 |
| `backend/tests/test_rag_textbook.py` | 파일 삭제 |
| `backend/app/services/gemini.py` | `_WRAP_TEXTBOOK`, `compose_system_structured`의 `textbook_context`/`textbook_sources` 파라미터, `textbook_rag` 블록 분기, docstring의 textbook 항목 |
| `backend/tests/test_compose_textbook.py` | 파일 삭제 |
| `backend/app/services/qdrant_store.py` | `COL_TEXTBOOK` 상수·`ensure_collections` 튜플 항목, `textbook_point_id`, textbook 페이로드 인덱스 루프, `delete_textbook_source` |
| `backend/tests/test_qdrant_textbook.py` | 파일 삭제 |
| `backend/app/config.py` | `textbook_rag_enabled`·`textbook_rag_top_k`·`textbook_rag_max_distance` + 섹션 주석 |
| `supabase/migrations/0029_app_settings_textbook_seed.sql` | 파일 삭제 (원격 미적용 확인됨) |
| `backend/scripts/ingest_textbook.py` | 파일 삭제 |
| `backend/textbooks/` | `README.md`·`manifest.example.json` 삭제 (폴더 소멸) |
| `.gitignore` | `backend/textbooks/*` 3줄 규칙 삭제 |
| `backend/tests/test_ingest_textbook.py` | 파일 삭제 |
| `CLAUDE.md` (마무리 단계) | "⚠️ 교과서 전역 코퍼스는 폐기된 방향" 항목을 제거 완료 서술로 갱신, 핵심 파이프라인의 "교과서 RAG" leg 서술 삭제 |

## 비범위 (건드리지 않는 것)

- **로컬 Qdrant `textbook` 컬렉션 데이터** — 데이터 삭제는 파괴적 작업.
  코드 제거로 접근 경로가 사라지고, `ensure_collections`에서 빠지므로 새
  환경에는 생성되지 않는다. 기존 로컬 컬렉션은 무해하게 잔존.
- `docs/superpowers/specs|plans/2026-07-13-textbook-rag*` — 역사 기록 보존.
- `ai_logs`의 과거 `textbook_rag` 컨텍스트 블록 데이터 — 과거 턴 기록 보존.
  (프론트는 블록 kind를 일반 처리 — `textbook` 하드코딩 0건 실측.)
- admin 콘솔 프론트 — `app_settings`를 동적 나열하므로 코드 변경 불요.
  (원격에 textbook 행이 없어 콘솔에도 애초에 안 뜬다.)

## 아키텍처 영향

- 채팅 턴 컨텍스트 빌더 gather가 4-leg → 3-leg (기억 연결·파일 RAG·비교 참조).
- **질의 임베딩(`upstage.embed_query`) 호출이 chat 턴에서 사라진다** — qvec은
  textbook 검색 전용이었다(카드 배치는 프론트 소유). 첫 토큰 지연 소폭 개선.
- `compose_system_structured` 시그니처 축소 — 호출부는 chat.py 하나뿐(실측).
- D35(블록 span 단일 소스)·D62(튜너블 오버레이) 규약은 나머지 블록에 그대로.

## 제거 순서 (의존성 → 3 웨이브)

참조 방향: chat.py → rag.py·gemini.py, rag.py → qdrant_store.py·config.py,
ingest 스크립트 → qdrant_store.py. 각 웨이브의 워크트리에서 전체 스위트가
통과하려면 **호출부부터 역순으로** 제거한다:

1. **웨이브 1**: chat.py 호출부 제거 (+ test_chat_place.py 배선 테스트 정리)
2. **웨이브 2** (병렬 3): rag.py / gemini.py / ingest(스크립트·폴더·.gitignore)
   — 각자 대응 테스트 파일 삭제 포함
3. **웨이브 3** (병렬 2): qdrant_store.py / config.py+0029 마이그레이션

## 검증·완료 기준

- 각 task: 자기 워크트리에서 전체 백엔드 스위트 통과
  (제거 task이므로 RED→GREEN 대신 스위트 통과 + 잔존 참조 grep 0건 — PROCESS DoD 예외).
- 전체 완료: `rg -i textbook`이 `backend/`·`supabase/`·`.gitignore`에서 0건
  (docs·git 히스토리 제외), 전체 스위트 통과, 채팅 턴 E2E에서 정상 응답 +
  textbook 블록 부재 확인.
