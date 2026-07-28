# D113 · D114 — 운영 콘솔과 데이터 관리 (2026-07-28)

> **팀원이라면 이 문서를 먼저 읽으세요.** 이번 변경으로 관리자 페이지가 3탭에서
> 9탭이 됐고, DB 스키마·API·프론트가 함께 바뀌었습니다. 특히 **이미 데이터가 든
> DB를 쓰고 있다면 마이그레이션을 손으로 적용해야 합니다**(§7).

커밋 `a727713`…`8e7a516` (8개, 39개 파일).

---

## 1. 무엇이 달라졌나 — 한눈에

| | 이전 | 이후 |
|---|---|---|
| 관리자 탭 | 권한 · 설정 · 로그 (3) | 개요 · AI 흐름 · 대화 · 턴 로그 · 스킬 · 문서 · RAG 테스트 · 설정 · 데이터 · 권한 (10) |
| 토큰 사용량 | 글자수÷4 어림만 | **공급자 실측**(단계별·캐시 히트 포함) |
| 스킬 관측 | 이름 목록만 | 인자 · 결과 · 소요시간 · 흐름 위 실행 여부 |
| 대화 열람 | 턴 단위 로그만 | **세션 단위 대화 뷰어**(전체 사용자) |
| 문서 | 목록뿐 | 인제스트 현황 · 청크 원문 · 잡 이력 |
| RAG 튜닝 | 값만 바꾸고 채팅으로 확인 | 게이트 통과/차단을 거리와 함께 보는 테스트 콘솔 |
| 데이터 관리 | 없음 | 백업 · 복원 · 초기화 |
| RLS 정책 / DB 함수 | 32 / 19 | **38 / 26** |

---

## 2. 관리자 콘솔 (D113)

`/admin`, 관리자 전용. 탭 순서는 "무슨 일이 일어나는가 → 왜 그렇게 되는가 →
무엇을 바꾸는가".

- **개요** — 사용자·세션·문서·청크·잡·턴 카운터, 실측 토큰 합계와 캐시 히트율,
  지연 p50/p95, **환경**(기동 시 결정된 값 — 모델·DSN 호스트·Qdrant·저장소).
- **AI 흐름** — 채팅 한 턴의 파이프라인 그래프. 단계마다 코드 위치·걸린 튜너블·
  설계 이유. 꺼진 경로(레거시)도 흐리게 함께 그린다.
- **대화** — 모든 사용자의 대화를 **세션 단위**로. 열면 말풍선 순서로 이어지고,
  턴마다 "이 답이 나온 과정"을 접어 둔다.
- **턴 로그** — 턴 단위 모니터 + 상세. 상세 맨 위에 **"이 턴의 흐름"**이 있어
  AI 흐름과 같은 그림 위에 이 턴이 어디를 탔는지 보여준다.
- **스킬** — 등록 스킬 9종, 노출 조합, 인자 스키마, 실사용 통계.
- **문서** — 인제스트 현황(청크 행 수·임베딩 성공·도판), 상세에서 청크 원문과
  잡 이력.
- **RAG 테스트** — 실제 검색 경로를 그대로 태우되 게이트에 걸린 청크도 보여준다.
- **설정** — 튜너블 전체(현재값·기본값·변경 여부·반영 시점), 저장·기본값 복귀.
- **데이터** — 백업·복원·초기화 (§3).
- **권한** — 기존 역할 관리.

### 설계상 지킨 것

**어림을 실측 자리에 앉히지 않는다.** `token_estimate`는 `글자수/4` 휴리스틱인데
한국어에서 크게 빗나간다 — 같은 턴 실측 결과 **어림 604 vs 실측 2,731**(4.5배).
`ai_logs.tokens`에는 공급자 usage만 담고, 실측이 없는 턴은 화면에 "실측 없음"이라
쓴다. 어림은 `token_estimate` 칸에 그대로 둔다.

> 스트리밍은 `stream_options.include_usage=true`를 붙여야 usage가 온다(실측 확인).
> 덤으로 `cached_tokens`가 와서 프리픽스 캐시가 먹는지 볼 수 있다.

**게이트는 필터가 아니라 표시.** RAG 테스트는 채팅과 **같은 함수**(`rag.search`)를
쓴다 — 테스트 전용 사본을 만들면 사본만 맞고 실제 경로는 다른 상황이 된다. 다른
점은 잘린 청크를 지우지 않고 거리와 함께 보여주는 것뿐이다.

