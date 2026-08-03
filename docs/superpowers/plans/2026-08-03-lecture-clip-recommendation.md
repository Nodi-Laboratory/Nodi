# 강의 클립(숏폼) 추천 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 (학년·과목) 강의 추천 패키지에 EBS 링크를 넣으면 챕터(타임라인+제목)를 파싱·임베딩하고, 선생님이 워크스페이스에서 켜면 학생 질의에 ReAct 스킬이 관련 강의 클립을 캔버스에 추천한다.

**Architecture:** `textbook_figures` 골격을 미러한 admin 전역 카탈로그. 새 테이블 `lecture_packages/videos/clips` + 워크스페이스 선택 `class_lecture_packages`. 워커 잡 `lecture_parse`(EBS HTML GET+파싱→클립 행) → `lecture_embed`(제목 임베딩→Qdrant `lecture_clips`). 검색 `lecture_search`는 켠 패키지의 `package_id`로 스코프. ReAct 스킬 `search_lecture_clip`이 done 이벤트에 `clips`를 실어 프론트 `ClipItem` 카드로 배치.

**Tech Stack:** FastAPI · asyncpg(RLS) · Qdrant(1024d/Cosine) · Upstage embedding-passage/query · httpx(EBS GET) · stdlib html.parser(챕터 파싱) · Next.js(App Router) · React Query.

## Global Constraints

- **EBS 전용, 폴백 없음** — 자막 청킹·요약·유튜브/메가스터디 파서는 만들지 않는다. 챕터가 없는 영상은 파싱 실패(`lecture_videos.status='failed'`).
- **딥링크 seek 안 함** — 추천 카드는 공식 EBS **페이지 링크**(`page_url`)를 새 탭으로 열고, 타임라인 시각은 텍스트로만 보여준다. MP4 핫링크·`#t=`·헤드리스 브라우저 없음.
- **Qdrant 페이로드는 식별자만** — `{clip_id, video_id, package_id}`. 제목·URL·시각 금지. 히트 후 Postgres 재조회.
- **거리 규약** `distance = 1 - score`. **임베딩 비대칭** — 질의 `embedding-query`, 문서 `embedding-passage`.
- **RAG는 채팅을 막지 않는다** — 검색·파싱 실패는 `[]`/행 격리. 강의 클립 실패는 다른 인제스트(파일·figure)와 격리(D88 동형): `files.status` 절대 안 건드림.
- **튜너블은 3곳 동기(D62)** — `backend/app/config.py` 기본값 + `db/03_app_settings.sql` INSERT + `backend/app/services/admin_console.py` 위젯 스펙. 스키마 변경은 **`db/01_schema.sql`(신규 볼륨)과 `db/migrations/`(기 기동 DB) 이중 반영**.
- **마이그레이션은 멱등** — `begin;`/`commit;`, `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS`→`CREATE POLICY`, 명시 `GRANT`. `deploy.sh`가 매 배포 재적용. **원격 DB 적용은 별도 사용자 승인** 후.
- **권한은 RLS가 강제(D104)** — admin은 본인 JWT(`UserClient`, nodi_app 역할)로 admin 정책을 탄다. 잡 en큐만 `ServiceClient`(워커 DSN). 직접 커넥션 금지.
- **주석·커밋 한국어**, 설계 결정은 D-번호. 커밋 프리픽스 `[feat]:`/`[fix]:`/`[docs]:`/`[tune]:`. 커밋 트레일러는 저장소 관례를 따른다.
- **테스트**: 백엔드 `cd backend && uv run pytest tests/ -v`(전부 mock). 프론트 `cd frontend && npx tsc --noEmit && npm run build`, 순수 함수는 `npm test`(vitest).
- **API 경로는 `/api` 접두사** — 라우터 prefix + main.py의 `/api`.
- 이 기능의 D-번호는 **D147**로 통일해 코드 주석·커밋에 남긴다.

---

## Task 1: DB 스키마 — 테이블·RLS·GRANT·jobs.kind 확장

**Files:**
- Create: `db/migrations/2026-08-03-d147-lecture-clips.sql`
- Modify: `db/01_schema.sql` (신규 볼륨 반영 — 테이블 DDL·RLS·GRANT·jobs_kind_check)
- Test: `backend/tests/test_lecture_schema.py`

**Interfaces:**
- Produces: 테이블 `lecture_packages(id,grade,subject,title,created_by,created_at)`,
  `lecture_videos(id,package_id,source,page_url,title,status,error,created_at)`,
  `lecture_clips(id,video_id,seq,start_sec,title,status,created_at)`,
  `class_lecture_packages(class_id,package_id,created_at)`. jobs.kind에 `lecture_parse`,`lecture_embed` 추가.

- [ ] **Step 1: 마이그레이션 파일 작성** — `db/migrations/2026-08-03-d147-lecture-clips.sql`:

```sql
-- D147: 강의 클립(숏폼) 추천 — admin 전역 카탈로그.
-- 멱등(deploy.sh가 매 배포 재적용). 신규 볼륨 기동은 db/01_schema.sql이 커버.
begin;

-- (학년·과목) 강의 추천 패키지 = "클립셋"
CREATE TABLE IF NOT EXISTS public.lecture_packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    grade text NOT NULL,
    subject text NOT NULL,
    title text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz DEFAULT now() NOT NULL
);

-- 패키지에 속한 EBS 영상(admin이 링크·제목 입력)
CREATE TABLE IF NOT EXISTS public.lecture_videos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    source text DEFAULT 'ebs'::text NOT NULL,
    page_url text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_videos_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'parsing'::text,'parsed'::text,'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_lecture_videos_package ON public.lecture_videos (package_id);

-- 챕터 = 클립. 임베딩 텍스트는 title. 타임라인 라벨은 start_sec에서 파생(비저장).
CREATE TABLE IF NOT EXISTS public.lecture_clips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL REFERENCES public.lecture_videos(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    start_sec integer NOT NULL,
    title text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_clips_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'embedded'::text,'failed'::text]))),
    CONSTRAINT lecture_clips_video_seq_key UNIQUE (video_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_lecture_clips_video ON public.lecture_clips (video_id, status);

-- 선생님이 워크스페이스에 켠 패키지
CREATE TABLE IF NOT EXISTS public.class_lecture_packages (
    class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (class_id, package_id)
);

-- jobs.kind 확장 (drop→add는 그 자체로 멱등)
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK
  ((kind = ANY (ARRAY['embedding_split'::text,'embedding_batch'::text,'figure_batch'::text,
                      'atom_batch'::text,'lecture_parse'::text,'lecture_embed'::text])));

-- RLS: 카탈로그는 전역 콘텐츠 — 인증 사용자 읽기, admin 쓰기. 워커(BYPASSRLS) 인제스트.
ALTER TABLE public.lecture_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_packages_select ON public.lecture_packages;
CREATE POLICY lecture_packages_select ON public.lecture_packages FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_packages_admin ON public.lecture_packages;
CREATE POLICY lecture_packages_admin ON public.lecture_packages FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.lecture_videos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_videos_select ON public.lecture_videos;
CREATE POLICY lecture_videos_select ON public.lecture_videos FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_videos_admin ON public.lecture_videos;
CREATE POLICY lecture_videos_admin ON public.lecture_videos FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.lecture_clips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_clips_select ON public.lecture_clips;
CREATE POLICY lecture_clips_select ON public.lecture_clips FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_clips_admin ON public.lecture_clips;
CREATE POLICY lecture_clips_admin ON public.lecture_clips FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.class_lecture_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clp_select_member ON public.class_lecture_packages;
CREATE POLICY clp_select_member ON public.class_lecture_packages FOR SELECT
  USING ((class_id IN (SELECT public.my_class_ids())) OR (SELECT public.is_admin()));
DROP POLICY IF EXISTS clp_write_teacher ON public.class_lecture_packages;
CREATE POLICY clp_write_teacher ON public.class_lecture_packages FOR ALL
  USING (class_id IN (SELECT public.my_taught_class_ids()))
  WITH CHECK (class_id IN (SELECT public.my_taught_class_ids()));

-- GRANT: admin은 nodi_app 역할로 쓰기(RLS가 is_admin 강제). 워커 full.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips TO nodi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_worker;

commit;
```

- [ ] **Step 2: `db/01_schema.sql`에 동일 반영** — 위 4개 `CREATE TABLE`(IF NOT EXISTS 없이 스키마 스타일로), 인덱스, RLS ENABLE+POLICY, GRANT를 스키마 파일의 해당 섹션(테이블은 다른 CREATE TABLE 근처, 정책은 RLS 블록, GRANT는 GRANT 블록)에 추가하고, `jobs_kind_check`의 배열에 `'lecture_parse'`,`'lecture_embed'`를 추가한다. (신규 볼륨 기동 커버용. `db/01_schema.sql:580`의 jobs_kind_check 라인을 확장.)

- [ ] **Step 3: 실패 테스트 작성** — `backend/tests/test_lecture_schema.py` (SQL 텍스트 정합성 검사, DB 없이):

```python
from pathlib import Path

MIG = Path(__file__).resolve().parents[2] / "db/migrations/2026-08-03-d147-lecture-clips.sql"
SCHEMA = Path(__file__).resolve().parents[2] / "db/01_schema.sql"

def test_migration_idempotent_and_tables():
    sql = MIG.read_text(encoding="utf-8")
    for t in ("lecture_packages", "lecture_videos", "lecture_clips", "class_lecture_packages"):
        assert f"CREATE TABLE IF NOT EXISTS public.{t}" in sql
    assert "DROP POLICY IF EXISTS" in sql
    assert "'lecture_parse'" in sql and "'lecture_embed'" in sql
    assert sql.strip().startswith("-- D147") and "begin;" in sql and "commit;" in sql

def test_schema_mirrors_migration():
    sql = SCHEMA.read_text(encoding="utf-8")
    for t in ("lecture_packages", "lecture_videos", "lecture_clips", "class_lecture_packages"):
        assert f"public.{t}" in sql
    assert "'lecture_parse'" in sql and "'lecture_embed'" in sql
```

- [ ] **Step 4: 테스트 실행** — Run: `cd backend && uv run pytest tests/test_lecture_schema.py -v` — Expected: PASS.

- [ ] **Step 5: 로컬 DB 재기동으로 스키마 검증** — Run: `cd /Users/dhkim/Desktop/ai-rookie/Nodi && docker-compose down -v && docker-compose up -d && sleep 6 && docker exec nodi-postgres-1 psql -U nodi_worker -d nodi -c "\dt public.lecture_*"` — Expected: 3개 테이블 표시. **주의: `down -v`는 계정을 지운다** — 검증 후 필요한 계정을 CLI로 재생성.

