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
- 선생님은 별도 버튼으로 **교과서**(`kind='textbook'`, PDF 전용)도 업로드한다
  (TASK 4, D86~D88 — 0038·0039 원격 적용 완료, E2E PASS 2026-07-17). 텍스트는
  class_material과 동일하게 RAG 구축 + 추가로 figure를 추출·임베딩해 Qdrant
  `textbook_figures`에 적재(D86). **figure 캡션은 비전 판정이 확정한다**(D93,
  사용자 결정 2026-07-18): 후보는 bbox 중심 절대거리 top-3(위치기반 매칭 제거),
  판정이 고른 후보 **캡션 단독**이 임베딩 텍스트(heading·alt·enhanced 설명 제외
  — D91 대체). **D103: 캡션 확정은 2단 경로다** — ① 파서가 `caption`/`footnote`로
  라벨한 요소가 가까이(정규화 거리 0.25 이내) 있으면 그대로 캡션
  (`match_kind='parsed'`, 비전 판정 불필요), ② 라벨이 없으면 비전 판정이
  candidates에서 고른다(폴백). **둘 다 없으면 캡션 없이 failed — 추측하지 않는다.**
  판정 미설정은 더 이상 업로드를 막지 않고(D93 게이트 해제), 라벨 없는 figure만
  처리되지 않는다. 판정 실패(-1 포함) figure는 임베딩 없이 failed(검색 미노출,
  retry로 재판정 가능). 학생 질의와 유사한
  figure(거리 게이트 0.60)는 캔버스 FigureNode로 표시 — **다중 표시**(D95:
  top-3, 리프 id=`figure-{figureId}`로 세션 내 중복 제거·누적, 재수화는 전
  노드 figures를 figureId dedupe 후 전부 복원). 이미지는 백엔드 signed
  URL로만 서빙, **URL 영속 금지**(재수화·만료 시 `GET /files/figures/{id}` 재발급,
  D87). figure 실패는 텍스트 인덱싱과 격리(`files.status` 불가침, D88).
- **학생**은 워크스페이스에 참여해(학급 코드 가입) 세션을 열고, 선생님이 올린
  교과서·자료를 근거로 질의한다. RLS가 학급 자료 접근을 통제한다.
- **학생도 워크스페이스 세션에 파일을 업로드할 수 있다** (TASK 3, D83~D85 구현
  완료). 이 파일(`kind='user_upload'`)은 RAG로 구축하지 않고 청킹(오버랩 0)·저장
  까지만 한 뒤(임베딩·Qdrant 생략) **해당 세션의 컨텍스트로 전문(全文) 주입**한다.
  예산은 세션당 합산 문자 튜너블 `session_context_max_chars`(기본 150K자, D84) —
  파싱 후 초과 파일은 한국어 사유와 함께 거부. 바이트 1차 상한(D77: 학생 50MB) 유지.
  마이그레이션 0037(files.session_id·context_chars, 'stored' 청크 상태)은
  **2026-07-16 원격 적용 완료**(사용자 승인).
- 학생은 워크스페이스 세션 외에 **개인 세션**(`space_kind='personal'`)을 개설해
  자유롭게 질의할 수 있다.
- 교과서 전역 코퍼스(admin 인제스트 경로)는 **2026-07-14 완전 제거됨**(TASK 1,
  스펙 `docs/superpowers/specs/2026-07-14-remove-textbook-rag-design.md`). admin은
  교과서를 입력하지 않는다 — 교과서는 선생님이 워크스페이스에 업로드한다(TASK 2).

## 스택

Next.js(App Router, `frontend/`) · FastAPI(`backend/`) · Postgres(RLS로 권한 강제·자체 인증)
· Qdrant(벡터 1024d/Cosine, `docker compose up -d qdrant`) · Upstage(임베딩 + 문서 파싱)
· Upstage `solar-pro2`(대화 생성 — 스트리밍 + tool calling, D108).
교과서 도판 비전 판정만 별도 계열(judge_* 노브)이며 아직 미구현이다.

## 핵심 파이프라인

