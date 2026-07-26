# Nodi

> 교실 학습용 AI 도우미. 학생이 질문하면 EXAONE이 **개념 카드**를 스트리밍하고,
> 무한 캔버스 위에 주제별로 묶어 배치한다. 선생님이 올린 수업 자료·교과서를
> 근거로 답한다.

Next.js(App Router) · FastAPI · Supabase(Postgres/RLS/Auth/Storage) ·
**Qdrant**(벡터 4096d) · **Upstage**(임베딩 + 문서 파싱) · **EXAONE**(대화 생성).

- 제품 모델·불변식·컨벤션: **[`CLAUDE.md`](CLAUDE.md)** ← 이 저장소의 규범 문서
- 작업 체계: [`docs/TASKS.md`](docs/TASKS.md) · [`docs/AGENTS.md`](docs/AGENTS.md) · [`docs/PROCESS.md`](docs/PROCESS.md)
- 배포(클라우드 VM): [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

---

## ⚠️ 합류 전에 반드시 읽을 것

**개발은 로컬 DB에서 한다.** 원격 Supabase 프로젝트에는 실제 사용 데이터가 들어
있고 팀 전체가 공유하므로, 개발 중 원격에 붙지 않는다 (→ [로컬 DB](#로컬-db)).

원격에 붙어야 할 때의 규칙:

- **마이그레이션 원격 적용은 저장소 오너 한 사람만 한다.** 새 마이그레이션 SQL은
  커밋만 하고, 적용은 오너에게 요청한다 (적용 이력은 `docs/TASKS.md`에 기록).
- **테스트 데이터를 지울 때 남의 것을 지우지 않는지 확인한다.** git과 달리
  되돌릴 수 없다.
- 백엔드 테스트 스위트(`pytest`)는 전부 mock이라 어느 DB에도 닿지 않는다 —
  마음껏 돌려도 된다.

---

## 빠른 시작

### 사전 준비

- **Node.js 20+** / npm
- **Python 3.11+** (권장 3.12)
- **Docker** — Qdrant 컨테이너용
- **[uv](https://docs.astral.sh/uv/)** — 파이썬 의존성 관리 (`pip install uv` 또는 `winget install astral-sh.uv`)
- 키: Supabase 프로젝트 접근, Upstage API 키, EXAONE(Friendli) 키 → 오너에게 요청

### 1) 환경 변수

```bash
cp backend/.env.example        backend/.env           # 백엔드
cp frontend/.env.local.example frontend/.env.local    # 프론트엔드
```

```powershell
# Windows PowerShell
copy backend\.env.example        backend\.env
copy frontend\.env.local.example frontend\.env.local
```

각 파일의 주석을 따라 값을 채운다. 필수는 4개 —
`SUPABASE_URL` · `SUPABASE_ANON_KEY` · `UPSTAGE_API_KEY` · `EXAONE_API_KEY`.
(업로드까지 쓰려면 `SUPABASE_SERVICE_ROLE_KEY`도 필요.)

> **⚠️ `.env` 위치**: 백엔드는 **`backend/.env`**를 읽는다 (저장소 루트 아님 —
> `backend/app/config.py`의 `BACKEND_ENV`). 루트에 두면 값이 하나도 안 읽히는데
> **서버는 정상 부팅하므로** 원인을 찾기 어렵다.

### 2) 실행

```bash
# 0) Qdrant (벡터 저장소)
docker compose up -d qdrant          # 대시보드: http://localhost:6333/dashboard

# 1) 백엔드 (FastAPI)
cd backend
uv sync --group dev                  # uv.lock 기준으로 .venv 구성 (버전 고정)
uv run uvicorn app.main:app --reload --port 8000

# 2) 프론트엔드 (Next.js) — 다른 터미널
cd frontend
npm ci                               # package-lock.json 기준
npm run dev                          # http://localhost:3000
```

<details>
<summary>uv 없이 (폴백)</summary>

```bash
cd backend
python -m venv .venv                              # Windows: py -3.12 -m venv .venv
source .venv/bin/activate                         # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt pytest pytest-asyncio
uvicorn app.main:app --reload --port 8000
```

`requirements.txt`는 하한(`>=`)만 있어 **팀원마다 다른 버전이 깔린다.**
가급적 `uv sync`를 쓴다.
</details>

### 3) 로컬 DB

```bash
npx supabase start        # 최초 1회는 이미지 다운로드로 몇 분 걸린다
npx supabase status       # API URL·키 확인
```

Postgres · PostgREST · Auth · Storage · Realtime이 전부 로컬로 뜬다.
마이그레이션 `0001`~`0040`과 `supabase/seed.sql`이 자동 적용되므로
**원격과 스키마가 동일하다** (테이블 11개 · RPC 18개).

`backend/.env`의 Supabase 3종을 로컬 값으로 바꾼다 —
`backend/.env.local.example`에 그대로 적혀 있다. 프론트는
`frontend/.env.local`의 `NEXT_PUBLIC_SUPABASE_*`를 같은 값으로 맞춘다.

**시드 계정** (비밀번호 전부 `nodi-local-dev`):

| 계정 | 역할 |
|---|---|
| `teacher@nodi.local` | 교사 — 학급 "로컬 테스트 학급"(코드 `LOCAL1`) 담당 |
| `student@nodi.local` | 학생 — 위 학급에 가입된 상태 |
| `admin@nodi.local` | 관리자 |

> 인증은 **이메일/비밀번호**다(D99 — Google OAuth 제거). `/signup`에서 역할을
> 골라 가입하고 `/login`으로 들어온다. 구글 로그인은 나중에 자체 리다이렉션으로
> 다시 붙일 예정이다.

| 명령 | 용도 |
|---|---|
| `npx supabase stop` | 스택 정지 (데이터 유지) |
| `npx supabase db reset` | 마이그레이션 + 시드 재적용 (데이터 초기화) |
| `npx supabase status` | 키·URL 재확인 |

Studio(웹 콘솔): <http://127.0.0.1:54323> · 메일 확인: <http://127.0.0.1:54324>

### 4) 설정 확인

서버를 띄운 뒤 **<http://localhost:8000/health/config>** 를 연다.

```jsonc
{
  "ready": true,        // ← 채팅 한 턴에 필요한 설정이 모두 갖춰짐
  "blocking": [],       // ← 비어 있어야 정상. 남아 있으면 그게 빠진 것
  "judge": { "configured": false, "missing": ["JUDGE_API_KEY", "JUDGE_BASE_URL"] }
}
```

비밀값은 노출되지 않는다(존재 여부만). 부팅 시 터미널에도 같은 요약이 찍힌다.

`ready: false`면 `blocking` 배열이 원인을 정확히 알려준다. 대부분은
`.env`를 루트에 만들었거나 `UPSTAGE_API_KEY`를 빠뜨린 경우다.

---

## 주요 기능

- **개념 캔버스** — pan/zoom 무한 캔버스에 개념 카드를 손글씨 스타일로 배치.
  `(app)/space/[spaceId]`.
- **태그 기반 배치** — EXAONE이 개념마다 자유 태그(단원·주제 수준)를 붙이고,
  프론트가 태그 첫 등장 순서로 황금각 슬롯 앵커를 부여해 묶는다(D89/D90).
- **선생님 워크스페이스** — 학급 개설, 수업 자료(`class_material`)·교과서
  (`textbook`) 업로드. 자료는 청킹 → 임베딩 → Qdrant로 RAG 구축.
- **학생 세션 파일** — 학생이 올린 파일(`user_upload`)은 임베딩 없이 청킹만 하고
  **세션 컨텍스트로 전문 주입**한다(D83~D85, 기본 예산 150K자).
- **교과서 figure** — 교과서 PDF에서 도판을 추출해 비전 판정으로 캡션을 확정하고
  (D93), 학생 질의와 가까운 도판을 캔버스에 FigureNode로 띄운다(D95).
- **인증/권한** — 이메일/비밀번호 자체 회원가입·로그인(D99), 역할
  (student/teacher/admin), 개인(personal)·학급(class) 스코프, RLS로 접근 제어.
  가입 시 고른 역할은 `student`·`teacher`만 허용되며 `admin`은 승격으로만 부여된다.

---

## 아키텍처

```
프론트(Next.js, (app)/space/[spaceId])
  ConceptCanvasWorkspace = NoteCanvas + ConceptCard + FigureNode
  useConceptStream: (1) POST /retrieve  → 잠정 배치 + figure 추천 노드
                    (2) POST /chat/stream(SSE, EXAONE) → 개념 스트리밍 → 재조정
                    (3) PATCH /nodes/{id} → 위치·노드 영속(attachments.canvas)
        │
백엔드(FastAPI)
  services/upstage.py       임베딩(embedding-query/passage, 4096d) + 문서 파싱
  services/qdrant_store.py  컬렉션 file_chunks / canvas_cards / textbook_figures
  services/exaone.py        대화 생성(스트리밍)
  services/figure_*.py      교과서 도판 추출·비전 판정
  routers/retrieve.py       질의 임베딩 + Qdrant 검색
        │
Supabase(관계형 + RLS + Auth + Storage)  ·  Qdrant(벡터만; RLS 없음 → 앱이 스코프 강제)
```

**불변식** (자세히는 [`CLAUDE.md`](CLAUDE.md)):

- RAG는 채팅을 절대 막지 않는다 — 모든 컨텍스트 빌더는 best-effort.
- Qdrant는 신뢰 경계가 아니다 — 청크 본문은 USER 스코프 Supabase로 재조회해
  RLS가 재검증한다.
- 임베딩은 비대칭 — 질의 `embedding-query`, 문서 `embedding-passage`. 혼용 금지.
- 거리 규약 `distance = 1 - score`.

---

## 저장소 구조

```
Nodi/
├─ frontend/                 Next.js (App Router, TypeScript)
│  └─ src/
│     ├─ app/(app)/space/[spaceId]/   대화 캔버스 라우트
│     ├─ components/canvas/           NoteCanvas·ConceptCard·FigureNode …
│     └─ lib/concept/                 useConceptStream·layout·useTagLayout …
├─ backend/                  FastAPI
│  ├─ app/services/          upstage·qdrant_store·exaone·embedding_worker·figure_* …
│  ├─ app/routers/           retrieve·chat·files·nodes·sessions·teacher·admin·me …
│  └─ tests/                 pytest (전부 mock — 외부 호출·원격 DB 없음)
├─ supabase/migrations/      0001 … 0040
├─ docs/                     TASKS·AGENTS·PROCESS·DEPLOYMENT + superpowers/{specs,plans}
└─ docker-compose.yml        qdrant 서비스
```

---

## 검증

```bash
# 백엔드 테스트 (전부 mock — 키·네트워크 불필요)
cd backend && uv run pytest tests/ -v

# 프론트 타입 + 빌드 스모크
cd frontend && npx tsc --noEmit && npm run build
```

두 가지는 CI(`.github/workflows/ci.yml`)에서도 돌지만, **PR 올리기 전에 로컬에서
먼저 통과시킨다.**

---

## 데이터베이스

마이그레이션은 `supabase/migrations/`에 순번대로 있고, **최신은 `0040_drop_ebs_art.sql`**
(원격 적용 완료). 적용 이력은 `docs/TASKS.md`에 기록한다.
로컬에서는 `npx supabase db reset`으로 전량 재적용된다.

> ⚠️ **API 롤 GRANT 부채**: 마이그레이션 어디에도 `anon`/`authenticated`/
> `service_role`에 대한 명시적 `GRANT`가 없다. 원격 프로젝트가 Supabase의
> **레거시 auto-expose 동작**에 기대고 있기 때문이다. 로컬은
> `config.toml`의 `auto_expose_new_tables = true`로 같은 동작을 재현하지만,
> **이 옵션은 2026-10-30에 제거된다.** 그전에 명시적 GRANT 마이그레이션을
> 추가하거나 Supabase 자체를 걷어내야 한다.

새 마이그레이션을 추가할 때:

1. `00NN_설명.sql`로 커밋한다 (적용은 하지 않는다).
2. 튜너블(`app_settings`) 노브를 추가했다면 시드 마이그레이션도 함께 넣는다 —
   안 그러면 admin 콘솔에 뜨지 않는다(D62).
3. 오너에게 원격 적용을 요청하고, 적용되면 `docs/TASKS.md`에 날짜와 함께 기록한다.

---

## 컨벤션

- 주석·docstring·커밋 메시지는 **한국어**, 제약·근거 위주.
- 커밋 프리픽스 `[feat]:` / `[fix]:` / `[docs]:` / `[tune]:` / `[chore]:`
- 설계 결정은 **D-번호**(D93, D97 …)로 코드 주석에 남긴다.
- 스펙은 `docs/superpowers/specs/`, 구현 계획은 `docs/superpowers/plans/`.
- `.env`·`qdrant_storage/`·`.claude/`는 커밋 금지(`.gitignore`).
- **`main` 직접 작업 금지.** 작업 브랜치는 `dev`.