- [ ] **Step 6: Commit** — `git add db/migrations/2026-08-03-d147-lecture-clips.sql db/01_schema.sql backend/tests/test_lecture_schema.py && git commit -m "[feat]: 강의 클립 테이블·RLS·GRANT + jobs.kind 확장 (D147)"`

---

## Task 2: EBS 챕터 파서 (순수 함수)

**Files:**
- Create: `backend/app/services/lecture_parse.py`
- Create: `backend/tests/fixtures/ebs_player.html` (실제 EBS 플레이어 HTML 축약 픽스처)
- Test: `backend/tests/test_lecture_parse.py`

**Interfaces:**
- Produces: `@dataclass LectureChapter(start_sec:int, title:str)`;
  `parse_ebs_player(html:str) -> list[LectureChapter]` (정렬·중복제거된 챕터);
  `fmt_timeline(sec:int) -> str` (`896`→`"14:56"`, 1시간↑은 `"1:02:03"`).

- [ ] **Step 1: 픽스처 작성** — `backend/tests/fixtures/ebs_player.html`에 EBS 챕터 구조를 재현(최소):

```html
<html><head><title>국가대표 고교강의 EBSi</title></head><body>
<ul class="lecList">
  <li onclick="onIndex(0, true);player.Command.seek(365);hideBanner();"><span>[06:05]</span> <span>[충모쌤 Pick &amp; 꿀팁]</span></li>
  <li onclick="onIndex(1, true);player.Command.seek(553);hideBanner();"><span>[09:13]</span> 01_삼국의 경제 정책 / 02_통일신라의 수취 체제</li>
  <li onclick="onIndex(2, true);player.Command.seek(896);hideBanner();">[14:56] 03_고려의 토지 제도와 경제 생활</li>
  <li onclick="onIndex(2, true);player.Command.seek(896);hideBanner();">[14:56] 03_고려의 토지 제도와 경제 생활</li>
</ul></body></html>
```

- [ ] **Step 2: 실패 테스트 작성** — `backend/tests/test_lecture_parse.py`:

```python
from pathlib import Path
from app.services.lecture_parse import parse_ebs_player, fmt_timeline, LectureChapter

FIX = Path(__file__).parent / "fixtures/ebs_player.html"

def test_parses_chapters_sorted_deduped():
    chapters = parse_ebs_player(FIX.read_text(encoding="utf-8"))
    assert [c.start_sec for c in chapters] == [365, 553, 896]     # 중복 896 제거, 정렬
    assert chapters[0].title == "[충모쌤 Pick & 꿀팁]"            # [MM:SS] 라벨 제거
    assert chapters[2].title == "03_고려의 토지 제도와 경제 생활"

def test_no_chapters_returns_empty():
    assert parse_ebs_player("<html><body>no chapters</body></html>") == []

def test_fmt_timeline():
    assert fmt_timeline(896) == "14:56"
    assert fmt_timeline(65) == "1:05"
    assert fmt_timeline(3723) == "1:02:03"
```

- [ ] **Step 3: 테스트 실패 확인** — Run: `cd backend && uv run pytest tests/test_lecture_parse.py -v` — Expected: FAIL (ImportError).

- [ ] **Step 4: 구현** — `backend/app/services/lecture_parse.py`:

```python
"""EBS 강의 플레이어 페이지 파싱 (D147).

EBS는 챕터 목차를 초기 HTML에 서버렌더한다 — 각 항목의 onclick에
`player.Command.seek(<초>)`, 텍스트에 `[MM:SS] 제목`. 무의존성(stdlib html.parser)
으로 (시작초, 제목)만 뽑는다. 딥링크 seek은 하지 않으므로 MP4·헤드리스 불필요.
영상 제목(강의명)은 admin이 입력한다 — 여기서는 챕터만 다룬다.

EBS HTML 구조 변화에 대비해 파싱을 이 파일에 격리한다. 어떤 파싱 실패도
빈 리스트/failed로 떨어지고 추측하지 않는다.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.lecture_parse")
settings = get_settings()

_SEEK_RE = re.compile(r"player\.Command\.seek\((\d+)\)")
_LABEL_RE = re.compile(r"^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*")
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")


@dataclass
class LectureChapter:
    start_sec: int
    title: str


class _ChapterParser(HTMLParser):
    """onclick에 seek(N)이 있는 요소를 만나면 그 요소가 닫힐 때까지 텍스트를 모은다."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[tuple[int, str]] = []
        self._tag: str | None = None
        self._depth = 0
        self._sec: int | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._tag is not None:
            if tag == self._tag:
                self._depth += 1
            return
        onclick = dict(attrs).get("onclick") or ""
        m = _SEEK_RE.search(onclick)
        if m:
            self._tag, self._depth, self._sec, self._buf = tag, 1, int(m.group(1)), []

    def handle_endtag(self, tag: str) -> None:
        if self._tag is None or tag != self._tag:
            return
        self._depth -= 1
        if self._depth == 0:
            title = _LABEL_RE.sub("", " ".join(self._buf).strip()).strip()
            if self._sec is not None:
                self.rows.append((self._sec, title))
            self._tag, self._sec, self._buf = None, None, []

    def handle_data(self, data: str) -> None:
        if self._tag is not None:
            s = data.strip()
            if s:
                self._buf.append(s)


def parse_ebs_player(html: str) -> list[LectureChapter]:
    """(시작초, 제목) 챕터 목록. start_sec 기준 정렬 + 중복 제거, 빈 제목 제외."""
    p = _ChapterParser()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - 깨진 HTML도 빈 결과로 강등
        logger.warning("EBS HTML 파싱 예외 — 빈 챕터", exc_info=True)
        return []
    seen: set[int] = set()
    out: list[LectureChapter] = []
    for sec, title in sorted(p.rows, key=lambda r: r[0]):
        if sec in seen or not title:
            continue
        seen.add(sec)
        out.append(LectureChapter(start_sec=sec, title=title[:300]))
    return out


def fmt_timeline(sec: int) -> str:
    """초 → 사람이 읽는 타임라인. 1시간 미만은 M:SS, 이상은 H:MM:SS."""
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


async def fetch_ebs_html(url: str) -> str:
    """EBS 플레이어 페이지 GET(브라우저 UA). 챕터는 초기 HTML에 있어 헤드리스 불필요.

    프로덕션 서버 IP가 EBS WAF에 막힐 수 있다(로컬은 통과 확인). 막히면 예외로
    떨어지고 호출부(워커)가 video status='failed'로 격리한다.
    """
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True,
                                 headers={"User-Agent": _UA}) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.text
```

- [ ] **Step 5: 테스트 통과 확인** — Run: `cd backend && uv run pytest tests/test_lecture_parse.py -v` — Expected: PASS (3 tests).

- [ ] **Step 6: Commit** — `git add backend/app/services/lecture_parse.py backend/tests/test_lecture_parse.py backend/tests/fixtures/ebs_player.html && git commit -m "[feat]: EBS 챕터 파서 + 타임라인 포맷 (D147)"`

---

## Task 3: Qdrant `lecture_clips` 컬렉션 + 스코프 필터 일반화

**Files:**
- Modify: `backend/app/services/qdrant_store.py` (COL 상수, ensure_collections, search `scope_field`)
- Test: `backend/tests/test_qdrant_lecture.py`

**Interfaces:**
- Consumes: `qdrant_store.search(collection, vector, k, *, file_ids, score_threshold)` 기존 시그니처.
- Produces: `COL_LECTURE_CLIPS = "lecture_clips"`; `search(..., scope_field: str = "file_id")` — file_ids가 주어질 때 payload 필터 키를 `scope_field`로.

- [ ] **Step 1: 실패 테스트 작성** — `backend/tests/test_qdrant_lecture.py`:

```python
from app.services import qdrant_store

def test_collection_constant():
    assert qdrant_store.COL_LECTURE_CLIPS == "lecture_clips"

def test_search_has_scope_field_param():
    import inspect
    sig = inspect.signature(qdrant_store.search)
    assert "scope_field" in sig.parameters
    assert sig.parameters["scope_field"].default == "file_id"
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_qdrant_lecture.py -v` — Expected: FAIL (AttributeError).

- [ ] **Step 3: 구현** — `qdrant_store.py`:
  - COL 상수 추가(기존 상수 옆, `qdrant_store.py:29` 근처): `COL_LECTURE_CLIPS = "lecture_clips"  # 강의 클립 제목 임베딩 (D147)`
  - `ensure_collections`의 컬렉션 튜플에 `COL_LECTURE_CLIPS` 추가, 그리고 payload 인덱스 블록을 미러(키는 `package_id`):

```python
        try:
            await client.create_payload_index(
                collection_name=COL_LECTURE_CLIPS,
                field_name="package_id",
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:  # noqa: BLE001
            logger.debug("lecture_clips package_id 인덱스 생성 생략")
```
  - `search`에 `scope_field` 파라미터 추가 — FieldCondition 키를 매개변수화:

```python
async def search(
    collection: str,
    vector: list[float],
    k: int,
    *,
    file_ids: list[str] | None = None,
    scope_field: str = "file_id",   # D147: 강의 클립은 "package_id"로 스코프
    score_threshold: float | None = None,
) -> list[dict]:
    if file_ids is not None and not file_ids:
        return []
    query_filter = None
    if file_ids is not None:
        query_filter = models.Filter(must=[models.FieldCondition(
            key=scope_field, match=models.MatchAny(any=[str(f) for f in file_ids]))])
    # ... 이하 client.query_points 호출은 그대로 (query_filter만 사용)
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_qdrant_lecture.py -v` — Expected: PASS. 그리고 기존 figure 검색 회귀 없음: `uv run pytest tests/ -k figure -q`.

- [ ] **Step 5: Commit** — `git add backend/app/services/qdrant_store.py backend/tests/test_qdrant_lecture.py && git commit -m "[feat]: Qdrant lecture_clips 컬렉션 + search scope_field 일반화 (D147)"`

---

## Task 4: 튜너블 3곳 (config · app_settings · admin_console)

**Files:**
- Modify: `backend/app/config.py`
- Modify: `db/03_app_settings.sql`
- Modify: `backend/app/services/admin_console.py`
- Test: `backend/tests/test_lecture_tunables.py`

