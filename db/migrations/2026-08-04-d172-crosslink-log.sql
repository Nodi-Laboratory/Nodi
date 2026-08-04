-- D172 교차 연결 판정 로그 + 상시 켜기 노브
--
-- D171은 **성공한 링크만** 남긴다. 탈락한 후보는 흔적도 없이 사라져서
-- "왜 안 뜨지"를 볼 방법이 없었다 — 거리가 멀어서인지, 같은 태그라서인지,
-- 모델이 관련 없다고 했는지 구분이 안 된다.
--
-- 이 표는 **한 번의 판정 전체**를 남긴다: 어떤 세션들을 뒤졌고, 각 후보의
-- 유사도가 얼마였고, 무엇이 왜 떨어졌는지.
--
-- **멱등이다.**

BEGIN;

CREATE TABLE IF NOT EXISTS public.crosslink_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- 판정의 출발점이 된 카드. 카드가 지워져도 로그는 남긴다(SET NULL) —
    -- 지워졌다고 조사 기록까지 사라지면 사후 분석이 불가능하다.
    from_item_id  uuid REFERENCES public.canvas_items(id) ON DELETE SET NULL,
    from_session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
    from_title    text,
    from_tag      text,
    from_space_kind text,

    -- 이 판정이 쓴 노브 값(그때 무엇이 켜져 있었나).
    knobs         jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- 조사한 후보 전부. 원소 하나가 후보 하나다:
    --   {item_id, session_id, session_title, tag, space_kind, distance,
    --    verdict, reason}
    -- verdict: accepted | too_close | too_far | no_explanation | vanished
    candidates    jsonb NOT NULL DEFAULT '[]'::jsonb,

    -- 최종 결과.
    outcome       text NOT NULL,   -- linked | no_candidate | all_rejected | disabled | skipped
    link_id       uuid REFERENCES public.item_links(id) ON DELETE SET NULL,
    explanation   text NOT NULL DEFAULT '',
    -- 검색이 실제로 돌아본 세션 수(중복 제거 후) — "어떤 세션들을 조사했나".
    searched_sessions integer NOT NULL DEFAULT 0,
    duration_ms   integer,

    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crosslink_runs_created
    ON public.crosslink_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crosslink_runs_owner
    ON public.crosslink_runs (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crosslink_runs_outcome
    ON public.crosslink_runs (outcome);

-- ---------------------------------------------------------------------------
-- RLS — **관리자만** 읽는다.
--
-- 학생에게는 열어 주지 않는다. 이건 진단 기록이지 학습 자료가 아니고,
-- "너의 어떤 대화가 어떤 대화와 얼마나 비슷한지"는 보여 줄 이유가 없다.
-- ---------------------------------------------------------------------------
ALTER TABLE public.crosslink_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crosslink_runs_select_admin ON public.crosslink_runs;
CREATE POLICY crosslink_runs_select_admin ON public.crosslink_runs
    FOR SELECT USING ((SELECT public.is_admin()));

-- INSERT 정책 없음 — 워커(BYPASSRLS)만 쓴다.
GRANT SELECT ON public.crosslink_runs TO nodi_app;
GRANT SELECT, INSERT, DELETE ON public.crosslink_runs TO nodi_worker;

COMMIT;