**흐름 그림은 서버가 만든다.** 스킬 이름·활성 경로를 프론트에 적어 두면 코드가
바뀔 때 그림만 옛말이 된다. `services/admin_console.flow_spec()`이 레지스트리와
설정에서 끌어온다.

**튜너블 스펙의 소유자는 서버.** 기본값이 `config.py`에 있으니 라벨·범위·설명도
옆에 둔다(`services/admin_console.py`). 노브를 추가할 때 서버·DB·프론트가
어긋나는 것을 막는다. `app_settings`에 **행이 없는 키도 함께 내보내고**
`missing_row`로 드러낸다 — 행이 없으면 조정 자체가 불가능한데 조용히 안 보이면
알 수 없다.

**권한은 계속 DB가 강제한다.** 콘솔이 넓게 본다고 service_role을 쓰지 않는다.
관리자 본인 JWT로 돌고, 읽기 전용 admin 정책 6개를 추가했다(nodes · files ·
file_chunks · textbook_figures · classes · class_members). 집계·삭제·복원 RPC도
함수 안에서 `is_admin()`을 확인한다.

---

## 3. 데이터 백업 · 복원 · 초기화 (D114)

셋을 한 화면에 둔다 — **백업 없는 초기화는 기능이 아니라 사고다.**

스냅샷은 JSON 한 파일이고 `backend/.storage/backups/`에 쌓인다. 스코프는
`conversations` · `documents` · `people` · `settings`.

**의도적으로 막아 둔 것 두 가지:**

- **`documents`는 복원 대상이 아니다.** 스냅샷에 원본 파일 바이트도 Qdrant
  벡터도 없어서, 행만 되살리면 본문도 검색도 없는 껍데기가 남는다. 백업에는
  감사용으로 담되 복원 목록에서 빼고 화면에 그 이유를 쓴다.
- **`people`(계정·학급)은 초기화 대상이 아니다.** 계정을 지우면 그 사람의 모든
  것이 CASCADE로 사라지고 되돌릴 수 없다. 권한 탭에서 하나씩 다룬다.

**안전장치:** 확인 문구(`초기화합니다`)를 정확히 입력해야 하고, 기본값이 "지우기
전 자동 백업"이며 **백업이 실패하면 지우지 않는다.** 백업 이름은 화이트리스트
정규식 + 경계 재확인 2중으로 디렉터리 탈출을 막는다(이름이 URL로 들어온다).

**복원은 덮어쓰지 않는다.** 같은 id가 이미 있으면 건너뛴다 — 덮어쓰면 "복원했더니
최근 게 사라졌다"가 된다. 설정만 예외(유효한 값이 하나뿐이라 건너뛰면 아무 일도
안 하는 것과 같다).

문서 삭제는 SQL이 아니라 파일마다 기존 `files.delete_file`을 부른다. 느리지만
그래야 Storage 원본·도판 크롭·**Qdrant 벡터**가 함께 정리된다. 행만 지우면 검색
인덱스에 유령이 남아 지운 자료가 계속 근거로 붙는다.

> ⚠️ **스냅샷에는 학생 대화 원문이 그대로 들어 있다.** 서버 안에만 두고, 내려받은
> 파일을 외부로 옮길 때는 그 내용도 함께 나간다는 점을 염두에 둘 것.

---

## 4. DB 변경

### `ai_logs` 관측 컬럼 4개

| 컬럼 | 내용 |
|---|---|
| `tokens` jsonb | 공급자 **실측** usage. `{prompt, completion, total, cached, calls:[{stage,...}]}`. 측정된 호출이 없으면 `{}` |
| `route` text | `react` \| `legacy` — 어느 경로로 돈 턴인지 |
| `model` text | 사용한 모델 |
| `duration_ms` int | 턴 전체 소요 |

`skill_calls`는 칸은 그대로지만 내용이 풍부해졌다 — 스킬마다 인자·결과·성공
여부·소요시간이 들어간다(결과는 4,000자 상한, 자르면 `_truncated`로 알린다).

### 정책 6개 · 함수 7개 추가

읽기 전용 admin 정책: `nodes` · `files` · `file_chunks` · `textbook_figures` ·
`classes` · `class_members`.