**Interfaces:**
- Produces: `settings.lecture_pipeline_enabled(bool=True)`, `settings.lecture_retrieve_max_distance(float=0.55)`, `settings.lecture_retrieve_top_k(int=3)`, `settings.lecture_batch_size(int=16)`. app_settings 키 `lecture_pipeline_enabled`,`lecture_retrieve_max_distance`.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_lecture_tunables.py`:

```python
from pathlib import Path
from app.config import get_settings
from app.services import admin_console

def test_config_defaults():
    s = get_settings()
    assert s.lecture_pipeline_enabled is True
    assert s.lecture_retrieve_max_distance == 0.55
    assert s.lecture_retrieve_top_k == 3
    assert s.lecture_batch_size == 16

def test_app_settings_seed_has_lecture_knobs():
    sql = (Path(__file__).resolve().parents[2] / "db/03_app_settings.sql").read_text()
    assert "'lecture_pipeline_enabled'" in sql and "'lecture_retrieve_max_distance'" in sql

def test_admin_console_widgets_present():
    keys = {s["key"] for s in admin_console._SPECS}
    assert "lecture_pipeline_enabled" in keys
    assert "lecture_retrieve_max_distance" in keys
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_lecture_tunables.py -v` — Expected: FAIL.

- [ ] **Step 3: config.py** — figure 노브 블록(`config.py:137` 이후)에 추가:

```python
    # --- 강의 클립 추천 (D147) ---
    lecture_pipeline_enabled: bool = True          # 인제스트 킬 스위치
    lecture_retrieve_max_distance: float = 0.55    # distance=1-score 게이트
    lecture_retrieve_top_k: int = 3                # 추천 개수(config 전용)
    lecture_batch_size: int = 16                   # lecture_embed 잡 팬아웃 단위
```

- [ ] **Step 4: 03_app_settings.sql** — INSERT VALUES 목록에 두 줄 추가(마지막 값 뒤 콤마 규칙 주의 — 기존 마지막 항목 뒤에 콤마 추가 후 삽입):

```sql
    -- 강의 클립 추천 (D147)
    ('lecture_pipeline_enabled',        'true'),
    ('lecture_retrieve_max_distance',   '0.55')
```

- [ ] **Step 5: admin_console.py** — `_SPECS` 리스트에 두 위젯 추가(figure 스펙 형식 그대로):

```python
    {
        "key": "lecture_pipeline_enabled",
        "label": "강의 클립 파이프라인",
        "group": "강의 클립",
        "widget": "toggle",
        "scope": "new-only",
        "description": "EBS 링크 추가 시 챕터 파싱·임베딩을 수행할지(킬 스위치).",
        "effect": "강의 클립 인제스트 수행 여부",
    },
    {
        "key": "lecture_retrieve_max_distance",
        "label": "강의 클립 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1, "max": 0.9, "step": 0.05,
        "scope": "live",
        "description": "강의 클립 추천에 적용하는 거리 컷오프.",
        "effect": "클립 추천 엄격도",
    },
```

- [ ] **Step 6: 통과 확인** — Run: `cd backend && uv run pytest tests/test_lecture_tunables.py -v` — Expected: PASS.

- [ ] **Step 7: Commit** — `git add backend/app/config.py db/03_app_settings.sql backend/app/services/admin_console.py backend/tests/test_lecture_tunables.py && git commit -m "[tune]: 강의 클립 튜너블 3곳 동기 (D147)"`

---

## Task 5: 워커 `lecture_parse` 핸들러

**Files:**
- Create: `backend/app/services/worker/lectures.py`
- Test: `backend/tests/test_worker_lecture_parse.py`

**Interfaces:**
- Consumes: `lecture_parse.fetch_ebs_html`, `lecture_parse.parse_ebs_player`, `jobs._fail_job`, `common._now_iso`, `app_settings.get_overlay/as_bool`.
- Produces: `async def _handle_lecture_parse(svc, job) -> None`. 잡 payload: `target_id=video_id`, `owner_id=admin`, kind=`lecture_parse`. 성공 시 `lecture_clips`(status='pending') 생성 + `lecture_embed` 잡 팬아웃.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_worker_lecture_parse.py` (svc를 mock으로):

```python
import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import lectures
from app.services.lecture_parse import LectureChapter

@pytest.mark.asyncio
async def test_parse_creates_clips_and_fanout():
    svc = AsyncMock()
    svc.select.return_value = [{"id": "v1", "page_url": "http://ebs/x", "title": "04강", "status": "pending"}]
    job = {"id": "j1", "target_id": "v1", "owner_id": "admin1"}
    with patch.object(lectures.lecture_parse, "fetch_ebs_html", AsyncMock(return_value="<html/>")), \
         patch.object(lectures.lecture_parse, "parse_ebs_player",
                      return_value=[LectureChapter(365, "A"), LectureChapter(553, "B")]), \
         patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})):
        await lectures._handle_lecture_parse(svc, job)
    # clips insert 되었나
    insert_tables = [c.args[0] for c in svc.insert.call_args_list]
    assert "lecture_clips" in insert_tables
    # lecture_embed 잡 en큐
    assert any(c.args[0] == "jobs" and c.args[1].get("kind") == "lecture_embed"
               for c in svc.insert.call_args_list)
    # 영상 parsed 로 마킹
    assert any(c.args[0] == "lecture_videos" and c.args[1].get("status") == "parsed"
               for c in svc.update.call_args_list)

@pytest.mark.asyncio
async def test_no_chapters_marks_failed():
    svc = AsyncMock()
    svc.select.return_value = [{"id": "v1", "page_url": "http://ebs/x", "title": "t", "status": "pending"}]
    with patch.object(lectures.lecture_parse, "fetch_ebs_html", AsyncMock(return_value="<html/>")), \
         patch.object(lectures.lecture_parse, "parse_ebs_player", return_value=[]), \
         patch.object(lectures.app_settings, "get_overlay", AsyncMock(return_value={})):
        await lectures._handle_lecture_parse(svc, {"id": "j1", "target_id": "v1", "owner_id": "a"})
    assert any(c.args[0] == "lecture_videos" and c.args[1].get("status") == "failed"
               for c in svc.update.call_args_list)
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_parse.py -v` — Expected: FAIL (ImportError).

- [ ] **Step 3: 구현** — `backend/app/services/worker/lectures.py` (파싱 핸들러 부분):

```python
"""강의 클립 인제스트 워커 (D147) — figures.py 골격 미러.

lecture_parse: EBS 페이지 GET+파싱 → lecture_clips(pending) 생성 → lecture_embed 팬아웃.
lecture_embed: 클립 제목 embedding-passage → Qdrant lecture_clips → 행 embedded.
실패는 lecture_videos/lecture_clips.status로 격리 — files.status 절대 안 건드림(D88 동형).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from ...config import get_settings
from .. import app_settings, lecture_parse, qdrant_store, upstage
from . import common, jobs

logger = logging.getLogger("nodi.worker.lectures")
settings = get_settings()


async def _handle_lecture_parse(svc: Any, job: dict[str, Any]) -> None:
    video_id = job["target_id"]
    rows = await svc.select("lecture_videos",
        {"id": f"eq.{video_id}", "select": "id,page_url,title,status", "limit": "1"})
    if not rows:
        await jobs._fail_job(svc, job["id"], "lecture video row missing")
        return

    overlay = await app_settings.get_overlay()
    if not app_settings.as_bool(overlay, "lecture_pipeline_enabled",
                                settings.lecture_pipeline_enabled):
        # 킬 스위치 off — 영상은 pending으로 두고 잡만 done(추측 인제스트 금지).
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                     {"status": "parsing", "error": None})
    try:
        html = await lecture_parse.fetch_ebs_html(rows[0]["page_url"])
        chapters = lecture_parse.parse_ebs_player(html)
    except Exception as exc:  # noqa: BLE001
        await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                         {"status": "failed", "error": str(exc)[:500]})
        await jobs._fail_job(svc, job["id"], f"lecture parse error: {exc}")
        return

    if not chapters:
        await svc.update("lecture_videos", {"id": f"eq.{video_id}"},
                         {"status": "failed", "error": "챕터를 찾지 못했습니다"})
        await jobs._fail_job(svc, job["id"], "no chapters")
        return

    # 재파싱 멱등: 기존 클립 제거 후 재삽입.
    await svc.delete("lecture_clips", {"video_id": f"eq.{video_id}"})
    await svc.insert("lecture_clips",
        [{"video_id": video_id, "seq": i, "start_sec": ch.start_sec,
          "title": ch.title, "status": "pending"} for i, ch in enumerate(chapters)],
        returning=False)
    await svc.update("lecture_videos", {"id": f"eq.{video_id}"}, {"status": "parsed"})

    # lecture_embed 팬아웃(seq 범위).
    n = len(chapters)
    bsize = settings.lecture_batch_size
    for start in range(0, n, bsize):
        await svc.insert("jobs", {
            "owner_id": job.get("owner_id"),
            "kind": "lecture_embed",
            "target_id": video_id,
            "parent_job_id": job["id"],
            "batch_range": {"from_seq": start, "to_seq": min(start + bsize, n)},
            "status": "queued",
        }, returning=False)

    await svc.update("jobs", {"id": f"eq.{job['id']}"},
                     {"status": "done", "updated_at": common._now_iso()})
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_parse.py -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/services/worker/lectures.py backend/tests/test_worker_lecture_parse.py && git commit -m "[feat]: 워커 lecture_parse 핸들러 (D147)"`

---

## Task 6: 워커 `lecture_embed` 핸들러

**Files:**
- Modify: `backend/app/services/worker/lectures.py` (`_handle_lecture_embed` 추가)
- Test: `backend/tests/test_worker_lecture_embed.py`

**Interfaces:**
- Consumes: `upstage.embed_passages`, `common._qdrant_upsert`, `qdrant_store.COL_LECTURE_CLIPS`.
- Produces: `async def _handle_lecture_embed(svc, job) -> None`. payload=`{clip_id,video_id,package_id}`, point id=clip 행 uuid.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_worker_lecture_embed.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import lectures

