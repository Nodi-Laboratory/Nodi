# TASKS.md — 큰 작업 단위

루트 `CLAUDE.md` 제품 모델을 구현하기 위한 작업 목록. **위에서부터 하나씩** 수행한다.
작은 task로의 분해·위임은 실행 시점에 Manager가 한다 (`docs/PROCESS.md`).
각 작업은 스펙 승인 → 구현 → 검증 순서를 지킨다 (스펙 승인 전 구현 금지).

---

## TASK 1. admin 기반 교과서 RAG 구축 코드 정리

- [x] 완료 (2026-07-14 — dev 커밋 3774cce..13704b4 6개, task 리뷰 6건 + 최종 범위
  리뷰 Approved, E2E 검증 PASS. 잔여 운영 메모: 로컬 Qdrant 인스턴스에 과거
  `textbook` 컬렉션 데이터가 남아 있음 — 코드는 참조·생성하지 않으므로 무해,
  정리하려면 수동 `DELETE /collections/textbook`.)

**범위**: admin 개발자가 교과서를 인제스트하는 전역 코퍼스 경로(2026-07-13 구축)를
정리한다. 제품 방향이 "교과서도 선생님이 워크스페이스에 업로드"로 바뀌어 이
경로는 불필요하다.

**정리 대상**:
- 채팅 경로: `routers/chat.py`의 textbook leg(`build_textbook_context` 호출),
  `services/rag.py`의 `build_textbook_context`, `services/gemini.py`의
  `textbook_rag` 블록
- 인제스트: `scripts/ingest_textbook.py`, `backend/textbooks/` 폴더,
  `.gitignore`의 textbooks 규칙
- 저장소: `qdrant_store.py`의 `COL_TEXTBOOK`·`textbook_point_id`·
  `delete_textbook_source`·textbook 페이로드 인덱스
- 설정: `config.py`의 `textbook_rag_*` 3종, `supabase/migrations/0029` 시드
- 테스트: `test_rag_textbook.py`, `test_compose_textbook.py`,
  `test_qdrant_textbook.py`, `test_ingest_textbook.py`,
  `test_chat_place.py`의 textbook 배선 테스트

**결정 필요**: 완전 제거 vs 플래그 오프 보존 — 착수 시 Manager가 트레이드오프를
따져 스스로 결정하고 근거를 아래 "미해결 결정"에 기록한 뒤 진행한다
(`docs/PROCESS.md` 중단 규칙 — 사용자에게 묻지 않는다).

**완료 기준**: 채팅 턴에서 교과서 전역 코퍼스 검색이 일어나지 않고, 전체
테스트 스위트가 통과하며, 남는 죽은 코드가 없다.

---

## TASK 2. 선생님 워크스페이스 파일 입력 및 RAG 구축

- [x] 완료 (2026-07-15 — dev 커밋 68ff9ad..c7ac863 10개(D73~D78), task 리뷰 6건 +
  UX 게이트 1건 전부 Approved, 통합 E2E PASS(자동 주입·출처 칩 라이브/재수화·거리
  게이트·삭제 동선 실측 — Important였던 게이트 과보수는 0.60 상향으로 해소), 최종
  브랜치 리뷰 Approved(Critical/Important 0, Minor 6건 백로그 — 원장 참조).
  잔여 운영 메모: ① 배포 시 마이그레이션 0029·0030 적용(admin 노브 노출·기본 상향),
  ② Supabase Storage 전역 파일 상한을 500MB 이상으로 상향해야 D77 실효,
  ③ uvicorn 로깅에 nodi.* INFO 핸들러 부착 권장(RAG 주입 관측성).)

**범위**: 선생님이 워크스페이스(`space_kind='class'`)에 수업용 교과서·학습 자료를
업로드하면 청킹 → 임베딩 → Qdrant로 **RAG를 구축**하고, 학생 질의 시 top-K 청크가
근거로 주입된다.

**현재 상태**: 백엔드 경로는 대부분 구현되어 있다 —
`kind='class_material'`(교사 전용) 업로드 → `embedding_worker` 파이프라인 →
`rag.build_rag_context` top-K 주입, RLS로 학급 접근 통제.