- **파일 인제스트** (`services/worker/`, D105로 책임별 분할 —
  jobs·split·batch·figures·common·runner): 업로드(형식 화이트리스트 D75,
  용량 kind별 D77 — 교사 자료 500MB/학생 50MB) → `embedding_split` 잡
  → Upstage Document Parse(50MB 초과 PDF는 페이지 분할 파싱, D78)
  → 문단 인지 청킹(1,200자/오버랩 150자, admin 튜너블)
  → `embedding_batch` 잡 팬아웃(64청크 단위) → Upstage `embedding-passage` 1024d(D106)
  → **벡터는 Qdrant, 청크 본문·상태는 Postgres `file_chunks`**.
  교과서는 `upstage.parse_document_full`(표준 모드+coordinates+figure base64 —
  D92로 enhanced 제거, 조각 ≤48MB·≤100p 사전 분할)로 텍스트·elements를 한 번에
  얻고 figure 팬아웃(`figure_batch` 잡, 배치 8): 크롭 Storage 업로드 → 비전
  판정(필수, D93 — 절대거리 top-3 후보 중 선택, 미선택 행은 failed) →
  embed_text=**판정 선택 캡션 단독**(D93) `embedding-passage` → Qdrant
  `textbook_figures`(**페이로드는 `{figure_id, file_id, owner_id}`만**). 행 상태는
  `textbook_figures.status`로만 추적(D86/D88).
- **채팅 턴** (`routers/chat.py` `chat_stream`) — 경로가 둘이다:

  **ReAct 경로** (D109, `react_enabled` 튜너블·**기본 on**): 도구 판단 → 스킬 실행
  → 생성. 스킬은 `app/ai/skills/`에 파일 하나씩이고, 노출 카탈로그는
  `ai/catalog.py`가 `(space_kind, role)`로 **먼저 좁힌다** — 개인 세션에 학급
  도구를 보여주면 모델이 부르고 빈 결과로 엉뚱한 답을 한다. 좁힌 뒤 모델이
  고르므로 인사 턴에는 임베딩·검색이 아예 나가지 않는다. 판단 단계는 개념 카드
  형식을 주지 않고, 생성 단계는 도구를 주지 않는다(두 지시의 충돌 회피 +
  추론 누출 차단). 스킬 실패는 `SkillResult(ok=False)`로 모델에 전달되고
  턴을 죽이지 않는다.

  스킬 7종: think · search_class_material · search_textbook_figure ·
  list_session_concepts · get_concept · list_session_files · read_session_file.
  카탈로그는 스코프뿐 아니라 **세션 상태**로도 갈린다(파일이 없으면 파일 스킬을
  노출하지 않는다 — 노출하면 모델이 부르고 빈 결과로 군더더기를 붙인다).

  **기존 단발 경로** (`react_enabled` off, 롤백용):
  컨텍스트 빌더 병렬(gather): 기억 연결·파일 RAG·비교 참조·세션 파일 전문
  (D83, `session_context.py` — session_files 블록은 system_base 직후 고정,
  D85 Friendli 프리픽스 캐시) →
  `gemini.compose_system_structured`(D35: 프롬프트 문자열 + 블록 span 단일 소스.
  세션 기사용 분류 태그를 tag_guide 블록으로 주입해 태그 재사용 유도 — D89,
  session_files 뒤 배치로 캐시 프리픽스 보존) →
  `exaone.stream_answer` SSE → 개념 카드 파싱·캔버스 배치. 시스템 프롬프트는
  **중·고등 전 교과 교사 페르소나 + 자유 분류 태그**(D89, `exaone.py`).
- **캔버스 배치**: 개념 카드는 EXAONE 자유 태그로 클러스터링 — 태그 첫 등장
  순서로 황금각 슬롯 앵커를 영구 부여(D90, `useTagLayout`/`curriculumTags.ts`),
  "기타"는 중앙. 교과서 도판은 `services/figure_search.py`가 검색한다(D111 — 프론트
  선행 `/retrieve` 제거, ReAct 스킬과 레거시 경로가 같은 구현을 쓴다). (D94, 사용자 결정 2026-07-18: EBS 영상·SVG 아트 추천 기능 전면 제거 —
  `/art/search`·인제스트 스크립트·Qdrant ebs/art_assets 컬렉션·art_assets
  테이블 포함. 마이그레이션 0040은 2026-07-19 원격 적용 완료).

## 불변식 (반드시 유지)

- **RAG는 채팅을 절대 막지 않는다** — 모든 컨텍스트 빌더는 best-effort, 실패 시 None.
- **Qdrant는 신뢰 경계가 아니다** — 사용자 파일 청크 본문은 Qdrant 페이로드에 넣지
  않고, 검색 히트 후 USER 스코프 클라이언트로 재조회해 RLS가 재검증한다.
  (과거 예외였던 EBS·아트 전역 카탈로그는 D94로 제거. canvas_cards는 소유자·
  세션 페이로드 필터를 강제한 채 제목·좌표를 페이로드에 저장한다.)
- **임베딩은 비대칭** — 질의 `embedding-query`, 문서 `embedding-passage`. 혼용 금지.
- **거리 규약** `distance = 1 - score` (Qdrant cosine → 기존 임계값 의미 유지).
- **튜너블(D62)**: admin 오버레이(`app_settings`) > config 기본값. 새 노브는
  `app_settings.as_*` + clamp로 읽고 `db/03_app_settings.sql`에 기본값을 추가해야
  admin 콘솔에 뜬다.
