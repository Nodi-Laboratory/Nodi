-- D144: RLS 정책이 **행마다** 도우미 함수를 부르지 않게 한다.
--
-- ## 무엇이 문제였나
--
-- 정책이 `can_access_session(session_id)`처럼 **열을 인자로** 함수를 부르면
-- 플래너는 그 값을 미리 계산할 수 없어 **행마다** 함수를 실행한다. 게다가
-- 이 도우미들은 SECURITY DEFINER + `SET search_path`라 인라인도 안 된다 —
-- 호출 하나하나가 설정 교체 + 서브쿼리다.
--
-- 실측(로컬, canvas_items 3,035행 중 3,021행이 한 세션):
--
--     RLS 없음(기준선)   0.999 ms   버퍼    68
--     현재 정책         42.678 ms   버퍼 9,355      ← 행당 3버퍼
--     이 마이그레이션    2.737 ms   버퍼   245      ← 15.6배 개선
--
-- 캔버스를 열 때마다 글 수만큼 이 비용을 낸다. 학생이 한 세션에 개념을 쌓을수록
-- 느려지는 구조였다 — 많이 쓴 학생이 더 기다린다.
--
-- ## 무엇을 바꾸나
--
-- 1. 인자 없는 도우미(`is_admin()`)는 `(SELECT is_admin())`로 감싼다. 감싸면
--    상관 부분질의가 아니므로 플래너가 **InitPlan으로 한 번만** 실행한다.
-- 2. 열을 받는 도우미는 **집합**으로 뒤집는다. `is_class_member(x)` 대신
--    `x IN (SELECT my_class_ids())` — 우변이 상관되지 않으므로 한 번 실행해
--    해시로 만들고, 행마다는 해시 조회만 한다.
-- 3. `auth.uid()`도 같은 이유로 감싼다.
--
-- **판정 결과는 하나도 바뀌지 않는다.** 새 집합 함수의 조건은 기존 도우미의
-- 본문을 그대로 옮긴 것이고, 적용 전후로 사용자 5명 × 테이블 14개 = 70개
-- 조합의 가시 행 수가 전부 같음을 확인했다(무관 교사 0건 유지 포함).
--
-- 도우미 함수 자체는 **지우지 않는다.** 앱과 다른 정책이 부르고 있고, 지우면
-- 이 마이그레이션이 곧 장애다.
--
-- 멱등: 정책은 DROP ... IF EXISTS 후 재생성, 함수는 CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 집합 도우미 — 정책이 InitPlan으로 한 번만 실행할 수 있는 형태
-- ---------------------------------------------------------------------------

-- 내가 볼 수 있는 세션. `can_access_session()`의 본문과 조건이 같다.
CREATE OR REPLACE FUNCTION public.accessible_session_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT s.id
    FROM public.sessions s
    WHERE s.owner_id = auth.uid()
       OR (s.space_kind = 'class' AND public.is_class_teacher(s.space_ref));
$$;

-- 내가 속한 학급. `is_class_member()`와 조건이 같다.
CREATE OR REPLACE FUNCTION public.my_class_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT cm.class_id FROM public.class_members cm WHERE cm.user_id = auth.uid();
$$;

-- 내가 가르치는 학급. `is_class_teacher()`와 조건이 같다(명부의 teacher 또는
-- classes.teacher_id).
CREATE OR REPLACE FUNCTION public.my_taught_class_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
    SELECT cm.class_id
    FROM public.class_members cm
    WHERE cm.user_id = auth.uid() AND cm.role_in_class = 'teacher'
    UNION
    SELECT c.id FROM public.classes c WHERE c.teacher_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.accessible_session_ids() TO nodi_app;
GRANT EXECUTE ON FUNCTION public.my_class_ids()           TO nodi_app;
GRANT EXECUTE ON FUNCTION public.my_taught_class_ids()    TO nodi_app;

