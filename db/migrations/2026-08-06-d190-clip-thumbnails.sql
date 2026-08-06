-- D190 강의 클립 썸네일 — 관리자가 올린 그림 중에서 골라 쓴다
--
-- 클립 카드에 그림이 있어야 "영상"으로 읽힌다. 그런데 **EBS 썸네일을 가져올
-- 방법이 없다** — 남의 사이트 이미지를 긁어 오는 것은 저작권·차단 양쪽에서
-- 문제고, 링크로 걸면 저쪽이 바꾸는 순간 깨진 그림이 남는다.
--
-- 그래서 관리자가 쓸 만한 그림 몇 장을 올려 두고 클립마다 그중 하나를 보여
-- 준다. 실제 그 강의의 장면은 아니지만 **카드가 무엇인지는 말해 준다.**
--
-- 학생 데이터가 아니다 — 누구의 것도 아닌 장식용 그림이라 로그인한 사람은
-- 다 읽을 수 있고, 넣고 빼는 것은 관리자만 한다.
--
-- **멱등이다.** 여러 번 돌려도 같은 결과여야 한다(CLAUDE.md 규약).

BEGIN;

CREATE TABLE IF NOT EXISTS public.clip_thumbnails (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Storage 키. 바이트는 파일 저장소에 있고 여기는 목록·순서만 든다.
    storage_path  text NOT NULL,
    mime          text NOT NULL,
    size_bytes    integer NOT NULL DEFAULT 0,
    -- 관리자가 알아보라고 남기는 이름(원본 파일명). 화면 선택에는 안 쓴다.
    name          text,
    created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clip_thumbnails_created
    ON public.clip_thumbnails (created_at DESC);

ALTER TABLE public.clip_thumbnails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clip_thumbnails_select ON public.clip_thumbnails;
DROP POLICY IF EXISTS clip_thumbnails_write_admin ON public.clip_thumbnails;

-- 읽기는 로그인한 누구나 — 학생 화면이 이 목록에서 골라 그린다.
-- 행에는 경로·크기뿐이고 개인 정보가 없다.
CREATE POLICY clip_thumbnails_select ON public.clip_thumbnails
    FOR SELECT USING ((SELECT auth.uid()) IS NOT NULL);

-- 넣고 빼는 것은 관리자만.
CREATE POLICY clip_thumbnails_write_admin ON public.clip_thumbnails
    FOR ALL USING ((SELECT public.is_admin()))
    WITH CHECK ((SELECT public.is_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clip_thumbnails TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clip_thumbnails TO nodi_worker;

COMMIT;

-- ---------------------------------------------------------------------------
-- 카드 하나당 영상 하나 (D190, 사용자 지시 2026-08-06)
--
-- 클립 카드가 정사각형 썸네일 카드가 되면서 여러 개가 붙으면 답보다 곁다리가
-- 커진다. config 기본값을 1로 내렸는데, **그것만으로는 아무 일도 안 일어난다** —
-- 튜너블은 admin 오버레이가 config를 이긴다(D62). 이미 돌고 있는 DB에는
-- `lecture_retrieve_top_k = 3`이 들어 있다(로컬 실측 2026-08-06).
--
-- **옛 기본값(3)에 그대로 있는 행만** 옮긴다. 관리자가 일부러 다른 값으로
-- 바꿔 둔 것을 덮으면 그 설정이 조용히 사라진다(D182에서 쓴 것과 같은 조건).
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE public.app_settings
   SET value = '1'::jsonb
 WHERE key = 'lecture_retrieve_top_k'
   AND value = '3'::jsonb;

COMMIT;