새 함수: `admin_overview` · `admin_conversations` · `admin_documents` ·
`admin_skill_usage` · `admin_purge_conversations` · `admin_restore_conversations` ·
`admin_restore_settings`. `delete_file_cascade`는 관리자도 호출할 수 있게 넓혔다.

---

## 5. 이번에 발견해 고친 결함

| 무엇 | 어떻게 드러났나 |
|---|---|
| **관리자가 학급을 하나도 못 봄** | RAG 테스트 범위를 고르려는데 목록이 0건. `classes`에 "담임이거나 구성원" 정책만 있었다 |
| **기록은 하는데 조회하지 않던 컬럼** | 화면에서 턴 배지가 이상해 발견. `ai_logs`에 컬럼을 넣고 select 문자열을 안 늘려 DB엔 있는데 화면엔 없었다 |
| **토글 손잡이가 트랙 밖으로 14px** | `left` 미지정 → button의 기본 `text-align:center`가 정적 위치를 중앙(18px)으로 만들고 translate가 더해졌다. D113 이전부터 있던 버그 |
| **저장 버튼이 눌리지 않는데 주 동작처럼 보임** | 금색 배경에 `opacity-50`만 걸려 탁한 덩어리가 됐다 |
| **백업이 통째로 502** | `class_members.joined_at`이 있을 거라 짐작하고 적었는데 실제로는 `created_at` |
| **README가 없는 키를 요구** | 필수에 `EXAONE_API_KEY`가 적혀 있었는데 `config.py`에 아예 없다(D108) |

각 항목에는 회귀 테스트를 붙였다. 특히:

- `TurnLog.to_row()`가 쓰는 컬럼이 전부 조회 select에 있는지 대조
- 백업이 읽는 모든 컬럼이 `db/01_schema.sql`에 실재하는지 대조 (DB 없이 검증)

---

## 6. 오탐이었던 것 (기록으로 남김)

실브라우저 점검 중 캔버스에서 `ReferenceError: sig is not defined` 등이 보였다.
소스에 `sig`는 존재하지도 않고 `emitBody`는 호이스팅된 함수 선언이라 "not
defined"가 나올 수 없다 — **`npm run build`가 dev 서버의 `.next/`를 덮어써서**
생긴 잔재였다. dev 서버를 재시작하니 사라졌다.

> **dev 서버를 띄운 채 `npm run build`를 돌리지 말 것.** 빌드했으면 dev 서버를
> 재시작한다. (README 검증 절에도 적어 두었다.)

---

## 7. 팀원이 해야 할 일

### 새로 시작하는 경우 — 할 일 없음

`db/01_schema.sql`에 전부 반영돼 있다. `docker compose up -d` 하면 끝이다.
`db/migrations/`는 **자동 적용되지 않으며 볼 필요도 없다.**

### 이미 데이터가 든 DB를 쓰는 경우 — 마이그레이션 3개를 손으로 적용

```bash
cd Nodi
docker exec -i nodi-postgres-1 psql -U postgres -d nodi \
  < db/migrations/2026-07-28-d113-admin-observability.sql
docker exec -i nodi-postgres-1 psql -U postgres -d nodi \
  < db/migrations/2026-07-28-d113-admin-console-rpc.sql
docker exec -i nodi-postgres-1 psql -U postgres -d nodi \
  < db/migrations/2026-07-28-d114-backup-purge.sql
```

전부 멱등이라 여러 번 돌려도 안전하다. 적용 후 확인:

```sql
select count(*) from pg_policies where schemaname='public';   -- 38
```

### 관리자 계정이 필요하다

콘솔은 `admin` 역할만 들어간다. 가입 폼으로는 얻을 수 없다:

```bash
cd backend
uv run python -m app.cli create-user you@example.com <비밀번호> --role admin
# 또는 기존 계정 승격
uv run python -m app.cli grant-admin you@example.com
```

### 프론트 의존성

새로 추가한 패키지는 없다. `npm ci`만 하면 된다.

---

## 8. 관련 문서

- 규범·불변식: [`../CLAUDE.md`](../CLAUDE.md)
- 설치·실행: [`../README.md`](../README.md)
- 배포: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- API 목록(Admin 절은 이번에 갱신): [`../backend/README.md`](../backend/README.md)
