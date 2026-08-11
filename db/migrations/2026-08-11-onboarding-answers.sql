-- 온보딩 설문 답 (D222, 사용자 지시 2026-08-11)
--
-- 처음 가입한 학생에게 이름·학년·학습 단계·목표를 묻는다. **형식상 받아 두는
-- 것**이고 지금은 아무 기능도 이 값을 읽지 않는다 — 그래서 표를 따로 둔다.
--
-- ⚠️ `profiles`에 칼럼을 더하지 않았다. 저쪽은 정책이 `display_name`·
-- `avatar_url`만 UPDATE를 허용하도록 좁혀져 있어(`me.py`의 complete_onboarding
-- 주석 참고) 칼럼을 더하면 그 정책을 넓혀야 한다. 쓰지도 않을 값 때문에
-- 프로필 쓰기 권한을 넓히는 것은 값이 안 맞는다.
--
-- 멱등이다 — 여러 번 돌려도 같다.

CREATE TABLE IF NOT EXISTS public.onboarding_answers (
    user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- 학생이 적어 준 이름. `profiles.display_name`과 **따로 둔다**: 이건 설문에
    -- 적은 답 그대로이고, 표시 이름은 나중에 바뀔 수 있다.
    display_name text,
    grade text,
    stage text,
    goal text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.onboarding_answers ENABLE ROW LEVEL SECURITY;

-- 자기 것만. 관리자 전역 읽기는 **일부러 안 만든다** — 지금 이 값을 읽는
-- 화면이 없으므로 열어 둘 이유가 없다(필요해지면 그때 정책 하나를 더한다).
DROP POLICY IF EXISTS onboarding_answers_select_own ON public.onboarding_answers;
CREATE POLICY onboarding_answers_select_own ON public.onboarding_answers
    FOR SELECT USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS onboarding_answers_insert_own ON public.onboarding_answers;
CREATE POLICY onboarding_answers_insert_own ON public.onboarding_answers
    FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS onboarding_answers_update_own ON public.onboarding_answers;
CREATE POLICY onboarding_answers_update_own ON public.onboarding_answers
    FOR UPDATE USING (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE ON public.onboarding_answers TO nodi_app;

-- `updated_at`을 손으로 넣지 않게 한다(다른 표와 같은 트리거를 쓴다).
DROP TRIGGER IF EXISTS onboarding_answers_touch ON public.onboarding_answers;
CREATE TRIGGER onboarding_answers_touch
    BEFORE UPDATE ON public.onboarding_answers
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