**남은 일**: 선생님 업로드 → 학생 질의 흐름의 end-to-end 검증 및 빈틈 보수
(업로드 UX, 인덱싱 상태 표시, 실패 파일 재처리 동선).

**완료 기준**: 선생님이 교과서 PDF를 워크스페이스에 올리고, 학생이 그 내용을
질의하면 해당 자료의 청크가 출처와 함께 근거로 주입된다.

---

## TASK 3. 학생 파일 업로드 시 청킹하여 컨텍스트 주입

- [x] 완료 (2026-07-15 — dev 301e895..9a27f9d: docs 2 + feat 4(D83~D85,
  8d4e54d·08d2110·45b3f72·9a27f9d). task 리뷰 4건 + 최종 브랜치 리뷰 전부
  Approved(Critical/Important 0, Minor 6 백로그 — 원장 참조), 통합 스위트
  65 passed·tsc/build PASS. 실브라우저 E2E는 사용자 결정(0037 원격 보류)으로
  축소 — 코드 리뷰·단위 테스트·프론트 목킹 실동작으로 갈음.
  **0037 원격 적용 완료**(2026-07-16, 사용자 승인 — 컬럼 2종·'stored' CHECK·
  예산 시드 150000 실측 검증). 남은 배포 항목은 Storage 전역 상한 500MB
  (대시보드, TASK 2 잔여)뿐. 실브라우저 스모크(업로드→"사용 중" 칩→질의
  근거 주입·예산 초과 거부) 권장.
  사후 보정 task3-5(2026-07-15 사용자 지시): 첨부 진입점을 프롬프트 창 안
  **우측 원형** 클립 버튼으로 이동 + 세션 없으면 ensureSession 자동 생성
  (개인 세션 /space 신규 진입 지원) — a663eb5·813990f, 리뷰 Approved C0/I0/M0.)

**범위**: 학생이 워크스페이스 세션(또는 개인 세션)에 파일을 업로드하면
**청킹·저장까지만** 하고(임베딩·RAG 구축 없음), 그 청크 전체를 seq 순으로
이어붙여 **해당 세션의 컨텍스트로 주입**한다. 파일 용량은 EXAONE 컨텍스트
크기(256K 토큰)에 맞추어 제한한다.

**현재 상태**: 미구현 — 지금은 학생 파일(`kind='user_upload'`)도 전부 RAG
경로(임베딩→top-K 검색)를 타고, 용량 제한은 바이트 상한(`file_max_bytes`)뿐이다.

**주요 결정·구현 지점** (스펙에서 확정):
- 업로드 파이프라인 분기: `user_upload`는 파싱+청킹 저장 후 임베딩 배치 생략
- 세션 스코프: 파일-세션 연결과 조회 방식, 다중 파일 합산 예산 정책
- 컨텍스트 예산: 문자 기준 튜너블(D62 + 시드 마이그레이션), 파싱 후 초과 시
  거부·오류 사유 전달 (업로드 시 바이트 1차 제한은 유지)
- 프롬프트 합류: `compose_system_structured` 새 블록(D35 span 규약), 블록을
  앞쪽에 고정 배치해 Friendli 캐시 입력 단가 활용
- 프론트: "세션 컨텍스트로 사용 중" 표시, 용량 초과 오류 UX
- 불변식 유지: 실패 시 None(채팅 불중단), 본문 조회는 USER 스코프 RLS

**완료 기준**: 학생이 세션에 파일을 올리면 임베딩 없이 즉시 세션 컨텍스트로
활용되고, 질의 응답이 파일 전문을 근거로 한다. 예산 초과 파일은 명확한 사유와
함께 거부된다. 선생님 `class_material` RAG는 회귀 없이 동작한다.

---

## 전제 · 미해결 결정

미해결 결정은 Manager가 착수 시점에 스스로 결정하고 근거를 여기에 기록한 뒤
진행한다 (`docs/PROCESS.md` 중단 규칙).

- **작업 브랜치는 `dev`** — `feature/09-embedding-canvas`는 dev에 병합 완료
  (2026-07-14). main 직접 작업 금지는 그대로 유지.
