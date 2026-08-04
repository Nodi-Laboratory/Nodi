-- D149: 강의 클립(숏폼) 추천 — admin 전역 카탈로그.
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
    subtitle_path text,                 -- 업로드한 자막 Storage 경로(개정 R1)
    title text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_videos_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'parsing'::text,'parsed'::text,'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_lecture_videos_package ON public.lecture_videos (package_id);

-- 챕터 = 클립. 임베딩 텍스트는 제목+본문(transcript). 타임라인 라벨은 start_sec 파생.
CREATE TABLE IF NOT EXISTS public.lecture_clips (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL REFERENCES public.lecture_videos(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    start_sec integer NOT NULL,
    end_sec integer,                    -- 다음 챕터 시작 = 구간 끝(마지막은 NULL, 개정 R1)
    title text NOT NULL,
    transcript text DEFAULT ''::text NOT NULL,   -- 챕터 구간 자막 본문(개정 R1)
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_clips_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'embedded'::text,'failed'::text]))),
    CONSTRAINT lecture_clips_video_seq_key UNIQUE (video_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_lecture_clips_video ON public.lecture_clips (video_id, status);

-- 원자 질문(PIKE-RAG D129 미러) — solar-pro3가 클립 본문에서 생성한 예상 질문.
CREATE TABLE IF NOT EXISTS public.lecture_clip_atoms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_id uuid NOT NULL REFERENCES public.lecture_clips(id) ON DELETE CASCADE,
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT lecture_clip_atoms_status_check CHECK
      ((status = ANY (ARRAY['pending'::text,'embedded'::text,'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_lecture_clip_atoms_clip ON public.lecture_clip_atoms (clip_id, status);

-- 선생님이 워크스페이스에 켠 패키지
CREATE TABLE IF NOT EXISTS public.class_lecture_packages (
    class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    package_id uuid NOT NULL REFERENCES public.lecture_packages(id) ON DELETE CASCADE,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (class_id, package_id)
);

-- jobs.kind 확장
-- **이 블록은 제약이 없을 때만 세운다** (D175).
--
-- 배포는 db/migrations/*.sql을 **매번 전부** 사전순으로 재실행한다. 예전에는
-- "drop→add는 그 자체로 멱등"이라고 적어 뒀는데, 그 전제는 **나중에 kind가
-- 늘면 깨진다**: 재실행이 목록을 도로 좁히고, 그 사이 생긴 새 kind 행이
-- 제약을 위반해 배포가 통째로 멈춘다(실측 2026-08-04, crosslink 행 때문에
-- 배포 실패). 전체 목록의 authority는 **가장 늦게 정렬되는 마이그레이션**
-- 하나만 갖는다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jobs_kind_check'
  ) THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check CHECK
      ((kind = ANY (ARRAY['embedding_split'::text,'embedding_batch'::text,
                          'figure_batch'::text,'atom_batch'::text,
                          'lecture_parse'::text,'lecture_embed'::text,
                          'lecture_atom'::text])));
  END IF;
END $$;

-- 캔버스 아이템 kind에 'clip' 추가 (D149) — 기 기동 DB의 CHECK 갱신.
-- canvas_items는 D122 마이그레이션이 CREATE TABLE IF NOT EXISTS로 만들었으므로
-- 재적용돼도 CHECK가 갱신되지 않는다 → 여기서 명시적으로 ALTER한다(멱등).
ALTER TABLE public.canvas_items DROP CONSTRAINT IF EXISTS canvas_items_kind_check;
ALTER TABLE public.canvas_items ADD CONSTRAINT canvas_items_kind_check
  CHECK (kind = ANY (ARRAY['concept'::text, 'note'::text, 'figure'::text, 'clip'::text]));

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

ALTER TABLE public.lecture_clip_atoms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lecture_clip_atoms_select ON public.lecture_clip_atoms;
CREATE POLICY lecture_clip_atoms_select ON public.lecture_clip_atoms FOR SELECT USING ((auth.uid() IS NOT NULL));
DROP POLICY IF EXISTS lecture_clip_atoms_admin ON public.lecture_clip_atoms;
CREATE POLICY lecture_clip_atoms_admin ON public.lecture_clip_atoms FOR ALL USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

ALTER TABLE public.class_lecture_packages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clp_select_member ON public.class_lecture_packages;
CREATE POLICY clp_select_member ON public.class_lecture_packages FOR SELECT
  USING ((class_id IN (SELECT public.my_class_ids())) OR (SELECT public.is_admin()));
DROP POLICY IF EXISTS clp_write_teacher ON public.class_lecture_packages;
CREATE POLICY clp_write_teacher ON public.class_lecture_packages FOR ALL
  USING (class_id IN (SELECT public.my_taught_class_ids()))
  WITH CHECK (class_id IN (SELECT public.my_taught_class_ids()));

-- GRANT: admin은 nodi_app 역할로 쓰기(RLS가 is_admin 강제). 워커 full.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips, public.lecture_clip_atoms TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lecture_packages, public.lecture_videos, public.lecture_clips, public.lecture_clip_atoms TO nodi_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_lecture_packages TO nodi_worker;

commit;