-- ---------------------------------------------------------------------------
-- 세션에 딸린 것들 — 가장 뜨거운 경로(캔버스 열기)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS canvas_items_select ON public.canvas_items;
CREATE POLICY canvas_items_select ON public.canvas_items
    FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

DROP POLICY IF EXISTS canvas_items_select_admin ON public.canvas_items;
CREATE POLICY canvas_items_select_admin ON public.canvas_items
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS canvas_items_insert_owner ON public.canvas_items;
CREATE POLICY canvas_items_insert_owner ON public.canvas_items
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = canvas_items.session_id
                  AND s.owner_id = (SELECT auth.uid()))
    );

DROP POLICY IF EXISTS canvas_items_update_owner ON public.canvas_items;
CREATE POLICY canvas_items_update_owner ON public.canvas_items
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = canvas_items.session_id
                  AND s.owner_id = (SELECT auth.uid()))
    );

DROP POLICY IF EXISTS canvas_items_delete_owner ON public.canvas_items;
CREATE POLICY canvas_items_delete_owner ON public.canvas_items
    FOR DELETE USING (
        EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = canvas_items.session_id
                  AND s.owner_id = (SELECT auth.uid()))
    );

DROP POLICY IF EXISTS nodes_select ON public.nodes;
CREATE POLICY nodes_select ON public.nodes
    FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

DROP POLICY IF EXISTS nodes_select_admin ON public.nodes;
CREATE POLICY nodes_select_admin ON public.nodes
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS canvas_drawings_select ON public.canvas_drawings;
CREATE POLICY canvas_drawings_select ON public.canvas_drawings
    FOR SELECT USING (session_id IN (SELECT public.accessible_session_ids()));

DROP POLICY IF EXISTS canvas_drawings_select_admin ON public.canvas_drawings;
CREATE POLICY canvas_drawings_select_admin ON public.canvas_drawings
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS canvas_drawings_write_owner ON public.canvas_drawings;
CREATE POLICY canvas_drawings_write_owner ON public.canvas_drawings
    FOR ALL
    USING (
        EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = canvas_drawings.session_id
                  AND s.owner_id = (SELECT auth.uid()))
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.sessions s
                WHERE s.id = canvas_drawings.session_id
                  AND s.owner_id = (SELECT auth.uid()))
    );

-- ---------------------------------------------------------------------------
-- 세션 자체 · 학급
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS sessions_select ON public.sessions;
CREATE POLICY sessions_select ON public.sessions
    FOR SELECT USING (
        owner_id = (SELECT auth.uid())
        OR (space_kind = 'class' AND space_ref IN (SELECT public.my_taught_class_ids()))
    );

DROP POLICY IF EXISTS sessions_select_admin ON public.sessions;
CREATE POLICY sessions_select_admin ON public.sessions
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS sessions_insert_owner ON public.sessions;
CREATE POLICY sessions_insert_owner ON public.sessions
    FOR INSERT WITH CHECK (
        owner_id = (SELECT auth.uid())
        AND (space_kind = 'personal' OR space_ref IN (SELECT public.my_class_ids()))
    );

DROP POLICY IF EXISTS classes_select_member ON public.classes;
CREATE POLICY classes_select_member ON public.classes
    FOR SELECT USING (
        teacher_id = (SELECT auth.uid()) OR id IN (SELECT public.my_class_ids())
    );

DROP POLICY IF EXISTS classes_select_admin ON public.classes;
CREATE POLICY classes_select_admin ON public.classes
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS class_members_select ON public.class_members;
CREATE POLICY class_members_select ON public.class_members
    FOR SELECT USING (
        user_id = (SELECT auth.uid()) OR class_id IN (SELECT public.my_class_ids())
    );