@pytest.mark.asyncio
async def test_embed_upserts_identifier_only_payload():
    svc = AsyncMock()
    # 1) clips select, 2) video select(package_id)
    svc.select.side_effect = [
        [{"id": "c1", "seq": 0, "title": "고려 토지제도"}],
        [{"id": "v1", "package_id": "p1"}],
    ]
    job = {"id": "j2", "target_id": "v1", "batch_range": {"from_seq": 0, "to_seq": 16}}
    captured = {}
    async def fake_upsert(points, collection):
        captured["points"] = points; captured["collection"] = collection
    with patch.object(lectures.upstage, "embed_passages", AsyncMock(return_value=[[0.1] * 1024])), \
         patch.object(lectures.common, "_qdrant_upsert", fake_upsert):
        await lectures._handle_lecture_embed(svc, job)
    assert captured["collection"] == lectures.qdrant_store.COL_LECTURE_CLIPS
    pl = captured["points"][0]["payload"]
    assert set(pl.keys()) == {"clip_id", "video_id", "package_id"}   # 식별자만
    assert any(c.args[0] == "lecture_clips" and c.args[1].get("status") == "embedded"
               for c in svc.update.call_args_list)
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_embed.py -v` — Expected: FAIL (AttributeError).

- [ ] **Step 3: 구현** — `lectures.py`에 추가:

```python
async def _handle_lecture_embed(svc: Any, job: dict[str, Any]) -> None:
    video_id = job["target_id"]
    rng = job.get("batch_range") or {}
    from_seq, to_seq = int(rng.get("from_seq", 0)), int(rng.get("to_seq", 0))

    clips = await svc.select("lecture_clips", {
        "video_id": f"eq.{video_id}",
        "and": f"(seq.gte.{from_seq},seq.lt.{to_seq})",
        "status": "eq.pending",
        "select": "id,seq,title", "order": "seq.asc"})
    if not clips:   # 재시도 시 이미 embedded면 스킵(행 단위 멱등)
        await svc.update("jobs", {"id": f"eq.{job['id']}"},
                         {"status": "done", "updated_at": common._now_iso()})
        return

    vids = await svc.select("lecture_videos",
        {"id": f"eq.{video_id}", "select": "id,package_id", "limit": "1"})
    if not vids:
        await jobs._fail_job(svc, job["id"], "lecture video row missing")
        return
    package_id = vids[0]["package_id"]

    try:
        vectors = await upstage.embed_passages([c["title"] for c in clips])
    except Exception as exc:  # noqa: BLE001
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture embed error: {exc}")
        return
    if len(vectors) != len(clips):
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], "lecture embedding count mismatch")
        return

    points = [{"id": c["id"], "vector": v, "payload": {
        "clip_id": c["id"], "video_id": str(video_id), "package_id": str(package_id)}}
        for c, v in zip(clips, vectors, strict=True)]
    try:
        await common._qdrant_upsert(points, collection=qdrant_store.COL_LECTURE_CLIPS)
    except Exception as exc:  # noqa: BLE001
        for c in clips:
            await svc.update("lecture_clips", {"id": f"eq.{c['id']}"}, {"status": "failed"})
        await jobs._fail_job(svc, job["id"], f"lecture qdrant error: {exc}")
        return

    sem = asyncio.Semaphore(8)
    async def _mark(cid: str) -> None:
        async with sem:
            await svc.update("lecture_clips", {"id": f"eq.{cid}"}, {"status": "embedded"})
    await asyncio.gather(*(_mark(c["id"]) for c in clips))

    await svc.update("jobs", {"id": f"eq.{job['id']}"},
                     {"status": "done", "updated_at": common._now_iso()})
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_embed.py -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/services/worker/lectures.py backend/tests/test_worker_lecture_embed.py && git commit -m "[feat]: 워커 lecture_embed 핸들러 — 제목 임베딩·식별자 페이로드 (D147)"`

---

## Task 7: 워커 배선 — runner 디스패치 + 실패 격리

**Files:**
- Modify: `backend/app/services/worker/runner.py` (`_process` 디스패치)
- Modify: `backend/app/services/worker/jobs.py` (`_fail_file_for_job` 격리 분기)
- Test: `backend/tests/test_worker_lecture_dispatch.py`

**Interfaces:**
- Consumes: `lectures._handle_lecture_parse`, `lectures._handle_lecture_embed`.
- Produces: runner가 `lecture_parse`/`lecture_embed` kind를 디스패치. 잡 영구 실패 시 `lecture_videos`/`lecture_clips`만 failed(파일 불가침).

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_worker_lecture_dispatch.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from app.services.worker import runner, jobs

@pytest.mark.asyncio
async def test_runner_dispatches_lecture_kinds():
    svc = AsyncMock()
    with patch.object(runner.lectures, "_handle_lecture_parse", AsyncMock()) as ph, \
         patch.object(runner.lectures, "_handle_lecture_embed", AsyncMock()) as eh:
        await runner._process(svc, {"id": "j", "kind": "lecture_parse", "attempts": 0})
        await runner._process(svc, {"id": "j", "kind": "lecture_embed", "attempts": 0})
    ph.assert_awaited_once(); eh.assert_awaited_once()

@pytest.mark.asyncio
async def test_fail_isolation_marks_video_not_file():
    svc = AsyncMock()
    await jobs._fail_file_for_job(svc, {"target_id": "v1", "kind": "lecture_parse"}, "err")
    tables = [c.args[0] for c in svc.update.call_args_list]
    assert "lecture_videos" in tables and "files" not in tables
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_dispatch.py -v` — Expected: FAIL.

- [ ] **Step 3: runner.py** — import에 `from . import lectures` 추가, `_process`의 elif 사슬에 추가(atom_batch 분기 다음):

```python
        elif job["kind"] == "lecture_parse":
            await lectures._handle_lecture_parse(svc, job)
        elif job["kind"] == "lecture_embed":
            await lectures._handle_lecture_embed(svc, job)
```

- [ ] **Step 4: jobs.py `_fail_file_for_job`** — 격리 분기 추가(figure/atom 분기 옆). files.status 불가침:

```python
    elif kind == "lecture_parse":
        # D147: 파싱 영구 실패 — 영상만 failed(파일·다른 인제스트 불가침).
        await svc.update("lecture_videos", {"id": f"eq.{file_id}"},
                         {"status": "failed", "error": (error or "")[:500]})
    elif kind == "lecture_embed":
        rng = job.get("batch_range") or {}
        if "from_seq" in rng and "to_seq" in rng:
            await svc.update("lecture_clips", {
                "video_id": f"eq.{file_id}",
                "and": f"(seq.gte.{int(rng['from_seq'])},seq.lt.{int(rng['to_seq'])})",
                "status": "eq.pending",
            }, {"status": "failed"})
```
(주의: 이 elif들은 기존 `else`(embedding_batch) 분기보다 **앞**에 둔다.)

- [ ] **Step 5: 통과 확인** — Run: `cd backend && uv run pytest tests/test_worker_lecture_dispatch.py -v` 그리고 회귀: `uv run pytest tests/ -q`.

- [ ] **Step 6: Commit** — `git add backend/app/services/worker/runner.py backend/app/services/worker/jobs.py backend/tests/test_worker_lecture_dispatch.py && git commit -m "[feat]: 워커 강의 잡 디스패치 + 실패 격리 (D147)"`

---

## Task 8: 검색 서비스 `lecture_search`

**Files:**
- Create: `backend/app/services/lecture_search.py`
- Test: `backend/tests/test_lecture_search.py`

**Interfaces:**
- Consumes: `qdrant_store.search(..., scope_field="package_id")`, `upstage.embed_query`, `app_settings`, `lecture_parse.fmt_timeline`.
- Produces: `async def search_class_clips(client, class_id: str | None, query: str) -> list[dict]`. 항목: `{clip_id,title,start_sec,timeline_label,page_url,video_title,score}`. **어떤 실패든 `[]`**.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_lecture_search.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from app.services import lecture_search

@pytest.mark.asyncio
async def test_no_enabled_packages_returns_empty():
    client = AsyncMock()
    client.select.return_value = []   # class_lecture_packages 비어있음
    out = await lecture_search.search_class_clips(client, "class1", "미터원기")
    assert out == []

@pytest.mark.asyncio
async def test_returns_clip_items_with_timeline():
    client = AsyncMock()
    client.select.side_effect = [
        [{"package_id": "p1"}],                                             # 켠 패키지
        [{"id": "c1", "video_id": "v1", "start_sec": 896, "title": "고려 토지제도"}],  # clips 재조회
        [{"id": "v1", "page_url": "http://ebs/x", "title": "한국사 04강"}],  # videos
    ]
    with patch.object(lecture_search.upstage, "embed_query", AsyncMock(return_value=[0.1] * 1024)), \
         patch.object(lecture_search.qdrant_store, "search",
                      AsyncMock(return_value=[{"id": "c1", "score": 0.7, "payload": {}}])), \
         patch.object(lecture_search.app_settings, "get_overlay", AsyncMock(return_value={})):
        out = await lecture_search.search_class_clips(client, "class1", "고려 토지")
    assert out[0]["clip_id"] == "c1"
    assert out[0]["timeline_label"] == "14:56"
    assert out[0]["page_url"] == "http://ebs/x"
    assert out[0]["video_title"] == "한국사 04강"

@pytest.mark.asyncio
async def test_failure_degrades_to_empty():
    client = AsyncMock()
    client.select.side_effect = RuntimeError("db down")
    assert await lecture_search.search_class_clips(client, "class1", "q") == []
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_lecture_search.py -v` — Expected: FAIL.

- [ ] **Step 3: 구현** — `backend/app/services/lecture_search.py`:

```python
"""강의 클립 검색 (D147) — figure_search 미러.

전역 카탈로그는 유저 데이터가 아니라 admin 콘텐츠다. 스코핑은 file_id가 아니라
선생님이 그 워크스페이스에 켠 **package_id**로 한다. 페이로드는 식별자만이므로
히트 후 Postgres에서 클립·영상 행을 재조회해 표시값을 얻는다. 어떤 실패든 [].
"""
from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings, lecture_parse, qdrant_store, upstage

logger = logging.getLogger("nodi.lecture_search")
settings = get_settings()


