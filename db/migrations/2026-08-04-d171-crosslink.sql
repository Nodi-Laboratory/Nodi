-- D171 교차 세션 개념 연결 — item_links 표 + jobs.kind 확장
--
-- 목적은 융합이다. 학생이 어제 생명과학에서 한 이야기와 오늘 지구과학에서 하는
-- 이야기가 이어져 있을 때 그 연결을 보여 준다.
--
-- **멱등이다.** 여러 번 돌려도 같은 결과여야 한다(CLAUDE.md 규약).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) jobs.kind 확장 — 'crosslink'
--
-- **이 파일이 jobs_kind_check의 유일한 authority다** (D175).
--
-- 배포는 db/migrations/*.sql을 매번 전부 **사전순으로** 재실행한다. 그래서
-- 제약을 여러 파일에서 drop→add 하면, 늦게 정렬되는 파일이 이긴다 — 반대로
-- 옛 파일이 목록을 도로 좁히면 그 사이 생긴 새 kind 행이 제약을 위반해
-- **배포가 통째로 멈춘다**(실측 2026-08-04: crosslink 행 때문에 실패).
--
-- 그래서 옛 마이그레이션들은 "제약이 없을 때만" 세우도록 바꿨고, 전체 목록은
-- 여기서만 정한다. **kind를 새로 추가할 때는 이 목록에 더하거나, 이보다
-- 늦게 정렬되는 파일에서 다시 세워라.**
--
-- 01_schema.sql의 jobs_kind_check와도 같은 목록이어야 한다.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK (kind = ANY (ARRAY[
    'embedding_split'::text,
    'embedding_batch'::text,
    'figure_batch'::text,
    'atom_batch'::text,
    'lecture_parse'::text,
    'lecture_embed'::text,
    'lecture_atom'::text,
    'crosslink'::text
]));

-- ---------------------------------------------------------------------------
-- 2) item_links — 카드와 카드 사이의 교차 세션 연결
--
-- UNIQUE (from_item_id, to_item_id)가 **같은 쌍의 반복 추천을 구조로 막는다.**
-- 앱 코드의 중복 검사에 기대면 동시 실행에서 새어 나간다.
--
-- owner_id를 따로 두는 이유: 링크 조회는 "이 세션 카드들의 링크"로 들어오는데,
-- 소유자 필터를 canvas_items 조인으로만 걸면 정책이 조인 순서에 좌우된다.
-- 행 자체가 주인을 알고 있어야 RLS가 단순해진다.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.item_links (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- 지금 보고 있는 카드(새로 만들어진 쪽).
    from_item_id uuid NOT NULL REFERENCES public.canvas_items(id) ON DELETE CASCADE,
    -- 과거의 카드. 이쪽으로 "돌아가기"가 이동한다.
    to_item_id   uuid NOT NULL REFERENCES public.canvas_items(id) ON DELETE CASCADE,

    -- 왜·어떻게 관련되는지. 생성 실패면 빈 문자열로 남고 링크는 만들지 않는다.
    explanation  text NOT NULL DEFAULT '',
    -- 거리 규약: distance = 1 - score (CLAUDE.md 불변식).
    distance     double precision NOT NULL,

    -- 한 번 열면 깜빡임을 멈춘다. 본 알림이 계속 깜빡이면 그냥 소음이다.
    opened_at    timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT item_links_pair_unique UNIQUE (from_item_id, to_item_id),
    -- 자기 자신과는 잇지 않는다.
    CONSTRAINT item_links_not_self CHECK (from_item_id <> to_item_id)
);

-- 조회는 언제나 "이 세션 카드들의 링크" 형태다 — from_item_id로 들어온다.
CREATE INDEX IF NOT EXISTS idx_item_links_from ON public.item_links (from_item_id);
-- 과거 카드가 지워질 때의 역참조·중복 판정용.
CREATE INDEX IF NOT EXISTS idx_item_links_to   ON public.item_links (to_item_id);
CREATE INDEX IF NOT EXISTS idx_item_links_owner ON public.item_links (owner_id);

-- ---------------------------------------------------------------------------
-- 3) RLS — 본인 것만. 남의 대화 연결은 존재 자체가 보이면 안 된다.
-- ---------------------------------------------------------------------------
ALTER TABLE public.item_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS item_links_select       ON public.item_links;
DROP POLICY IF EXISTS item_links_select_admin ON public.item_links;
DROP POLICY IF EXISTS item_links_update_owner ON public.item_links;
DROP POLICY IF EXISTS item_links_delete_owner ON public.item_links;

CREATE POLICY item_links_select ON public.item_links
    FOR SELECT USING (owner_id = (SELECT auth.uid()));

CREATE POLICY item_links_select_admin ON public.item_links
    FOR SELECT USING ((SELECT public.is_admin()));

-- 학생이 고칠 수 있는 것은 opened_at뿐이지만(깜빡임 끄기), 컬럼 단위 제약은
-- 정책으로 표현할 수 없다. 행 소유만 확인하고 컬럼 제한은 API가 한다 —
-- 라우터는 opened_at만 쓴다.
CREATE POLICY item_links_update_owner ON public.item_links
    FOR UPDATE USING (owner_id = (SELECT auth.uid()));

CREATE POLICY item_links_delete_owner ON public.item_links
    FOR DELETE USING (owner_id = (SELECT auth.uid()));

-- **INSERT 정책은 없다.** 링크는 워커(BYPASSRLS)만 만든다. 학생이 임의의 두
-- 카드를 이어 붙일 수 있으면 이 기능의 의미가 사라진다.

GRANT SELECT, UPDATE, DELETE ON public.item_links TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_links TO nodi_worker;

COMMIT;
