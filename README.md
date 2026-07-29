# Nodi

> 교실 학습용 AI 도우미. 학생이 질문하면 모델이 **개념 카드**를 스트리밍하고,
> 무한 캔버스 위에 주제별로 묶어 배치한다. 선생님이 올린 수업 자료·교과서를
> 근거로 답한다.

Next.js(App Router) · FastAPI · **Postgres**(RLS로 권한 강제) ·
**Qdrant**(벡터 1024d) · **Upstage**(대화 생성 `solar-pro2` + 임베딩 + 문서 파싱).

> ## 📌 변경 보고서 — 먼저 읽으세요
>
> **[`docs/CHANGELOG-D104-D114.md`](docs/CHANGELOG-D104-D114.md)**
> (2026-07-27 ~ 07-28 · 커밋 51개 · +18,330 / −11,103줄)
>
> **Supabase 완전 제거(D104)**부터 운영 콘솔·데이터 관리(D113·D114)까지 이 기간에
> 무엇을 바꿨는지 정리한 기록입니다. DB 스키마 변경(정책 32→38, 함수 19→26),
> `db/migrations/` 규약 신설, 개발 DB에 실제로 한 작업까지 담겨 있습니다.

- 제품 모델·불변식·컨벤션: **[`CLAUDE.md`](CLAUDE.md)** ← 이 저장소의 규범 문서
- 작업 체계: [`docs/TASKS.md`](docs/TASKS.md) · [`docs/AGENTS.md`](docs/AGENTS.md) · [`docs/PROCESS.md`](docs/PROCESS.md)
- 배포: **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — 배포 서버는 컨테이너를
  못 쓴다(D116). supervisor로 프로세스를 띄운다.

---

## 빠른 시작

### 사전 준비