- **권한은 DB가 강제한다(D104)** — RLS 정책 38개 + 함수 26개. 앱 코드로 옮기지
  않는다. 사용자 요청은 `nodi_app` 역할 + `SET LOCAL app.user_id`로 돌고,
  `auth.uid()`가 그 값을 읽어 정책이 판정한다. **직접 커넥션을 얻지 말 것** —
  `db/pool.py`의 `user_conn()`이 트랜잭션과 컨텍스트 주입을 한 묶음으로 보장한다
  (그 경로를 우회하면 앞 요청의 사용자로 질의가 나갈 수 있다).
  워커는 `nodi_worker`(BYPASSRLS). 비밀번호 해시가 든 `public.users`는
  `nodi_app`에 GRANT 자체가 없다 — 정책보다 앞선 방어.
- **카드 좌표는 저장하지 않는다(D105)** — 소유자는 프론트 d3-force(`useTagLayout`)
  이고, 매 로드마다 재계산한다. 태그 슬롯이 첫 등장 순서로만 정해지므로 같은
  세션은 항상 같은 배치로 수렴한다. 좌표를 받아 적는 엔드포인트·컬럼은 제거됐다.

## 개발

- 백엔드 의존성: **`cd backend && uv sync --group dev`** (`uv.lock` 기준 버전 고정).
  `requirements.txt`는 하한만 있는 폴백 — 버전이 팀원마다 갈리므로 권장하지 않는다.
- 백엔드 테스트: `cd backend && uv run pytest tests/ -v` (전부 mock — 키·네트워크 불필요).
  커버리지는 `--cov` 추가(목표치 강제 없음 — 어디가 비었는지 보는 용도, D105).
- 프론트 테스트: `cd frontend && npm test` (vitest, D105). 대상은 `lib/concept`의
  파서·배치 순수 함수 — 컴포넌트 렌더 테스트는 아직 없다.
- 로컬 실행 (README '빠른 시작' 참조):
  1. `docker compose up -d` (postgres 5433 + qdrant 6333)
  2. `cd backend && uv run uvicorn app.main:app --reload --port 8000`
  3. `cd frontend && npm run dev` (http://localhost:3000)
- 프론트 타입/빌드 스모크: `cd frontend && npx tsc --noEmit && npm run build`
- **API 경로(D105)**: 백엔드 도메인 라우터는 전부 `/api` 아래다. `/health`만
  접두사 밖(인프라 liveness 계약). 프론트 `NEXT_PUBLIC_API_BASE_URL`은 로컬
  `http://localhost:8000/api`, 배포 `/api` — 뒤 경로가 양쪽에서 같다.
- **환경 변수: `backend/.env`** (루트 `.env` 아님 — `config.py`의 `BACKEND_ENV`).
  프론트는 `frontend/.env.local`. 각각 `.env.example`·`.env.local.example` 참고.
  백엔드 필수: `DATABASE_URL`·`DATABASE_WORKER_URL`·`JWT_SECRET` +
  `UPSTAGE_API_KEY`·`EXAONE_API_KEY`. 프론트는 `NEXT_PUBLIC_API_BASE_URL` 하나.
- **설정 자가진단**: `GET /health/config` — 무엇이 빠졌는지 `blocking`·`judge.missing`이
  알려준다(D97, 비밀값 미노출). 같은 요약이 부팅 시 터미널에도 찍힌다.
- **DB 스키마(D104)**: `db/`의 SQL 5개가 이름순 자동 적용된다(빈 볼륨일 때 1회).
  바꾸려면 `01_schema.sql`을 고치고 `docker compose down -v && up -d`.
  **`down -v`는 데이터를 지운다** — 계정도 사라지므로 다시 만들어야 한다.
- **계정은 시드하지 않는다**. 학생·교사는 `/signup`에서 가입하고, 관리자는
  가입으로 얻을 수 없어(D99) CLI로 만든다:
  `uv run python -m app.cli create-user <이메일> <비번> --role admin`
  (`grant-admin` / `list-users`도 있다).

## 컨벤션

- 주석·docstring·커밋 메시지는 **한국어**, 제약·근거 위주. 커밋 프리픽스
  `[feat]:`/`[fix]:`/`[docs]:`/`[tune]:`/`[chore]:`.
- 설계 결정은 D-번호(D11, D35, D62 …)로 코드 주석에 남긴다.
- 스펙: `docs/superpowers/specs/`, 구현 계획: `docs/superpowers/plans/`.
- `.env`·`qdrant_storage/`는 커밋 금지(.gitignore).