DROP POLICY IF EXISTS class_members_select_admin ON public.class_members;
CREATE POLICY class_members_select_admin ON public.class_members
    FOR SELECT USING ((SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- 파일 · 청크 — RAG가 히트 뒤 본문을 다시 읽는 경로(불변식: Qdrant는 신뢰
-- 경계가 아니다). 청크는 파일 하나에 수백 행이라 행당 비용이 그대로 곱해진다.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS files_select_class ON public.files;
CREATE POLICY files_select_class ON public.files
    FOR SELECT USING (
        kind = ANY (ARRAY['class_material'::text, 'textbook'::text])
        AND space_ref IN (SELECT public.my_class_ids())
    );

DROP POLICY IF EXISTS files_select_admin ON public.files;
CREATE POLICY files_select_admin ON public.files
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS files_insert_own ON public.files;
CREATE POLICY files_insert_own ON public.files
    FOR INSERT WITH CHECK (
        owner_id = (SELECT auth.uid())
        AND (kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])
             OR space_ref IN (SELECT public.my_taught_class_ids()))
    );

DROP POLICY IF EXISTS files_update_own ON public.files;
CREATE POLICY files_update_own ON public.files
    FOR UPDATE USING (owner_id = (SELECT auth.uid()))
    WITH CHECK (
        owner_id = (SELECT auth.uid())
        AND (kind <> ALL (ARRAY['class_material'::text, 'textbook'::text])
             OR space_ref IN (SELECT public.my_taught_class_ids()))
    );

DROP POLICY IF EXISTS file_chunks_select_class ON public.file_chunks;
CREATE POLICY file_chunks_select_class ON public.file_chunks
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.files f
                WHERE f.id = file_chunks.file_id
                  AND f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])
                  AND f.space_ref IN (SELECT public.my_class_ids()))
    );

DROP POLICY IF EXISTS file_chunks_select_admin ON public.file_chunks;
CREATE POLICY file_chunks_select_admin ON public.file_chunks
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS chunk_atoms_select_class ON public.chunk_atoms;
CREATE POLICY chunk_atoms_select_class ON public.chunk_atoms
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.files f
                WHERE f.id = chunk_atoms.file_id
                  AND f.kind = ANY (ARRAY['class_material'::text, 'textbook'::text])
                  AND f.space_ref IN (SELECT public.my_class_ids()))
    );

DROP POLICY IF EXISTS chunk_atoms_select_admin ON public.chunk_atoms;
CREATE POLICY chunk_atoms_select_admin ON public.chunk_atoms
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS textbook_figures_select ON public.textbook_figures;
CREATE POLICY textbook_figures_select ON public.textbook_figures
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.files f
                WHERE f.id = textbook_figures.file_id
                  AND (f.owner_id = (SELECT auth.uid())
                       OR (f.kind = 'textbook'
                           AND f.space_ref IN (SELECT public.my_class_ids()))))
    );

DROP POLICY IF EXISTS textbook_figures_select_admin ON public.textbook_figures;
CREATE POLICY textbook_figures_select_admin ON public.textbook_figures
    FOR SELECT USING ((SELECT public.is_admin()));

-- ---------------------------------------------------------------------------
-- 나머지 관리자 정책 · 로그
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
CREATE POLICY profiles_select_admin ON public.profiles
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS ai_logs_select_admin ON public.ai_logs;
CREATE POLICY ai_logs_select_admin ON public.ai_logs
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS jobs_select_own ON public.jobs;
CREATE POLICY jobs_select_own ON public.jobs
    FOR SELECT USING (owner_id = (SELECT auth.uid()) OR (SELECT public.is_admin()));

DROP POLICY IF EXISTS app_settings_admin_select ON public.app_settings;
CREATE POLICY app_settings_admin_select ON public.app_settings
    FOR SELECT USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS app_settings_admin_insert ON public.app_settings;
CREATE POLICY app_settings_admin_insert ON public.app_settings
    FOR INSERT WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS app_settings_admin_update ON public.app_settings;
CREATE POLICY app_settings_admin_update ON public.app_settings
    FOR UPDATE USING ((SELECT public.is_admin()))
    WITH CHECK ((SELECT public.is_admin()));
