-- TASK 6 (D129/D131): chunk_atoms 테이블 + jobs kind 확장 + figure 페이지 텍스트.
--
-- 빈 볼륨 신규 기동은 01_schema.sql이 커버한다 — 이 파일은 **이미 기동한 DB**에
-- 같은 변경을 얹는 경로다.
--
-- **멱등이어야 한다.** deploy.sh는 배포 때마다 db/migrations/*.sql을 전부 다시
-- 적용하고 ON_ERROR_STOP=1로 돈다. 1회 적용을 전제하면 첫 배포만 성공하고
-- 그다음 배포부터 "이미 있다"로 죽어 **배포가 영구히 막힌다.** 그래서
-- CREATE ... IF NOT EXISTS / DROP ... IF EXISTS 로만 쓴다.

begin;

-- ── 원자 질문 테이블 ──────────────────────────────────────────────────
-- 청크당 solar가 생성한 "이 청크로 답할 수 있는 질문"을 저장한다. 벡터는 Qdrant
-- chunk_atoms 컬렉션, 본문(question)·상태는 여기. file_chunks delete의 FK CASCADE로
-- 함께 지워진다(멱등 정리는 워커 split의 Qdrant 퍼지가 담당).
CREATE TABLE IF NOT EXISTS public.chunk_atoms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chunk_id uuid NOT NULL REFERENCES public.file_chunks(id) ON DELETE CASCADE,
    file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    chunk_seq integer NOT NULL,
    question text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT chunk_atoms_status_check CHECK
      ((status = ANY (ARRAY['pending'::text, 'embedded'::text, 'failed'::text])))
);
CREATE INDEX IF NOT EXISTS idx_chunk_atoms_file ON public.chunk_atoms (file_id, status);
CREATE INDEX IF NOT EXISTS idx_chunk_atoms_chunk ON public.chunk_atoms (chunk_id);

-- ── jobs.kind 확장 — atom_batch 추가 ──────────────────────────────────
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
      ((kind = ANY (ARRAY['embedding_split'::text, 'embedding_batch'::text,
                          'figure_batch'::text, 'atom_batch'::text])));
  END IF;
END $$;

-- ── figure 페이지 텍스트 (D131) — 비전 캡션 생성 프롬프트 컨텍스트 ────────
ALTER TABLE public.textbook_figures
  ADD COLUMN IF NOT EXISTS page_text text DEFAULT ''::text NOT NULL;

-- ── RLS: 쓰기는 워커(BYPASSRLS) 전용. SELECT는 file_chunks 정책과 동형 ────
-- (부모 파일 접근 가능 시 열람 — 매칭된 원자 질문 관측용).
ALTER TABLE public.chunk_atoms ENABLE ROW LEVEL SECURITY;

-- file_chunks_select_class/own/admin을 테이블명만 바꿔 복사한다 —
-- 접근 조건(owner or 학급 자료 멤버 or 관리자)이 글자 그대로 같아야 한다.
--
-- CREATE POLICY에는 IF NOT EXISTS가 없다. 지우고 다시 만든다 — 정책 정의가
-- 이 파일에만 있으므로 재생성이 곧 최신화다.
DROP POLICY IF EXISTS chunk_atoms_select_class ON public.chunk_atoms;
CREATE POLICY chunk_atoms_select_class ON public.chunk_atoms FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = chunk_atoms.file_id) AND (f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])) AND public.is_class_member(f.space_ref)))));

DROP POLICY IF EXISTS chunk_atoms_select_own ON public.chunk_atoms;
CREATE POLICY chunk_atoms_select_own ON public.chunk_atoms FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.files f
  WHERE ((f.id = chunk_atoms.file_id) AND (f.owner_id = ( SELECT auth.uid() AS uid))))));

DROP POLICY IF EXISTS chunk_atoms_select_admin ON public.chunk_atoms;
CREATE POLICY chunk_atoms_select_admin ON public.chunk_atoms FOR SELECT USING (public.is_admin());

-- GRANT: nodi_app은 SELECT만(쓰기는 RLS·GRANT 모두에서 차단). 워커는 BYPASSRLS로
-- 인제스트가 insert/update한다. 신규 볼륨 기동은 00_bootstrap의 default privileges가
-- 커버하지만, 기 기동 DB에는 이 명시 GRANT가 필요하다. GRANT는 원래 멱등이다.
GRANT SELECT ON public.chunk_atoms TO nodi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chunk_atoms TO nodi_worker;

commit;