- **Node.js 20+** / npm
- **Python 3.11+** (권장 3.12)
- **Docker** — Postgres·Qdrant 컨테이너용
- **[uv](https://docs.astral.sh/uv/)** — 파이썬 의존성 관리 (`pip install uv`)
- 키: **Upstage API 키 하나** → 오너에게 요청

> 외부 서비스 의존은 **Upstage 하나뿐**이다(D108: 대화 생성까지 Upstage로 모였다).
> 데이터·인증·파일은 전부 로컬에서 돈다. 교과서 도판 비전 판정(`JUDGE_*`)은
> 선택이며, 비워 두면 라벨 없는 도판만 처리되지 않는다.

### 1) 인프라

```bash
docker compose up -d      # postgres(5433) + qdrant(6333)
```

`db/`의 SQL이 이름순으로 자동 적용된다(**최초 1회, 빈 볼륨일 때만**):

| 파일 | 내용 |
|---|---|
| `00_bootstrap.sql` | `auth.uid()` · `public.users` · 역할(`nodi_app`/`nodi_worker`) |
| `01_schema.sql` | 테이블 12 · RLS 정책 38 · 함수 26 |
| `02_triggers.sql` | 가입 시 프로필 자동 생성 |
| `03_app_settings.sql` | admin 튜너블 기본값 13종 |
| `04_seed.sql` | (계정을 넣지 않는다 — 아래 참조) |

전부 다시 적용하려면 `docker compose down -v && docker compose up -d`.

`db/migrations/`는 **자동 적용되지 않는다**(엔트리포인트가 하위 디렉터리를 건너뛴다).
데이터가 이미 든 DB를 최신 스키마와 맞출 때만 손으로 적용한다 — 새로 시작하는
환경은 `01_schema.sql`에 전부 반영돼 있으므로 볼 필요가 없다.

### 2) 환경 변수

```bash
cp backend/.env.example        backend/.env
cp frontend/.env.local.example frontend/.env.local
```

```powershell
# Windows PowerShell
copy backend\.env.example        backend\.env
copy frontend\.env.local.example frontend\.env.local
```

백엔드 필수 4종 — `DATABASE_URL` · `DATABASE_WORKER_URL` · `JWT_SECRET` ·
`UPSTAGE_API_KEY`. 프론트는 `NEXT_PUBLIC_API_BASE_URL` 하나뿐이다.

> 팀에서 `.env`를 통째로 공유해도 된다 — DSN이 `localhost:5433`(docker compose와
> 동일)이고 절대 경로가 없어 그대로 돈다. 다만 **`JWT_SECRET`은 각자 바꾸는 것을
> 권한다**: 기본값이면 누구나 토큰을 위조할 수 있고, 공유된 값도 같은 문제를
> 가진다(`/health/config`의 `secret_is_default`로 확인).

> **⚠️ `.env` 위치**: 백엔드는 **`backend/.env`**를 읽는다 (저장소 루트 아님 —
> `backend/app/config.py`의 `BACKEND_ENV`). 루트에 두면 값이 하나도 안 읽히는데
> **서버는 정상 부팅하므로** 원인을 찾기 어렵다.

### 3) 실행

```bash
cd backend
uv sync --group dev                  # uv.lock 기준(버전 고정)
uv run uvicorn app.main:app --reload --port 8000

cd frontend                          # 다른 터미널
npm ci
npm run dev                          # http://localhost:3000
```

### 4) 계정 만들기

**시드 계정이 없다.** 빈 상태로 시작해 직접 만든다.

- **학생·교사** — <http://localhost:3000/signup> 에서 역할을 골라 가입
- **관리자** — 가입 폼으로는 얻을 수 없다(권한 상승 차단). CLI로 만든다:

```bash
cd backend
uv run python -m app.cli create-user admin@example.com <비밀번호> --role admin
uv run python -m app.cli grant-admin someone@example.com   # 기존 계정 승격
uv run python -m app.cli list-users
```

### 5) 설정 확인

서버를 띄운 뒤 **<http://localhost:8000/health/config>** 를 연다.

```jsonc
{
  "ready": true,        // ← 채팅 한 턴에 필요한 설정이 모두 갖춰짐
  "blocking": [],       // ← 비어 있어야 정상. 남아 있으면 그게 빠진 것
  "auth": { "secret_is_default": true }   // 운영 전 JWT_SECRET 교체
}
```

비밀값은 노출되지 않는다(존재 여부만). 부팅 시 터미널에도 같은 요약이 찍힌다.

---

## 서버 배포 (D116)

**배포 서버는 컨테이너를 못 쓴다.** 유일한 서버가 `CAP_SYS_ADMIN`·`CAP_NET_ADMIN`이
바운딩 셋에서 빠진 샌드박스라 docker도 rootless(podman)도 불가능하다 —
설치로 해결되는 문제가 아니다. 그래서 **supervisor로 프로세스를 띄운다.**

절차·운영 명령·고장 대처는 전부 **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**와
[`deploy/`](deploy/)에 있다. 요약하면:

```bash
deploy/bootstrap.sh    # 새 인스턴스 최초 1회 — 런타임·DB·모델·바이너리 전부
deploy/deploy.sh       # 이후 배포 — 빌드 → 마이그레이션 → 재시작
```

평소에는 사람이 칠 일이 없다. **main에 push하면 GitHub Actions가 자동 배포한다**
(self-hosted 러너 → rsync → `deploy.sh`). dev는 배포하지 않는다.

로컬 개발과의 차이는 세 가지다 — 인프라를 컨테이너가 아니라 프로세스로 띄우고,
프론트가 `next start`(프로덕션 빌드)라 핫 리로드가 없고, 교과서 도판 비전
판정을 **서버 GPU에서 직접 돌린다**(D118 — llama.cpp + EXAONE-4.5-33B).
나머지 명령·환경변수·포트는 같다.

---

## 주요 기능

- **개념 캔버스** — pan/zoom 무한 캔버스에 개념 카드를 손글씨 스타일로 배치.
  `(app)/space/[spaceId]`.
- **ReAct 스킬 루프** — 모델이 필요할 때만 도구를 부른다(D109). 인사 한 마디에
  임베딩·벡터 검색이 나가지 않는다. 스킬 9종은 `backend/app/ai/skills/`에 파일
  하나씩이고, 노출 목록은 (공간·역할·세션 상태)로 먼저 좁힌다.
- **운영 콘솔** — `/admin` (관리자 전용, 9탭). 개요·AI 흐름·대화 기록·턴 로그·
  스킬·문서 인제스트·RAG 테스트·런타임 설정·데이터 백업/초기화. 턴마다 어떤
  스킬을 어떤 인자로 불렀고 토큰을 얼마나 썼는지까지 본다(D113/D114).
- **태그 기반 배치** — 모델이 개념마다 자유 태그(단원·주제 수준)를 붙이고,
  프론트가 태그 첫 등장 순서로 황금각 슬롯 앵커를 부여해 묶는다(D89/D90).
- **선생님 워크스페이스** — 학급 개설, 수업 자료(`class_material`)·교과서
  (`textbook`) 업로드. 자료는 청킹 → 임베딩 → Qdrant로 RAG 구축.
- **학생 세션 파일** — 학생이 올린 파일(`user_upload`)은 임베딩 없이 청킹만 하고
  **세션 컨텍스트로 전문 주입**한다(D83~D85, 기본 예산 150K자).
- **교과서 figure** — 교과서 PDF에서 도판을 추출해 캡션을 확정하고, 학생 질의와
  가까운 도판을 캔버스에 FigureNode로 띄운다(D93/D95).
  > **비전 판정(EXAONE)은 현재 꺼져 있다** — `JUDGE_*`를 비워 둔 임시 상태다.
  > 파서가 `caption`/`footnote`로 라벨한 도판은 그대로 처리되고, 라벨 없는
  > 도판만 처리되지 않는다. 되살리려면 두 값을 채운다
  > ([보고서 §5](docs/CHANGELOG-D104-D114.md#5-대화-생성-모델-교체-d108)).
- **인증/권한** — 이메일/비밀번호 자체 회원가입·로그인(D99), 역할
  (student/teacher/admin), 개인(personal)·학급(class) 스코프, RLS로 접근 제어.
  가입 시 고른 역할은 `student`·`teacher`만 허용되며 `admin`은 승격으로만 부여된다.

---

## 아키텍처

```
프론트(Next.js, (app)/space/[spaceId])
  ConceptCanvasWorkspace = NoteCanvas + ConceptCard + FigureNode
  useConceptStream: POST /chat/stream(SSE) 한 번 → 개념 스트리밍 → d3-force 배치
                    (D111: 선행 /retrieve 호출 없음 — 검색은 서버가 판단해서 한다)
        │
백엔드(FastAPI)
  ai/                       ReAct 스킬 루프 — 도구 판단 → 스킬 실행 → 생성 (D109)
    catalog.py              (공간·역할·세션 상태)로 노출 도구를 먼저 좁힌다
    skills/                 스킬 하나가 파일 하나 (9종)
  services/solar.py         대화 생성(Upstage solar-pro2, 스트리밍 + tool calling)
  services/upstage.py       임베딩(embedding-query/passage, 1024d) + 문서 파싱
  services/qdrant_store.py  컬렉션 file_chunks / textbook_figures
  services/figure_*.py      교과서 도판 추출·비전 판정
  services/worker/          업로드 → 청킹 → 임베딩 잡 (앱 프로세스 안에서 돈다)
        │
Postgres(관계형 + RLS + 자체 인증 + 파일)  ·  Qdrant(벡터만; RLS 없음 → 앱이 스코프 강제)
```

**불변식** (자세히는 [`CLAUDE.md`](CLAUDE.md)):

- RAG는 채팅을 절대 막지 않는다 — 모든 컨텍스트 빌더는 best-effort.
- Qdrant는 신뢰 경계가 아니다 — 청크 본문은 USER 스코프 Postgres로 재조회해
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
│  ├─ app/ai/                ReAct 스킬 루프 (catalog·registry·orchestrator·skills/)
│  ├─ app/services/          solar·upstage·qdrant_store·worker/·figure_*·admin_* …
│  ├─ app/routers/           chat·files·sessions·teacher·admin·home·me·health
│  └─ tests/                 pytest (전부 mock — 외부 호출·원격 DB 없음)
├─ db/                       스키마·RLS 정책·함수 (00~04) + migrations/(수동 적용)
├─ docs/                     TASKS·AGENTS·PROCESS·DEPLOYMENT + superpowers/{specs,plans}
└─ docker-compose.yml        qdrant 서비스
```

---

## 검증

```bash
# 백엔드 테스트 + 린트 (전부 mock — 키·네트워크 불필요)
cd backend && uv run pytest tests/ -q && uv run ruff check app tests

# 프론트 테스트 + 타입 + 빌드 스모크
cd frontend && npm test -- --run && npx tsc --noEmit && npm run lint && npm run build
```

> ⚠️ **dev 서버를 띄운 채 `npm run build`를 돌리지 말 것.** 둘이 같은 `.next/`를
> 쓰기 때문에 dev 쪽 청크가 깨져, 소스에 없는 식별자로 `ReferenceError`가 나는
> 유령 증상이 생긴다. 빌드했으면 dev 서버를 재시작한다.

두 가지는 CI(`.github/workflows/ci.yml`)에서도 돌지만, **PR 올리기 전에 로컬에서
먼저 통과시킨다.**

---


## 데이터베이스

스키마는 `db/`의 SQL 5개다. 마이그레이션 번호 대신 **현재 상태 하나**를 둔다
(D104: 구 마이그레이션 0001~0042를 `pg_dump`로 스쿼시 — 절반이 생성 후 삭제된
것이라 이력 가치보다 죽은 코드 비용이 컸다).

### 권한은 DB가 강제한다

RLS 정책 38개 + 함수 26개가 "누가 무엇에 접근 가능한가"를 정의한다. **앱 코드가
실수해도 남의 데이터가 나오지 않는다.**

동작 방식:

```
요청 → nodi_app 역할로 트랜잭션 시작
     → SET LOCAL app.user_id = '<사용자 uuid>'
     → auth.uid()가 그 값을 돌려주고, 정책들이 그걸로 판정
```

`SET LOCAL`은 트랜잭션 스코프라 커밋 시 사라진다 — 커넥션 풀에서 앞 요청의
사용자 컨텍스트가 남는 사고가 구조적으로 불가능하다.

| 역할 | RLS | 용도 |
|---|---|---|
| `nodi_app` | 적용 | 사용자 요청 (`UserClient`) |
| `nodi_worker` | BYPASSRLS | 백그라운드 워커·인증 (`ServiceClient`) |

`public.users`(비밀번호 해시)는 `nodi_app`에 **GRANT 자체를 주지 않는다** —
정책보다 앞선 단계에서 막히므로 정책을 잘못 써도 해시가 노출되지 않는다.

### 스키마를 바꿀 때

`db/01_schema.sql`을 직접 수정하고 `docker compose down -v && up -d`로 재적용한다.
운영 DB가 생기면 그때 마이그레이션 도구를 도입한다 — 지금은 로컬 전용이라
파일 하나가 더 명확하다.

> ⚠️ **`down -v`는 데이터를 지운다.** 계정도 함께 사라지므로 다시 만들어야 한다.

**데이터를 지우고 싶지 않다면** `db/migrations/`의 스크립트를 손으로 적용한다.
자동 적용되지 않으며(엔트리포인트가 하위 디렉터리를 건너뛴다) 전부 멱등이다.
어떤 것을 언제 적용해야 하는지는
[`docs/CHANGELOG-D104-D114.md` §10](docs/CHANGELOG-D104-D114.md#10-db-변경-총괄)
에 정리해 두었다.

---

## 컨벤션

- 주석·docstring·커밋 메시지는 **한국어**, 제약·근거 위주.
- 커밋 프리픽스 `[feat]:` / `[fix]:` / `[docs]:` / `[tune]:` / `[chore]:`
- 설계 결정은 **D-번호**(D93, D97 …)로 코드 주석에 남긴다.
- 스펙은 `docs/superpowers/specs/`, 구현 계획은 `docs/superpowers/plans/`.
- `.env`·`qdrant_storage/`·`.claude/`는 커밋 금지(`.gitignore`).
- **`main` 직접 작업 금지.** 작업 브랜치는 `dev`.

