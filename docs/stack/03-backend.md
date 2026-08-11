# 03 · 백엔드

## 무엇을 쓰나

| 이름 | 하는 일 |
| --- | --- |
| Python ≥3.11 · uv | 런타임 · 의존성(`uv.lock` 고정) |
| FastAPI ≥0.115 | 라우팅 · 의존성 주입 · 검증 |
| uvicorn[standard] | ASGI 서버 |
| asyncpg ≥0.30 | Postgres 드라이버 (**ORM 없음**) |
| pydantic ≥2.7 · pydantic-settings | 모델 · 설정 |
| pyjwt · bcrypt | 자체 인증 |
| qdrant-client ≥1.10 | 벡터 |
| httpx | 외부 모델 호출 |
| apscheduler | 주기 작업(보존 정리 등) |
| pypdf · fonttools[woff] | PDF · 폰트 서브셋 |
| pytest · pytest-asyncio · ruff | 테스트 · 린트 |

**ORM을 안 쓴다.** 권한이 RLS에 있어서 쿼리가 어떤 커넥션으로 나가는지가
정확해야 하는데, ORM은 그 경계를 흐린다.

## 폴더

```
app/
  routers/     15개 — 창구. 얇게 두고 판단은 services로
  services/    36개 — 도메인 로직
    worker/    10개 — 백그라운드 잡(인제스트·임베딩·교차연결·보존)
  ai/
    catalog.py     (공간, 역할, 세션 상태)로 도구를 **먼저 좁힌다**
    orchestrator.py 도구 판단 → 스킬 실행 → 생성
    skills/         스킬 11종 — 파일 9개(가까운 것끼리 한 파일)
  db/
    pool.py    ⚠️ 커넥션을 얻는 **유일한 길**
    client.py  UserClient/ServiceClient — PostgREST 문법 → SQL
    query.py   그 변환기(순수 함수, 테스트 30개)
  auth/        JWT 발급·검증 · 이메일 정규화
```

## 권한 — 이 코드베이스에서 가장 중요한 규약

```python
async with user_conn(user_id) as conn:   # 트랜잭션 + SET LOCAL app.user_id
    ...
```

- 사용자 요청은 `nodi_app` 역할로 돌고, `auth.uid()`가 그 값을 읽어 정책이
  판정한다. 워커는 `nodi_worker`(BYPASSRLS).
- ⚠️ **직접 커넥션을 얻지 않는다.** `user_conn()`이 트랜잭션과 컨텍스트 주입을
  한 묶음으로 보장한다 — 우회하면 **앞 요청의 사용자로 질의가 나갈 수 있다**.
- 비밀번호 해시가 든 `public.users`는 `nodi_app`에 GRANT 자체가 없다. 정책보다
  앞선 방어다.

### RLS가 조용히 틀리는 방식

정책에 걸린 UPDATE·DELETE는 **오류가 아니라 0행**으로 끝난다. 그래서 쓰기 뒤에는
**행을 세야** 한다 — 안 세면 창구가 200/204를 돌려주고 화면이 거짓말을 한다
(실제로 사진이 안 바뀌고, 지운 방이 새로고침에 되살아났다, D219).

## 질의 변환기

`db/query.py`가 PostgREST 스타일 파라미터를 SQL로 옮긴다. 지원하는 문법만 받고
**모르는 것은 조용히 무시하지 않고 예외로 드러낸다** — 필터 하나를 놓치면 남의
데이터가 반환되기 때문이다.

| 문법 | SQL |
| --- | --- |
| `eq/neq/gte/gt/lte/lt` | 비교 |
| `in.(a,b,c)` | `= ANY($n)` · 빈 IN은 `false`(전체 반환 금지) |
| `is.null` / `is.true` | `IS NULL` / `IS true` |
| `not.is.null` | `IS NOT NULL` (부정은 `is`만 받는다) |
| `ilike.말` | `ILIKE '%말%'` — 값은 언제나 파라미터 |
| `before.<초>` | `< now() - make_interval(...)` — **시간 계산은 DB에서** |

## 워커

폴링 방식. `jobs` 표에서 뽑아 종류별 처리기로 보낸다.

| 잡 | 하는 일 |
| --- | --- |
| `embedding_split` | 파싱 → 청킹 → 배치 팬아웃 |
| `embedding_batch` | 청크 임베딩 → Qdrant |
| `figure_batch` | 교과서 도판 크롭 → 비전 캡션 → 임베딩 |
| `atom_batch` | 청크당 예상 질문 생성(PIKE) |
| `lecture_embed` / `lecture_atom` | 강의 클립 임베딩 · 원자화 |
| `crosslink` | 교차 세션 개념 연결 판정 |

**급한 잡이 먼저다**(D188): 교과서 하나에 텍스트 잡 5개와 도판 잡 86개가 같은
순간에 생기는데, `created_at`만 보면 동점이라 도판이 계속 이겼다 — 도판 캡션이
다 끝날 때까지 **본문이 한 글자도 검색되지 않았다**(실측 20분).

⚠️ **`lecture_parse` 잡은 없다**(D221). EBS 파싱·전사는 저장소 밖 오프라인
스크립트가 하고, 관리자가 그 결과 파일을 올리면 클립 행이 바로 만들어진다.

### 격리 규칙

도판·원자·강의 실패는 **`files.status`를 절대 안 건드린다**(D88). 곁들이가
실패했다고 본문 검색이 막히면 안 된다.

## 보존

진단용 표(`jobs` 14일 · `crosslink_runs` 30일 · `ai_logs` 30일)를 하루 한 번
정리한다. ⚠️ 한 번에 2,000행씩 **최대 20번** 이어서 지운다 — 한 번만 지우면
하루 유입이 그보다 많아지는 순간부터 영영 못 따라잡고 표가 **조용히** 는다.
상한까지 차면 경고를 남긴다.

## 튜너블 (D62)

70개 · 15그룹. 우선순위는 **admin 오버레이(`app_settings`) > config 기본값**.

⚠️ 기본값을 바꿀 때는 **코드·`db/03_app_settings.sql`·마이그레이션** 셋을 함께
옮긴다. 코드만 고치면 이미 돌고 있는 DB에서는 아무 일도 일어나지 않는다.

⚠️ 새 그룹을 만들면 `_GROUP_ORDER`에도 넣는다 — 스펙에만 있고 순서에 없으면
콘솔 어디에도 안 뜬다(테스트가 잡는다).

## 검사

```bash
cd backend
uv sync --group dev
uv run pytest tests/ -q        # 811
uv run ruff check app/ tests/
```

전부 mock이라 키·네트워크가 필요 없다.