async def search_class_clips(
    client: UserClient, class_id: str | None, query: str
) -> list[dict[str, Any]]:
    if not class_id or not query.strip():
        return []
    try:
        pkg_rows = await client.select("class_lecture_packages",
            {"class_id": f"eq.{class_id}", "select": "package_id"})
        package_ids = [str(r["package_id"]) for r in pkg_rows]
        if not package_ids:
            return []

        overlay = await app_settings.get_overlay()
        max_dist = app_settings.as_float(overlay, "lecture_retrieve_max_distance",
                                         settings.lecture_retrieve_max_distance, 0.1, 0.9)
        vec = await upstage.embed_query(query)
        hits = await qdrant_store.search(
            qdrant_store.COL_LECTURE_CLIPS, vec, settings.lecture_retrieve_top_k,
            file_ids=package_ids, scope_field="package_id",
            score_threshold=1.0 - max_dist)
        if not hits:
            return []

        scores = {h["id"]: h["score"] for h in hits}
        clip_rows = await client.select("lecture_clips",
            {"id": f"in.({','.join(scores)})", "select": "id,video_id,start_sec,title"})
        by_id = {str(r["id"]): r for r in clip_rows}
        video_ids = {str(r["video_id"]) for r in clip_rows}
        v_rows = (await client.select("lecture_videos",
            {"id": f"in.({','.join(video_ids)})", "select": "id,page_url,title"})
            if video_ids else [])
        vmap = {str(v["id"]): v for v in v_rows}

        out: list[dict[str, Any]] = []
        for h in hits:                       # Qdrant 랭킹 순 보존
            r = by_id.get(h["id"])
            if not r:
                continue                     # 재조회 못한 히트 탈락
            v = vmap.get(str(r["video_id"])) or {}
            sec = int(r.get("start_sec") or 0)
            out.append({
                "clip_id": str(r["id"]),
                "title": r.get("title") or "",
                "start_sec": sec,
                "timeline_label": lecture_parse.fmt_timeline(sec),
                "page_url": v.get("page_url") or "",
                "video_title": v.get("title") or "",
                "score": scores.get(h["id"]),
            })
        logger.info("강의 클립 검색: %d건", len(out))
        return out
    except Exception:  # noqa: BLE001 - 검색 실패는 빈 목록으로 강등
        logger.exception("강의 클립 검색 실패 — 빈 목록으로 진행")
        return []
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_lecture_search.py -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/services/lecture_search.py backend/tests/test_lecture_search.py && git commit -m "[feat]: 강의 클립 검색 서비스 — package_id 스코프·RLS 재조회 (D147)"`

---

## Task 9: ReAct 스킬 `search_lecture_clip` + 등록/카탈로그

**Files:**
- Create: `backend/app/ai/skills/search_lecture_clip.py`
- Modify: `backend/app/ai/__init__.py` (registry 등록)
- Modify: `backend/app/ai/catalog.py` (`_CLASS_ONLY`에 추가)
- Test: `backend/tests/test_search_lecture_clip_skill.py`

**Interfaces:**
- Consumes: `lecture_search.search_class_clips`, `SkillBase/SkillContext/SkillResult`.
- Produces: 스킬 `search_lecture_clip`. `data={"captions":[titles], "clips":[items]}`. class 스코프 전용.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_search_lecture_clip_skill.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from app.ai.skills.search_lecture_clip import SearchLectureClip
from app.ai.base import SkillContext

def _ctx(space_kind="class"):
    return SkillContext(user_id="u", client=AsyncMock(), session_id="s",
                        space_kind=space_kind, space_ref="class1", role="student")

@pytest.mark.asyncio
async def test_rejects_personal_scope():
    r = await SearchLectureClip().run({"query": "q"}, _ctx(space_kind="personal"))
    assert r.ok is False and r.error_code == "wrong_scope"

@pytest.mark.asyncio
async def test_returns_clips_in_data():
    items = [{"clip_id": "c1", "title": "고려 토지제도", "timeline_label": "14:56",
              "page_url": "http://ebs/x", "start_sec": 896, "video_title": "04강", "score": 0.7}]
    with patch.object(SearchLectureClip, "run", wraps=None):
        pass
    with patch("app.ai.skills.search_lecture_clip.lecture_search.search_class_clips",
               AsyncMock(return_value=items)):
        r = await SearchLectureClip().run({"query": "고려"}, _ctx())
    assert r.ok is True
    assert r.data["clips"] == items
    assert r.data["captions"] == ["고려 토지제도"]

@pytest.mark.asyncio
async def test_registered_and_in_catalog():
    from app import ai
    from app.ai import catalog
    assert "search_lecture_clip" in catalog.ALL_DECLARED
    names = catalog.skills_for("class", "student")
    assert "search_lecture_clip" in names
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_search_lecture_clip_skill.py -v` — Expected: FAIL.

- [ ] **Step 3: 스킬 구현** — `backend/app/ai/skills/search_lecture_clip.py`:

```python
"""강의 클립 추천 스킬 (D147) — search_textbook_figure 미러.

학급 워크스페이스에서 학생 질의와 맞는 EBS 강의 클립(챕터)을 찾는다. 시스템이
캔버스에 카드로 띄우므로 모델은 본문에 링크를 쓰지 않는다.
"""
from __future__ import annotations

from typing import Any

from ...services import lecture_search
from ..base import SkillBase, SkillContext, SkillResult


class SearchLectureClip(SkillBase):
    name = "search_lecture_clip"
    description = (
        "학급 강의 추천 패키지에서 학생 질문과 관련된 강의 영상 클립(챕터)을 찾는다. "
        "결과는 시스템이 캔버스에 카드로 자동으로 띄우므로, 본문 답변에 영상 링크를 "
        "직접 쓰지 마라. 개념 설명이 필요할 때 함께 호출한다."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"query": {"type": "string",
            "description": "학생이 궁금해하는 개념/주제 (검색어)"}},
        "required": ["query"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        query = (args.get("query") or "").strip()
        if not query:
            return SkillResult(ok=False, message="검색어가 비었습니다.", error_code="bad_args")
        if ctx.space_kind != "class":
            return SkillResult(ok=False, message="개인 세션에서는 강의 추천을 쓸 수 없습니다.",
                               error_code="wrong_scope")
        items = await lecture_search.search_class_clips(ctx.client, ctx.space_ref, query)
        if not items:
            return SkillResult(ok=True, message="관련 강의 클립을 찾지 못했습니다.",
                               data={"clips": []})
        return SkillResult(
            ok=True,
            message=f"강의 클립 {len(items)}개를 찾았습니다.",
            data={"captions": [i.get("title") or "" for i in items], "clips": items},
        )
```

- [ ] **Step 4: 등록** — `backend/app/ai/__init__.py`의 `registry.register(...)` 블록(`:47-54`)에 추가:

```python
    from .skills.search_lecture_clip import SearchLectureClip
    registry.register(SearchLectureClip())
```

- [ ] **Step 5: 카탈로그** — `backend/app/ai/catalog.py:22`의 `_CLASS_ONLY`에 추가:

```python
_CLASS_ONLY = ["search_class_material", "search_textbook_figure", "search_lecture_clip"]
```

- [ ] **Step 6: 통과 확인** — Run: `cd backend && uv run pytest tests/test_search_lecture_clip_skill.py -v` 및 부팅 가드 회귀 `uv run pytest tests/ -k "catalog or skill" -q` — Expected: PASS.

- [ ] **Step 7: Commit** — `git add backend/app/ai/skills/search_lecture_clip.py backend/app/ai/__init__.py backend/app/ai/catalog.py backend/tests/test_search_lecture_clip_skill.py && git commit -m "[feat]: search_lecture_clip 스킬 + 등록·카탈로그 (D147)"`

---

## Task 10: 오케스트레이터 — `clips` 수집 채널

**Files:**
- Modify: `backend/app/ai/orchestrator.py` (`TurnOutcome.clips`, `_collect`, `_HANDLED_KEYS`, `_evidence_block`)
- Test: `backend/tests/test_orchestrator_clips.py`

**Interfaces:**
- Consumes: 스킬 `result.data["clips"]`.
- Produces: `TurnOutcome.clips: list[dict]` (clip_id로 dedupe). `("outcome", outcome)`에 실려 chat.py로.

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_orchestrator_clips.py`:

```python
from app.ai.orchestrator import TurnOutcome, Orchestrator
from app.ai.base import SkillResult

def test_collect_gathers_clips_dedup_by_clip_id():
    outcome = TurnOutcome()
    r = SkillResult(ok=True, message="", data={"clips": [
        {"clip_id": "c1", "title": "A"}, {"clip_id": "c1", "title": "A"},
        {"clip_id": "c2", "title": "B"}]})
    Orchestrator._collect(outcome, "search_lecture_clip", r)
    assert [c["clip_id"] for c in outcome.clips] == ["c1", "c2"]
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_orchestrator_clips.py -v` — Expected: FAIL (AttributeError clips).

- [ ] **Step 3: 구현** — `orchestrator.py`:
  - `TurnOutcome`(`:52-78`)에 필드 추가: `clips: list[dict[str, Any]] = field(default_factory=list)`
  - `_collect`(`:303-323`)의 figures 블록 다음에 clips 수집 추가:

```python
        clips = result.data.get("clips")
        if isinstance(clips, list):
            seen = {c.get("clip_id") for c in outcome.clips}
            for c in clips:
                cid = c.get("clip_id")
                if cid and cid not in seen:
                    seen.add(cid)
                    outcome.clips.append(c)
```
  - `_HANDLED_KEYS`(`:82`)에 `"clips"` 추가(일반 렌더 중복 방지).
  - `_evidence_block`(`:325-380`)에서 figures caption을 붙이는 부분 옆에, clips가 있으면 제목을 근거로 붙인다:

```python
        for c in outcome.clips:
            title = c.get("title")
            if title:
                lines.append(f"- 강의 클립: {title} ({c.get('timeline_label','')})")
```
(정확한 삽입 위치는 figures 루프 바로 아래. `lines` 변수명은 해당 함수의 누적 리스트에 맞춘다.)

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_orchestrator_clips.py -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/ai/orchestrator.py backend/tests/test_orchestrator_clips.py && git commit -m "[feat]: 오케스트레이터 clips 수집 채널 (D147)"`

---

## Task 11: chat.py — done 이벤트에 `clips` 싣기

**Files:**
- Modify: `backend/app/routers/chat.py` (outcome 소비 + done 조립)
- Test: `backend/tests/test_chat_clips_done.py`

**Interfaces:**
- Consumes: `payload.clips` (TurnOutcome).
- Produces: SSE `done` 이벤트에 `"clips": skill_clips`. (canvas_items 클라이언트 영속에 의존 — 서버 attachments 영속은 하지 않는다.)

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_chat_clips_done.py` (done 페이로드 조립 형태 검증 — 가벼운 단위 함수가 없으면 문자열 검사):

```python
import inspect
from app.routers import chat

