-- D210 8-1 손글씨 폰트 관리
--
-- 관리자가 폰트를 올려 두고 골라 쓴다. 지금은 KCC 한빛체가 저장소에 박혀
-- 있어서 바꾸려면 배포를 해야 한다.
--
-- ## 적용 범위는 캔버스 손글씨뿐이다
--
-- 앱 전체를 갈아 끼우게 하면 관리자가 읽을 수 없는 폰트를 고르는 순간
-- **관리자 페이지 자신을 포함해** 전부 망가진다. 되돌릴 화면도 같이 망가지는
-- 셈이라, 범위를 좁히는 것이 안전장치다.
--
-- ## 왜 보정값을 폰트마다 저장하나
--
-- 자간·크기 배율은 KCC 한빛체에 맞춰 **실측해서** 잡은 값이다(D164·D165).
-- 폰트가 바뀌면 전부 틀어진다. 값을 코드에 고정해 두면 어떤 폰트를 골라도
-- 한 폰트에만 맞는다.
--
-- ## 멱등이다
--
-- 있으면 만들지 않는다. 정책·권한도 이름으로 확인하고 넣는다.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hand_fonts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 화면에 보이는 이름(관리자가 적는다).
    label         text NOT NULL,
    -- CSS `font-family` 이름. 브라우저가 이 이름으로 찾는다.
    family        text NOT NULL,
    -- 저장 경로의 조각. 파일 이름에 쓰이므로 영숫자·하이픈만.
    slug          text NOT NULL UNIQUE,
    -- woff2 | ttf | otf
    format        text NOT NULL,
    size_bytes    bigint NOT NULL,
    -- 통짜 그대로인가(시험용) / 쪼갠 것인가(운영용). D164: 통짜 한글 폰트는
    -- 2~3MB라 교실 회선에 그대로 내보내면 안 된다.
    subset        boolean NOT NULL DEFAULT false,
    -- 폰트마다 실측한 보정값 (D165).
    letter_spacing numeric NOT NULL DEFAULT 0.09,
    size_scale     numeric NOT NULL DEFAULT 1.0,
    ideograph_scale numeric NOT NULL DEFAULT 0.86,
    -- 지금 쓰는 폰트인가. **하나만 참이다**(아래 부분 유니크 인덱스).
    active        boolean NOT NULL DEFAULT false,
    created_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- 활성 폰트는 언제나 최대 하나 — 둘이면 화면이 무엇을 쓸지 알 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS hand_fonts_one_active
    ON public.hand_fonts (active) WHERE active;

ALTER TABLE public.hand_fonts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    -- 읽기는 **누구나**. 폰트는 로그인 전 화면에서도 쓰일 수 있는 공개 자산이고,
    -- 여기 담긴 것은 이름·크기·보정값뿐이다(비밀이 아니다).
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'hand_fonts'
          AND policyname = 'hand_fonts_select_all'
    ) THEN
        CREATE POLICY hand_fonts_select_all ON public.hand_fonts
            FOR SELECT USING (true);
    END IF;

    -- 쓰기는 관리자만.
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'hand_fonts'
          AND policyname = 'hand_fonts_write_admin'
    ) THEN
        CREATE POLICY hand_fonts_write_admin ON public.hand_fonts
            FOR ALL USING ((SELECT public.is_admin()))
            WITH CHECK ((SELECT public.is_admin()));
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hand_fonts TO nodi_app;

COMMIT;