- **docs 체계 커밋 선행**: 워크트리는 **커밋된 파일만** 체크아웃한다(2026-07-14
  실측 — untracked·gitignore 파일은 워크트리에 없음). `CLAUDE.md`·`docs/*.md`가
  untracked인 동안 워크트리 에이전트에게 보이지 않으므로, TASK 착수 전 `[docs]:`
  커밋으로 추적 상태로 만든다.
- **TASK 1 정리 수위**: **완전 제거로 결정** (2026-07-14, Manager 자율 결정).
  근거: ① 완료 기준 "남는 죽은 코드가 없다"와 플래그 오프 보존이 모순,
  ② 마이그레이션 0029는 원격 DB 미적용·`app_settings` textbook 행 0건 실측
  → 파일 삭제만으로 무손실, ③ 복원은 git 히스토리 + 보존 스펙 문서로 충분,
  ④ TASK 2가 동일 기능을 제품 방향에 맞게 대체. 상세:
  `docs/superpowers/specs/2026-07-14-remove-textbook-rag-design.md`.
- 병렬 세션이 같은 브랜치에서 작업 중일 수 있음 — 에이전트는 **자기 파일만
  `git add`** (전체 스테이징 금지).
- **TASK 2 확장 — 업로드 용량(사용자 결정, 2026-07-15)**: 교사 class_material
  500MB / 학생 업로드 50MB(D77), 50MB 초과 PDF는 분할 파싱(D78 — Upstage 요청당
  50MB 하드 리밋 우회). 스펙:
  `docs/superpowers/specs/2026-07-15-class-material-large-upload-design.md`.
- **D73 거리 게이트 0.60** (2026-07-15, Manager 자율 결정): 마무리 E2E 실측 —
  온토픽 질의 거리 0.497~0.561이 기본 0.50에서 3/4 차단되어 출처 없는 환각으로
  새는 것을 확인, 인사말(0.870)과 마진 0.27을 남기고 0.60으로 상향
  (config·0029 시드·admin 메타 3자 동기).
- **D79~D81 사후 작업 완료** (2026-07-15, 사용자 지시): D79 한글 파일명 업로드
  수정(스토리지 키 ASCII + files.name, 0031 원격 적용), D80 인제스트 Gemini 잔재
  정리, **D81 레거시 전면 삭제** — 태그 시스템(tags·node_tags·file_tags)·ReAct
  추적(ai_sessions·ai_steps) 테이블, 죽은 컬럼 10종(navigator 3종 포함),
  pgvector 확장까지 드랍(0032~0034 **원격 적용 완료** — 이 마이그레이션들은 배포
  체크리스트에서 제외). 스펙:
  `docs/superpowers/specs/2026-07-15-legacy-purge-design.md`, 상세는 원장.
- **TASK 3 스펙 자율 확정** (2026-07-15, Manager 자율 결정 — /goal 자율 수행
  지시, TASK 1·2 스펙 게이트 선례와 동일 근거): D83 `files.session_id`
  재도입(0037)·워커 kind 분기(오버랩 0, 임베딩 팬아웃 생략, 'indexed' 재사용)·
  전문 주입 빌더(session_context.py), D84 예산 `session_context_max_chars`
  기본 150K자(파싱 후 초과 거부·선착순 합산·context_chars 원장), D85
  session_files 블록 system_base 직후 고정(Friendli 프리픽스 캐시). 대안
  비교·근거: `docs/superpowers/specs/2026-07-15-student-session-context-design.md`.
- **D82 — 파일 링크·배치 기능 삭제** (2026-07-15, 사용자 결정):
  `file_node_links`·`file_graph_nodes` 테이블 + 링크/배치 API + 자료 제안 엔진
  전부 제거(−1,159줄). **RAG는 학급 자료 자동 스코프 단일 경로**(전 청크 거리
  게이트 0.60, 라벨 "[학급 자료에서 참고]")로 확정 — 개인 공간 파일 RAG는
  소멸(TASK 3의 세션 전문 주입이 대체 예정). admin 죽은 노브 5종도 정리.
  0035·0036 + 보류 시드 0029·0030 **원격 적용 완료** — 남은 배포 항목은
  Supabase Storage 전역 상한 500MB(대시보드)뿐. 게이트: 리뷰 Approved +
  실브라우저 검증(자동 주입·출처 칩·인사말 차단) PASS. 스펙 §6, 상세는 원장.