def test_done_event_includes_clips_field():
    src = inspect.getsource(chat)
    # done 이벤트 딕셔너리에 clips 키가 실린다
    assert '"clips": skill_clips' in src
    # outcome에서 clips를 받는다
    assert "skill_clips" in src and "payload.clips" in src
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_chat_clips_done.py -v` — Expected: FAIL.

- [ ] **Step 3: 구현** — `chat.py`:
  - `skill_figures = list(legacy_figures)` 초기화 지점(`:291`) 근처에 `skill_clips: list[dict[str, Any]] = []` 추가.
  - outcome 소비(`:326-337`)에 `skill_clips = payload.clips` 추가.
  - done 이벤트 딕셔너리(`:394-410`)에 `"clips": skill_clips,` 추가.

```python
    # (outcome 분기 안)
    skill_clips = payload.clips
    ...
    yield _sse("done", {
        "node": {...},
        "current_head_id": node["id"],
        "root_node_id": existing_root or node["id"],
        "figures": skill_figures,
        "clips": skill_clips,          # D147: 강의 클립 — 캔버스가 카드로 띄운다
    })
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_chat_clips_done.py -v` 및 전체 회귀 `uv run pytest tests/ -q` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/routers/chat.py backend/tests/test_chat_clips_done.py && git commit -m "[feat]: chat done 이벤트에 clips 싣기 (D147)"`

---

## Task 12: admin 라우터 — 강의 패키지·영상 CRUD + 파싱 잡

**Files:**
- Modify: `backend/app/routers/admin.py` (엔드포인트 추가)
- Test: `backend/tests/test_admin_lectures.py`

**Interfaces:**
- Consumes: `UserClient.from_user`, `require_admin`, `get_service_client`(잡 en큐).
- Produces: `/api/admin/lecture-packages`(POST/GET), `/api/admin/lecture-packages/{id}`(DELETE), `/api/admin/lecture-packages/{id}/videos`(POST/GET), `/api/admin/lecture-videos/{id}`(DELETE), `/api/admin/lecture-videos/{id}/reparse`(POST), `/api/admin/lecture-videos/{id}/clips`(GET).

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_admin_lectures.py` (라우트 존재 + 바디 모델 검증):

```python
from app.main import app

def _paths():
    return {r.path for r in app.routes}

def test_lecture_admin_routes_registered():
    p = _paths()
    assert "/api/admin/lecture-packages" in p
    assert "/api/admin/lecture-packages/{package_id}/videos" in p
    assert "/api/admin/lecture-videos/{video_id}/reparse" in p

def test_create_package_body_model():
    from app.routers.admin import CreateLecturePackageBody
    m = CreateLecturePackageBody(grade="고1", subject="통합과학", title="2028 수능개념")
    assert m.grade == "고1"
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_admin_lectures.py -v` — Expected: FAIL.

- [ ] **Step 3: 구현** — `admin.py`에 추가 (import에 `from ..db.client import get_service_client` 확인/추가):

```python
class CreateLecturePackageBody(BaseModel):
    grade: str = Field(min_length=1, max_length=40)
    subject: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=120)

class AddLectureVideoBody(BaseModel):
    page_url: str = Field(min_length=8, max_length=1000)
    title: str = Field(min_length=1, max_length=200)


