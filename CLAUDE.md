# CLAUDE.md

Nodi — 교실 학습용 AI 도우미. 학생이 질문하면 EXAONE이 **개념 카드**를 스트리밍하고,
무한 캔버스 위에 임베딩 기반으로 배치한다. 선생님 수업 자료·교과서를 근거로 답한다.

## 작업 실행 체계 (docs/) — Manager 전용

<subagent-guard>
**역할 가드**: 이 섹션은 사용자와 직접 대화하는 **메인 세션(Manager)에만**
적용된다. 당신이 Agent 도구로 디스패치된 **서브에이전트라면**(프롬프트에 task
브리프와 보고 지시가 있다) 이 섹션을 무시하라 — TASKS.md를 실행하지 말고,
에이전트를 생성하지 말고, PROCESS.md 루프를 돌리지 말고, **받은 브리프의 task
하나만 수행해 보고하라.** docs/AGENTS.md는 브리프가 명시적으로 가리키는 자기
페르소나 섹션만 참고한다.
</subagent-guard>

Manager는 기능 구현 작업 시 다음 문서 체계를 따른다 — **작업 시작 전에 반드시 읽는다**:

- `docs/TASKS.md` — **무엇을**: 큰 작업 단위 목록 (위에서부터 하나씩 수행)
- `docs/AGENTS.md` — **누가**: 페르소나 × 스킬 (Manager 전담 / 병렬 에이전트)
- `docs/PROCESS.md` — **어떻게**: 실행 루프 (분해 → 병렬 디스패치 → 리뷰 게이트 → 기록)

## 제품 모델 (워크스페이스 중심)

- **선생님**은 워크스페이스(= `space_kind='class'` 학급)를 개설하고, 수업에 사용할
  **교과서·학습 자료**를 업로드한다. 이 파일(`kind='class_material'`)은
  청킹 → 임베딩(Qdrant)으로 **RAG로 구축**되어, 질의 시 top-K 청크가 근거로 주입된다.
- **학생**은 워크스페이스에 참여해(학급 코드 가입) 세션을 열고, 선생님이 올린
  교과서·자료를 근거로 질의한다. RLS가 학급 자료 접근을 통제한다.
- **학생도 워크스페이스에서 파일을 업로드할 수 있다.** 단 이 파일은 RAG로 구축하지
  않고 **해당 세션의 컨텍스트로만 전문(全文) 주입**한다. 파일 용량은 EXAONE 컨텍스트
  크기(256K 토큰)에 맞추어 제한한다.
  ⚠️ 설계 방향이며 **아직 미구현**(TASK 3): 현재 코드는 학생 파일도 RAG 경로로
  처리하며, 용량은 바이트 상한(D77: 학생 50MB)뿐 컨텍스트 예산 제한은 없다.
- 학생은 워크스페이스 세션 외에 **개인 세션**(`space_kind='personal'`)을 개설해
  자유롭게 질의할 수 있다.
- 교과서 전역 코퍼스(admin 인제스트 경로)는 **2026-07-14 완전 제거됨**(TASK 1,
  스펙 `docs/superpowers/specs/2026-07-14-remove-textbook-rag-design.md`). admin은
  교과서를 입력하지 않는다 — 교과서는 선생님이 워크스페이스에 업로드한다(TASK 2).

## 스택

Next.js(App Router, `frontend/`) · FastAPI(`backend/`) · Supabase(Postgres/RLS/Auth/Storage)
· Qdrant(벡터 4096d/Cosine, `docker compose up -d qdrant`) · Upstage(임베딩 + 문서 파싱)
· EXAONE `K-EXAONE-236B-A23B`(Friendli 서버리스, 스트리밍 챗, 256K 컨텍스트).

## 핵심 파이프라인

- **파일 인제스트** (`services/embedding_worker.py`): 업로드(형식 화이트리스트 D75,
  용량 kind별 D77 — 교사 자료 500MB/학생 50MB) → `embedding_split` 잡
  → Upstage Document Parse(50MB 초과 PDF는 페이지 분할 파싱, D78)
  → 문단 인지 청킹(1,200자/오버랩 150자, admin 튜너블)
  → `embedding_batch` 잡 팬아웃(64청크 단위) → Upstage `embedding-passage` 4096d
  → **벡터는 Qdrant, 청크 본문·상태는 Supabase `file_chunks`**.
- **채팅 턴** (`routers/chat.py` `chat_stream`):
  컨텍스트 빌더 병렬(gather): 기억 연결·파일 RAG·비교 참조 →
  `gemini.compose_system_structured`(D35: 프롬프트 문자열 + 블록 span 단일 소스) →
  `exaone.stream_answer` SSE → 개념 카드 파싱·캔버스 배치.
- **캔버스 배치**: 질의 임베딩으로 유사 카드 근처 잠정 배치 → 응답 도착 후 재조정.
  EBS 영상·SVG 아트 추천 노드는 `routers/retrieve.py`가 별도 검색.

## 불변식 (반드시 유지)

- **RAG는 채팅을 절대 막지 않는다** — 모든 컨텍스트 빌더는 best-effort, 실패 시 None.
- **Qdrant는 신뢰 경계가 아니다** — 사용자 파일 청크 본문은 Qdrant 페이로드에 넣지
  않고, 검색 히트 후 USER 스코프 Supabase 클라이언트로 재조회해 RLS가 재검증한다.
  (예외: EBS·아트 등 전역 공용 카탈로그는 페이로드에 본문 저장 가능.)
- **임베딩은 비대칭** — 질의 `embedding-query`, 문서 `embedding-passage`. 혼용 금지.
- **거리 규약** `distance = 1 - score` (Qdrant cosine → 기존 임계값 의미 유지).
- **튜너블(D62)**: admin 오버레이(`app_settings`) > config 기본값. 새 노브는
  `app_settings.as_*` + clamp로 읽고 시드 마이그레이션을 추가해야 admin 콘솔에 뜬다.

## 개발

- 백엔드 테스트: `cd backend && python -m pytest tests/ -v` (venv: `backend/.venv`)
- 로컬 실행 (README '로컬 실행' 참조):
  1. `docker compose up -d qdrant` (대시보드 http://localhost:6333/dashboard)
  2. `cd backend && uvicorn app.main:app --reload --port 8000` (`GET /health` 확인)
  3. `cd frontend && npm run dev` (http://localhost:3000)
- 프론트 타입/빌드 스모크: `cd frontend && npx tsc --noEmit && npm run build`
- 환경 변수: 루트 `.env` (`backend/.env.example` 참고 — UPSTAGE_API_KEY, QDRANT_URL,
  EXAONE_API_KEY, Supabase 키)

## 컨벤션

- 주석·docstring·커밋 메시지는 **한국어**, 제약·근거 위주. 커밋 프리픽스
  `[feat]:`/`[fix]:`/`[docs]:`/`[tune]:`/`[chore]:`.
- 설계 결정은 D-번호(D11, D35, D62 …)로 코드 주석에 남긴다.
- 스펙: `docs/superpowers/specs/`, 구현 계획: `docs/superpowers/plans/`.
- `.env`·`qdrant_storage/`는 커밋 금지(.gitignore).