@router.post("/lecture-packages", status_code=status.HTTP_201_CREATED)
async def create_lecture_package(body: CreateLecturePackageBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    return await client.insert("lecture_packages", {
        "grade": body.grade, "subject": body.subject, "title": body.title,
        "created_by": user.id})

@router.get("/lecture-packages")
async def list_lecture_packages(user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select("lecture_packages",
        {"select": "id,grade,subject,title,created_at", "order": "created_at.desc"})

@router.delete("/lecture-packages/{package_id}")
async def delete_lecture_package(package_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.delete("lecture_packages", {"id": f"eq.{package_id}"})
    return {"ok": True}

@router.get("/lecture-packages/{package_id}/videos")
async def list_lecture_videos(package_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select("lecture_videos",
        {"package_id": f"eq.{package_id}",
         "select": "id,page_url,title,status,error,created_at", "order": "created_at.desc"})

@router.post("/lecture-packages/{package_id}/videos", status_code=status.HTTP_201_CREATED)
async def add_lecture_video(package_id: str, body: AddLectureVideoBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    video = await client.insert("lecture_videos", {
        "package_id": package_id, "source": "ebs",
        "page_url": body.page_url, "title": body.title, "status": "pending"})
    # 파싱 잡 en큐는 워커 도메인 테이블 — ServiceClient로(files.py 업로드 패턴).
    svc = get_service_client()
    if svc is not None:
        await svc.insert("jobs", {
            "owner_id": user.id, "kind": "lecture_parse",
            "target_id": video["id"], "status": "queued"}, returning=False)
    return video

@router.post("/lecture-videos/{video_id}/reparse")
async def reparse_lecture_video(video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.update("lecture_videos", {"id": f"eq.{video_id}"},
                        {"status": "pending", "error": None})
    svc = get_service_client()
    if svc is not None:
        await svc.insert("jobs", {
            "owner_id": user.id, "kind": "lecture_parse",
            "target_id": video_id, "status": "queued"}, returning=False)
    return {"ok": True}

@router.delete("/lecture-videos/{video_id}")
async def delete_lecture_video(video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.delete("lecture_videos", {"id": f"eq.{video_id}"})
    return {"ok": True}

@router.get("/lecture-videos/{video_id}/clips")
async def list_lecture_clips(video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin)) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select("lecture_clips",
        {"video_id": f"eq.{video_id}",
         "select": "id,seq,start_sec,title,status", "order": "seq.asc"})
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_admin_lectures.py -v` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/routers/admin.py backend/tests/test_admin_lectures.py && git commit -m "[feat]: admin 강의 패키지·영상 CRUD + 파싱 잡 en큐 (D147)"`

---

## Task 13: teacher 라우터 — 워크스페이스 패키지 선택

**Files:**
- Modify: `backend/app/routers/teacher.py`
- Test: `backend/tests/test_teacher_lecture_packages.py`

**Interfaces:**
- Consumes: `_assert_teaches`, `UserClient`.
- Produces: `GET /api/teacher/classes/{class_id}/lecture-packages` (전체 패키지 + enabled), `PUT /api/teacher/classes/{class_id}/lecture-packages/{package_id}` (`{enabled: bool}` → class_lecture_packages upsert/delete).

- [ ] **Step 1: 실패 테스트** — `backend/tests/test_teacher_lecture_packages.py`:

```python
from app.main import app

def test_teacher_lecture_routes():
    paths = {r.path for r in app.routes}
    assert "/api/teacher/classes/{class_id}/lecture-packages" in paths
    assert "/api/teacher/classes/{class_id}/lecture-packages/{package_id}" in paths

def test_toggle_body_model():
    from app.routers.teacher import ToggleLecturePackageBody
    assert ToggleLecturePackageBody(enabled=True).enabled is True
```

- [ ] **Step 2: 실패 확인** — Run: `cd backend && uv run pytest tests/test_teacher_lecture_packages.py -v` — Expected: FAIL.

- [ ] **Step 3: 구현** — `teacher.py`에 추가:

```python
class ToggleLecturePackageBody(BaseModel):
    enabled: bool


@router.get("/classes/{class_id}/lecture-packages")
async def list_class_lecture_packages(class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher)) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    packages = await client.select("lecture_packages",
        {"select": "id,grade,subject,title", "order": "grade.asc"})
    enabled_rows = await client.select("class_lecture_packages",
        {"class_id": f"eq.{class_id}", "select": "package_id"})
    enabled = {str(r["package_id"]) for r in enabled_rows}
    return [{**p, "enabled": str(p["id"]) in enabled} for p in packages]

@router.put("/classes/{class_id}/lecture-packages/{package_id}")
async def toggle_class_lecture_package(class_id: str, package_id: str,
    body: ToggleLecturePackageBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher)) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    if body.enabled:
        await client.upsert("class_lecture_packages",
            {"class_id": class_id, "package_id": package_id},
            on_conflict="class_id,package_id")
    else:
        await client.delete("class_lecture_packages",
            {"class_id": f"eq.{class_id}", "package_id": f"eq.{package_id}"})
    return {"ok": True, "enabled": body.enabled}
```

- [ ] **Step 4: 통과 확인** — Run: `cd backend && uv run pytest tests/test_teacher_lecture_packages.py -v` 및 `uv run pytest tests/ -q` 회귀 — Expected: PASS.

- [ ] **Step 5: Commit** — `git add backend/app/routers/teacher.py backend/tests/test_teacher_lecture_packages.py && git commit -m "[feat]: teacher 워크스페이스 강의 패키지 선택 (D147)"`

---

## Task 14: 프론트 타입 + API 클라이언트

**Files:**
- Modify: `frontend/src/lib/canvas2/types.ts` (`ItemKind`에 `"clip"`, `ItemData.clip`)
- Modify: `frontend/src/lib/types.ts` (`ChatDoneEvent.clips`)
- Create: `frontend/src/lib/api/lectures.ts`
- Modify: `frontend/src/lib/api/index.ts` (배럴 export)
- Test: `frontend/src/lib/api/lectures.test.ts` (URL 조립 순수 검증) 또는 tsc

**Interfaces:**
- Produces: TS 타입 `ItemData.clip`; API `listLecturePackages/createLecturePackage/deleteLecturePackage/listLectureVideos/addLectureVideo/reparseLectureVideo/deleteLectureVideo/listLectureClips`(admin), `listClassLecturePackages/toggleClassLecturePackage`(teacher).

- [ ] **Step 1: 타입 확장** — `frontend/src/lib/canvas2/types.ts`:

```tsx
export type ItemKind = "concept" | "note" | "figure" | "clip";
```
그리고 `ItemData`에 `figure?` 옆에:

```tsx
  /** 강의 클립(kind='clip') 메타. page_url은 안정적(EBS 공식 링크) — 영속한다. */
  clip?: {
    clipId: string;
    videoId?: string;
    title: string;
    startSec: number;
    timelineLabel: string;
    pageUrl: string;
    videoTitle?: string;
    score?: number;
  };
```

- [ ] **Step 2: `lib/types.ts`** — `ChatDoneEvent`에 `figures?` 옆:

```tsx
  /** D147: 강의 클립 추천. 스킬이 찾아 done에 실어 보낸다(snake_case). */
  clips?: Array<{
    clip_id: string;
    title: string;
    start_sec: number;
    timeline_label: string;
    page_url: string;
    video_title?: string;
    score?: number;
  }> | null;
```

- [ ] **Step 3: API 클라이언트** — `frontend/src/lib/api/lectures.ts`:

```tsx
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface LecturePackage { id: string; grade: string; subject: string; title: string; }
export interface LectureVideo { id: string; page_url: string; title: string; status: string; error?: string | null; }
export interface LectureClipRow { id: string; seq: number; start_sec: number; title: string; status: string; }

async function j<T>(res: Response): Promise<T> { return (await ensureOk(res)).json(); }

// --- admin ---
export async function listLecturePackages(): Promise<LecturePackage[]> {
  return j(await fetch(`${API_BASE}/admin/lecture-packages`, { headers: await authHeaders() }));
}
export async function createLecturePackage(b: { grade: string; subject: string; title: string }): Promise<LecturePackage> {
  return j(await fetch(`${API_BASE}/admin/lecture-packages`, {
    method: "POST", headers: await authHeaders(true), body: JSON.stringify(b) }));
}
export async function deleteLecturePackage(id: string): Promise<void> {
  await ensureOk(await fetch(`${API_BASE}/admin/lecture-packages/${id}`, {
    method: "DELETE", headers: await authHeaders() }));
}
export async function listLectureVideos(packageId: string): Promise<LectureVideo[]> {
  return j(await fetch(`${API_BASE}/admin/lecture-packages/${packageId}/videos`, { headers: await authHeaders() }));
}
export async function addLectureVideo(packageId: string, b: { page_url: string; title: string }): Promise<LectureVideo> {
  return j(await fetch(`${API_BASE}/admin/lecture-packages/${packageId}/videos`, {
    method: "POST", headers: await authHeaders(true), body: JSON.stringify(b) }));
}
export async function reparseLectureVideo(videoId: string): Promise<void> {
  await ensureOk(await fetch(`${API_BASE}/admin/lecture-videos/${videoId}/reparse`, {
    method: "POST", headers: await authHeaders() }));
}
export async function deleteLectureVideo(videoId: string): Promise<void> {
  await ensureOk(await fetch(`${API_BASE}/admin/lecture-videos/${videoId}`, {
    method: "DELETE", headers: await authHeaders() }));
}
export async function listLectureClips(videoId: string): Promise<LectureClipRow[]> {
  return j(await fetch(`${API_BASE}/admin/lecture-videos/${videoId}/clips`, { headers: await authHeaders() }));
}

// --- teacher ---
export interface ClassLecturePackage extends LecturePackage { enabled: boolean; }
export async function listClassLecturePackages(classId: string): Promise<ClassLecturePackage[]> {
  return j(await fetch(`${API_BASE}/teacher/classes/${classId}/lecture-packages`, { headers: await authHeaders() }));
}
export async function toggleClassLecturePackage(classId: string, packageId: string, enabled: boolean): Promise<void> {
  await ensureOk(await fetch(`${API_BASE}/teacher/classes/${classId}/lecture-packages/${packageId}`, {
    method: "PUT", headers: await authHeaders(true), body: JSON.stringify({ enabled }) }));
}
```

- [ ] **Step 4: 배럴 export** — `frontend/src/lib/api/index.ts` 하단에:

```tsx
export * from "./lectures";
```

- [ ] **Step 5: 타입/빌드 검증** — Run: `cd frontend && npx tsc --noEmit` — Expected: 에러 없음.

- [ ] **Step 6: Commit** — `git add frontend/src/lib/canvas2/types.ts frontend/src/lib/types.ts frontend/src/lib/api/lectures.ts frontend/src/lib/api/index.ts && git commit -m "[feat]: 프론트 클립 타입 + 강의 API 클라이언트 (D147)"`

---

## Task 15: 스트림 → 클립 아이템 (`useCanvasStream`)

**Files:**
- Modify: `frontend/src/lib/canvas2/useCanvasStream.ts`
- Test: `frontend/src/lib/canvas2/clipMap.test.ts` + `frontend/src/lib/canvas2/clipMap.ts`

**Interfaces:**
- Consumes: `ChatDoneEvent.clips`.
- Produces: 순수 함수 `clipToItemData(c)` (테스트 대상). `onDone`이 clips를 순회해 `kind:"clip"` CanvasItem 생성, `toPayload` clip 분기, pending 해제 `kind==="clip"`.

- [ ] **Step 1: 순수 매퍼 + 실패 테스트** — `frontend/src/lib/canvas2/clipMap.ts`:

```tsx
import type { ChatDoneEvent } from "@/lib/types";
import type { ItemData } from "./types";

type ClipEvent = NonNullable<ChatDoneEvent["clips"]>[number];

/** done 이벤트의 clip → ItemData.clip. page_url은 안정적이라 그대로 영속한다. */
export function clipToItemData(c: ClipEvent): ItemData {
  return {
    clip: {
      clipId: c.clip_id,
      title: c.title,
      startSec: c.start_sec,
      timelineLabel: c.timeline_label,
      pageUrl: c.page_url,
      videoTitle: c.video_title ?? "",
      score: c.score,
    },
  };
}
```
`frontend/src/lib/canvas2/clipMap.test.ts`:

```tsx
import { describe, it, expect } from "vitest";
import { clipToItemData } from "./clipMap";

describe("clipToItemData", () => {
  it("maps snake_case event to camelCase clip data", () => {
    const d = clipToItemData({
      clip_id: "c1", title: "고려 토지제도", start_sec: 896,
      timeline_label: "14:56", page_url: "http://ebs/x", video_title: "04강", score: 0.7,
    });
    expect(d.clip?.clipId).toBe("c1");
    expect(d.clip?.timelineLabel).toBe("14:56");
    expect(d.clip?.pageUrl).toBe("http://ebs/x");
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `cd frontend && npm test -- clipMap` — Expected: FAIL (module not found) → 파일 생성 후 PASS.

- [ ] **Step 3: `useCanvasStream.ts` 배선** — `onDone`의 figures 루프 다음에 clips 루프 추가(`useCanvasStream.ts:231-269` 인접):

```tsx
      for (const c of d.clips ?? []) {
        if (hasClip(c.clip_id) || made.some((m) => m.data.clip?.clipId === c.clip_id)) continue;
        made.push({
          id: tempId(), sessionId, nodeId: null, parentItemId,
          kind: "clip", source: "ai", title: null, body: "", tag: null,
          x: 0, y: 0, pinned: false, seq: baseSeq + made.length,
          data: {
            ...(askedQuestion ? { askedQuestion } : {}),
            clip: {
              clipId: c.clip_id, title: c.title, startSec: c.start_sec,
              timelineLabel: c.timeline_label, pageUrl: c.page_url,
              videoTitle: c.video_title ?? "", score: c.score,
            },
          },
        });
      }
```
  - pending 해제(`:280-284`)에 `|| it.kind === "clip"` 추가.
  - `toPayload`(`:93-119`) — clip은 url이 안정적이므로 그대로 영속(figure처럼 url 제거하지 않음). figure 분기 옆에:

```tsx
    data:
      it.kind === "figure" && it.data.figure
        ? { figure: { ...it.data.figure, url: "" } }
        : it.kind === "clip" && it.data.clip
          ? { clip: it.data.clip }
          : { /* 기존 note 분기 그대로 */ },
```
  - Deps 인터페이스(`:69-79`)에 `hasClip: (clipId: string) => boolean;` 추가, 훅 시그니처·`useCallback` deps(`:308`)에 반영. 호출부(`CanvasWorkspace.tsx`)에서 `hasClip`를 figure의 `hasFigure`와 같은 패턴으로 주입:

```tsx
  const hasClip = useCallback(
    (clipId: string) => store.items.some((i) => i.data.clip?.clipId === clipId),
    [store.items],
  );
```
  그리고 `useCanvasStream({... hasFigure, hasClip})`에 전달.

- [ ] **Step 4: 통과 확인** — Run: `cd frontend && npm test -- clipMap && npx tsc --noEmit` — Expected: PASS + 타입 에러 없음.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/canvas2/clipMap.ts frontend/src/lib/canvas2/clipMap.test.ts frontend/src/lib/canvas2/useCanvasStream.ts frontend/src/components/canvas2/CanvasWorkspace.tsx && git commit -m "[feat]: 스트림 clips → 캔버스 클립 아이템 (D147)"`

---

## Task 16: `ClipItem` 카드 + `ItemLayer` 분기

**Files:**
- Create: `frontend/src/components/canvas2/ClipItem.tsx`
- Modify: `frontend/src/components/canvas2/ItemLayer.tsx`
- Test: tsc/build smoke

**Interfaces:**
- Consumes: `CanvasItem`(kind='clip', data.clip), 공유 `useItemDrag`, FigureItem과 동일 Props.
- Produces: `<ClipItem />` — 제목 + 타임라인 + 영상명 + "▶ EBS에서 보기"(page_url 새 탭). 이동·선택·삭제 지원(리사이즈 없음).

- [ ] **Step 1: `ClipItem.tsx` 작성** — FigureItem의 드래그·선택·측정 골격을 복제하되 이미지·리사이즈·URL재발급 제거, 카드 콘텐츠만 교체:

```tsx
"use client";

/** 강의 클립 추천 카드 (D147). FigureItem의 이동/선택/삭제 배선을 본떠 만들되
 *  이미지·리사이즈·signed URL 재발급이 없다 — page_url은 안정적인 EBS 공식 링크다.
 *  클릭 시 새 탭으로 열고, 타임라인 시각은 텍스트로 안내(딥링크 seek 안 함). */
import { useRef } from "react";
import { PlayCircle } from "lucide-react";
import type { CanvasItem } from "@/lib/canvas2/types";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";

interface Props {
  item: CanvasItem;
  x: number;
  y: number;
  zoom: number;
  selected: boolean;
  measure: (id: string, el: HTMLElement | null) => void;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  onDelete: (id: string) => void;
}

export function ClipItem({ item, x, y, zoom, selected, measure, onSelect, onDragEnd, onDelete }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clip = item.data.clip;
  const { onPointerDown } = useItemDrag({ id: item.id, x, y, zoom, onSelect, onDragEnd });

  if (!clip) return null;
  return (
    <div
      ref={(el) => { ref.current = el; measure(item.id, el); }}
      data-canvas-item={item.id}
      onPointerDown={onPointerDown}
      className="absolute select-none rounded-lg border p-3"
      style={{
        left: x, top: y, width: 260,
        pointerEvents: "var(--c2-item-events)" as never,
        background: "var(--c-raised)",
        borderColor: selected ? "var(--c-hand)" : "var(--c-rule)",
        boxShadow: "var(--c-shadow-sm)",
      }}
    >
      <div className="label mb-1" style={{ color: "var(--c-ink-soft)" }}>
        강의 클립 · {clip.timelineLabel}
      </div>
      <div className="text-sm font-medium" style={{ color: "var(--c-ink)" }}>{clip.title}</div>
      {clip.videoTitle ? (
        <div className="label mt-0.5 truncate" style={{ color: "var(--c-ink-faint)" }}>{clip.videoTitle}</div>
      ) : null}
      <a
        href={clip.pageUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-2 inline-flex items-center gap-1 text-sm"
        style={{ color: "var(--c-hand)" }}
      >
        <PlayCircle size={15} /> EBS에서 보기 ({clip.timelineLabel})
      </a>
      <button
        type="button"
        aria-label="삭제"
        onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
        className="absolute right-1 top-1 text-xs"
        style={{ color: "var(--c-ink-faint)" }}
      >
        ×
      </button>
    </div>
  );
}
```
(주의: `useItemDrag`의 실제 export 시그니처를 `FigureItem.tsx:112-127`에서 확인해 인자를 맞춘다. FigureItem이 쓰는 훅 형태를 그대로 재사용하고, resize 관련 인자만 뺀다.)

- [ ] **Step 2: `ItemLayer.tsx` 분기 + import** — 상단 import에 `import { ClipItem } from "./ClipItem";`, `item.kind === "figure"` 분기 앞/뒤에:

```tsx
  if (item.kind === "clip") {
    return (
      <ClipItem
        key={item.id} item={item} x={p.x} y={p.y} zoom={zoom}
        selected={selectedIds.has(item.id)} measure={measure}
        onSelect={handlers.onSelect} onDragEnd={handlers.onDragEnd}
        onDelete={handlers.onDelete}
      />
    );
  }
```

- [ ] **Step 3: 빌드/타입 검증** — Run: `cd frontend && npx tsc --noEmit && npm run build` — Expected: 성공.

- [ ] **Step 4: Commit** — `git add frontend/src/components/canvas2/ClipItem.tsx frontend/src/components/canvas2/ItemLayer.tsx && git commit -m "[feat]: 캔버스 ClipItem 카드 + ItemLayer 분기 (D147)"`

---

## Task 17: admin 콘솔 — 강의 패키지 관리 탭

**Files:**
- Create: `frontend/src/components/admin/LecturePackagesTab.tsx`
- Modify: `frontend/src/app/(admin)/admin/page.tsx` (탭 4곳)
- Modify: `frontend/src/lib/queries.ts` (훅)
- Test: tsc/build smoke

**Interfaces:**
- Consumes: `lib/api/lectures` admin 함수들.
- Produces: admin 탭 "강의 패키지" — 패키지 생성·목록, 패키지에 EBS 링크 추가·파싱 상태·클립 보기·재파싱·삭제.

- [ ] **Step 1: React Query 훅** — `frontend/src/lib/queries.ts`에 추가(materials 훅 패턴):

```tsx
import { listLecturePackages, listLectureVideos } from "@/lib/api";
export const lecturePackagesKey = () => ["lecture-packages"] as const;
export const lectureVideosKey = (pkgId: string) => ["lecture-videos", pkgId] as const;
export function useLecturePackages() {
  return useQuery({ queryKey: lecturePackagesKey(), queryFn: listLecturePackages });
}
export function useLectureVideos(pkgId: string | null) {
  return useQuery({
    queryKey: lectureVideosKey(pkgId ?? ""), enabled: !!pkgId,
    queryFn: () => listLectureVideos(pkgId as string),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((v) => v.status === "pending" || v.status === "parsing") ? 3000 : false,
  });
}
```

- [ ] **Step 2: `LecturePackagesTab.tsx`** — 패키지 생성 폼(grade/subject/title) + 목록, 선택된 패키지의 영상 목록(상태 배지) + "EBS 링크 추가" 폼(page_url/title) + 재파싱/삭제 버튼. `useLecturePackages`/`useLectureVideos` + `createLecturePackage`/`addLectureVideo`/`reparseLectureVideo`/`deleteLectureVideo` + `queryClient.invalidateQueries`. (기존 `components/admin/UsersTab.tsx`·`SettingsTab.tsx`의 폼·목록 스타일을 그대로 따른다. `ui.tsx` 공용 컴포넌트 사용.)

- [ ] **Step 3: `admin/page.tsx` 배선(4곳)** — (1) `import { LecturePackagesTab } from "@/components/admin/LecturePackagesTab";`, (2) `type Tab` 유니온에 `"lectures"`, (3) `TABS` 배열에 `{ id: "lectures", label: "강의 패키지" }`(기존 항목 형식대로 icon 포함), (4) 렌더 스위치에 `{tab === "lectures" && <LecturePackagesTab />}`.

- [ ] **Step 4: 빌드 검증** — Run: `cd frontend && npx tsc --noEmit && npm run build` — Expected: 성공.

- [ ] **Step 5: Commit** — `git add frontend/src/components/admin/LecturePackagesTab.tsx frontend/src/app/\(admin\)/admin/page.tsx frontend/src/lib/queries.ts && git commit -m "[feat]: admin 강의 패키지 관리 탭 (D147)"`

---

## Task 18: teacher UI — 워크스페이스 패키지 선택 섹션

**Files:**
- Create: `frontend/src/components/teacher/LecturePackagesSection.tsx`
- Modify: `frontend/src/components/teacher/MaterialsTab.tsx` (섹션 렌더)
- Modify: `frontend/src/lib/queries.ts` (훅)
- Test: tsc/build smoke

**Interfaces:**
- Consumes: `listClassLecturePackages`, `toggleClassLecturePackage`.
- Produces: MaterialsTab 하단 "강의 추천 패키지" 섹션 — admin 패키지 목록에서 이 학급에 켜기/끄기(토글).

- [ ] **Step 1: 훅** — `queries.ts`에:

```tsx
import { listClassLecturePackages } from "@/lib/api";
export const classLecturePackagesKey = (classId: string) => ["class-lecture-packages", classId] as const;
export function useClassLecturePackages(classId: string) {
  return useQuery({ queryKey: classLecturePackagesKey(classId),
    queryFn: () => listClassLecturePackages(classId) });
}
```

- [ ] **Step 2: `LecturePackagesSection.tsx`** — `{ classId }` prop. `useClassLecturePackages(classId)`로 목록 렌더, 각 항목에 `학년 · 과목 · 제목` + 토글 스위치. 토글 시 `toggleClassLecturePackage(classId, id, next)` 후 `invalidateQueries({ queryKey: classLecturePackagesKey(classId) })`. 빈 목록이면 "관리자가 만든 강의 패키지가 없습니다" 안내.

- [ ] **Step 3: MaterialsTab에 렌더** — `MaterialsTab.tsx` 반환 JSX 하단(자료 목록 다음)에:

```tsx
      <LecturePackagesSection classId={classId} />
```
및 상단 import 추가.

- [ ] **Step 4: 빌드 검증** — Run: `cd frontend && npx tsc --noEmit && npm run build` — Expected: 성공.

- [ ] **Step 5: Commit** — `git add frontend/src/components/teacher/LecturePackagesSection.tsx frontend/src/components/teacher/MaterialsTab.tsx frontend/src/lib/queries.ts && git commit -m "[feat]: teacher 워크스페이스 강의 패키지 선택 UI (D147)"`

---

## Task 19: E2E 수동 검증 + TASKS.md 등록

**Files:**
- Modify: `docs/TASKS.md` (신규 TASK 등록)
- Test: 수동 E2E(로컬)

**Interfaces:** 없음(통합 검증).

- [ ] **Step 1: TASKS.md 등록** — `docs/TASKS.md`에 "TASK 7: 강의 클립(숏폼) 추천 (D147)" 항목 추가(스펙·플랜 경로 링크, 상태). 커밋: `git add docs/TASKS.md && git commit -m "[docs]: TASK 7 강의 클립 추천 등록 (D147)"`.

- [ ] **Step 2: 백엔드 전체 테스트** — Run: `cd backend && uv run pytest tests/ -q` — Expected: 전부 PASS.

- [ ] **Step 3: 서버 기동 + 마이그레이션 적용(로컬)** — `docker-compose up -d`; 로컬 DB에 마이그레이션 적용(`docker exec -i nodi-postgres-1 psql -U postgres -d nodi < db/migrations/2026-08-03-d147-lecture-clips.sql` 또는 `down -v && up -d`로 01_schema 재적용). 백엔드·프론트 기동.

- [ ] **Step 4: 수동 E2E(Playwright 또는 브라우저)** — (a) admin 로그인 → 강의 패키지 생성(고1·통합과학) → 실제 EBS 링크 추가 → 파싱 상태 `parsed`·클립 목록 확인. (b) teacher 로그인 → 그 학급에서 패키지 켜기. (c) student 로그인 → 그 워크스페이스에서 관련 개념 질의 → 캔버스에 ClipItem 카드 표시·"EBS에서 보기" 새 탭 확인. **프로덕션 IP WAF 리스크(스펙 미해결)**: 로컬에서 EBS GET 성공하는지 이 단계에서 반드시 확인하고, 실패 시 스펙 리스크 항목대로 대응 결정.

- [ ] **Step 5: 검증 결과 기록** — 결과를 커밋 메시지/PR에 남긴다(스펙 미해결 리스크의 실측 결론 포함).

---

## Self-Review (작성자 체크)

- **스펙 커버리지**: 데이터모델(T1) · 인제스트 파서/GET(T2)/Qdrant(T3)/워커 파싱(T5)·임베딩(T6)·배선(T7) · 튜너블(T4) · 검색(T8) · 스킬(T9)/오케스트레이터(T10)/chat(T11) · admin API(T12)·UI(T17) · teacher API(T13)·UI(T18) · 프론트 타입/API(T14)·스트림(T15)·ClipItem(T16) · E2E/등록(T19). 스펙의 모든 섹션에 대응 태스크 존재.
- **신뢰경계**: T3(scope_field=package_id) + T8(RLS 재조회) + T1(RLS 정책)으로 "전역 카탈로그, 페이로드 식별자만, package_id 스코프" 구현.
- **불변식**: RAG 실패→[](T8), 격리(T7 _fail_file_for_job), 페이로드 식별자만(T6 테스트로 강제), 거리 1-score(T8), 튜너블 3곳(T4).
- **타입 일관성**: 백엔드 클립 항목 `{clip_id,title,start_sec,timeline_label,page_url,video_title,score}`(T8) → done(T11) → 프론트 snake_case(T14) → camelCase 매퍼(T15) → ItemData.clip(T14). 일관.
- **미해결/리스크**: 프로덕션 WAF는 T19 Step4에서 실측·대응. EBS HTML 구조 변화는 파서 격리(T2)+픽스처 테스트로 방어.
