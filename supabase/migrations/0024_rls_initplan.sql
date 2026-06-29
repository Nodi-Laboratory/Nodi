-- ============================================================================
-- nodi — migration 0024 (RLS initplan optimization; 08 refactoring D71)
--
-- PROBLEM (Supabase performance advisor: auth_rls_initplan ×40)
--   Most RLS policy expressions call auth.uid() DIRECTLY. Postgres re-evaluates
--   such volatile-looking calls ONCE PER ROW scanned, so on big tables
--   (nodes, file_chunks, ai_logs, …) the per-row auth.uid() dominates scan cost.
--
-- FIX (Supabase official guidance)
--   Wrap each direct auth.uid() as (select auth.uid()). The planner then treats
--   it as an InitPlan and evaluates it ONCE PER QUERY. The expression's RESULT
--   VALUE is identical, only the evaluation COUNT drops from N rows to 1.
--   => Visibility / writability is COMPLETELY UNCHANGED. Non-destructive.
--
-- SCOPE / METHOD
--   * Exactly the 40 policies the advisor flagged are touched — i.e. every policy
--     whose USING/WITH CHECK contains a DIRECT auth.uid(). The count of 40 matches
--     the advisor exactly (see per-table comments below).
--   * NO policy uses current_setting() anywhere, so this migration only wraps
--     auth.uid(). (If any appears later, wrap it as (select current_setting(x)).)
--   * Policies that do NOT contain a direct auth.uid() are LEFT UNTOUCHED:
--       - *_select_admin (profiles/sessions/ai_sessions/ai_steps/ai_logs) use
--         public.is_admin() only;
--       - files_select_class / file_chunks_select_class use is_class_member();
--       - nodes_select / node_tags_select use public.can_access_session();
--     These were NOT flagged by auth_rls_initplan and changing them is out of
--     scope (their auth.uid() lives inside SECURITY DEFINER helpers, not policy
--     expressions).
--   * Helper-function CALLS that take a column argument
--     (is_class_member(space_ref), is_class_teacher(space_ref),
--      can_access_session(session_id)) are NOT wrappable into an InitPlan (they
--     depend on the row) and are intentionally LEFT AS-IS.
--   * ALTER POLICY is used (not drop+create) so policyname / roles / cmd are
--     GUARANTEED unchanged; only the USING / WITH CHECK expressions are reset to
--     the original definition with auth.uid() wrapped. Each block annotates the
--     ORIGINAL → WRAPPED expression (source migration noted) for 1:1 review.
--
-- NON-DESTRUCTIVE. Apply via Supabase MCP (leader) AFTER cross-checking the
-- original expressions against live pg_policies. baseline = 0023.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles  (flagged policies: profiles_select_own, profiles_update_own)
--   profiles_select_admin uses is_admin() only — NOT touched.
-- ---------------------------------------------------------------------------
-- profiles_select_own [0001] SELECT
--   orig: id = auth.uid()
--   wrap: id = (select auth.uid())
alter policy profiles_select_own on public.profiles
    using ( id = (select auth.uid()) );

-- profiles_update_own [0001] UPDATE (using + with check)
--   orig: id = auth.uid()  /  id = auth.uid()
--   wrap: id = (select auth.uid())  /  id = (select auth.uid())
alter policy profiles_update_own on public.profiles
    using ( id = (select auth.uid()) )
    with check ( id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- classes  (classes_select_member, classes_insert_teacher, classes_update_teacher)
-- ---------------------------------------------------------------------------
-- classes_select_member [0001] SELECT
--   orig: teacher_id = auth.uid() or public.is_class_member(id)
--   wrap: teacher_id = (select auth.uid()) or public.is_class_member(id)
alter policy classes_select_member on public.classes
    using ( teacher_id = (select auth.uid()) or public.is_class_member(id) );

-- classes_insert_teacher [0003] INSERT (with check)
--   orig: teacher_id = auth.uid()
--           and exists (select 1 from public.profiles p
--                        where p.id = auth.uid() and p.role = 'teacher')
--   wrap: auth.uid() -> (select auth.uid()) in BOTH places
alter policy classes_insert_teacher on public.classes
    with check (
        teacher_id = (select auth.uid())
        and exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid()) and p.role = 'teacher'
        )
    );

-- classes_update_teacher [0001] UPDATE (using + with check)
--   orig: teacher_id = auth.uid()  /  teacher_id = auth.uid()
--   wrap: teacher_id = (select auth.uid())  /  teacher_id = (select auth.uid())
alter policy classes_update_teacher on public.classes
    using ( teacher_id = (select auth.uid()) )
    with check ( teacher_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- class_members  (class_members_select, class_members_delete_self)
--   class_members_insert_self was dropped in 0003 — does not exist.
-- ---------------------------------------------------------------------------
-- class_members_select [0001] SELECT
--   orig: user_id = auth.uid() or public.is_class_member(class_id)
--   wrap: user_id = (select auth.uid()) or public.is_class_member(class_id)
alter policy class_members_select on public.class_members
    using ( user_id = (select auth.uid()) or public.is_class_member(class_id) );

-- class_members_delete_self [0001] DELETE
--   orig: user_id = auth.uid()
--   wrap: user_id = (select auth.uid())
alter policy class_members_delete_self on public.class_members
    using ( user_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- sessions  (sessions_select, sessions_insert_owner, sessions_update_owner,
--            sessions_delete_owner) — sessions_select_admin (is_admin) untouched.
-- ---------------------------------------------------------------------------
-- sessions_select [0003] SELECT
--   orig: owner_id = auth.uid()
--           or (space_kind = 'class' and public.is_class_teacher(space_ref))
--   wrap: owner_id = (select auth.uid()) or (… is_class_teacher(space_ref))
alter policy sessions_select on public.sessions
    using (
        owner_id = (select auth.uid())
        or (space_kind = 'class' and public.is_class_teacher(space_ref))
    );

-- sessions_insert_owner [0003] INSERT (with check)
--   orig: owner_id = auth.uid()
--           and (space_kind = 'personal' or public.is_class_member(space_ref))
--   wrap: owner_id = (select auth.uid()) and (… is_class_member(space_ref))
alter policy sessions_insert_owner on public.sessions
    with check (
        owner_id = (select auth.uid())
        and (
            space_kind = 'personal'
            or public.is_class_member(space_ref)
        )
    );

-- sessions_update_owner [0001] UPDATE (using + with check)
--   orig: owner_id = auth.uid()  /  owner_id = auth.uid()
--   wrap: owner_id = (select auth.uid())  /  owner_id = (select auth.uid())
alter policy sessions_update_owner on public.sessions
    using ( owner_id = (select auth.uid()) )
    with check ( owner_id = (select auth.uid()) );

-- sessions_delete_owner [0001] DELETE
--   orig: owner_id = auth.uid()
--   wrap: owner_id = (select auth.uid())
alter policy sessions_delete_owner on public.sessions
    using ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- nodes  (nodes_insert_owner, nodes_update_owner, nodes_delete_owner)
--   nodes_select uses can_access_session() — NOT touched.
--   NOTE: nodes_update_owner has USING ONLY (no WITH CHECK) in 0001 — keep it so.
-- ---------------------------------------------------------------------------
-- nodes_insert_owner [0001] INSERT (with check)
--   orig: exists (select 1 from public.sessions s
--                  where s.id = session_id and s.owner_id = auth.uid())
--   wrap: … s.owner_id = (select auth.uid())
alter policy nodes_insert_owner on public.nodes
    with check (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );

-- nodes_update_owner [0001] UPDATE (USING only — no WITH CHECK)
--   orig: exists (select 1 from public.sessions s
--                  where s.id = session_id and s.owner_id = auth.uid())
--   wrap: … s.owner_id = (select auth.uid())
alter policy nodes_update_owner on public.nodes
    using (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );

-- nodes_delete_owner [0001] DELETE
--   orig: exists (select 1 from public.sessions s
--                  where s.id = session_id and s.owner_id = auth.uid())
--   wrap: … s.owner_id = (select auth.uid())
alter policy nodes_delete_owner on public.nodes
    using (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- tags  (tags_select_own, tags_insert_own, tags_update_own, tags_delete_own)
-- ---------------------------------------------------------------------------
-- tags_select_own [0005] SELECT       orig: owner_id = auth.uid()
alter policy tags_select_own on public.tags
    using ( owner_id = (select auth.uid()) );

-- tags_insert_own [0005] INSERT       orig: owner_id = auth.uid()
alter policy tags_insert_own on public.tags
    with check ( owner_id = (select auth.uid()) );

-- tags_update_own [0005] UPDATE (using + with check)  orig: owner_id = auth.uid()
alter policy tags_update_own on public.tags
    using ( owner_id = (select auth.uid()) )
    with check ( owner_id = (select auth.uid()) );

-- tags_delete_own [0005] DELETE       orig: owner_id = auth.uid()
alter policy tags_delete_own on public.tags
    using ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- node_tags  (node_tags_insert_owner, node_tags_delete_owner)
--   node_tags_select uses can_access_session() — NOT touched.
-- ---------------------------------------------------------------------------
-- node_tags_insert_owner [0005] INSERT (with check)
--   orig: exists (select 1 from public.nodes n
--                  join public.sessions s on s.id = n.session_id
--                  where n.id = node_id and s.owner_id = auth.uid())
alter policy node_tags_insert_owner on public.node_tags
    with check (
        exists (
            select 1 from public.nodes n
            join public.sessions s on s.id = n.session_id
            where n.id = node_id and s.owner_id = (select auth.uid())
        )
    );

-- node_tags_delete_owner [0005] DELETE
--   orig: exists (… join … where n.id = node_id and s.owner_id = auth.uid())
alter policy node_tags_delete_owner on public.node_tags
    using (
        exists (
            select 1 from public.nodes n
            join public.sessions s on s.id = n.session_id
            where n.id = node_id and s.owner_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- ai_sessions  (ai_sessions_select_own, ai_sessions_insert_own)
--   ai_sessions_select_admin uses is_admin() — NOT touched.
-- ---------------------------------------------------------------------------
-- ai_sessions_select_own [0006] SELECT   orig: owner_id = auth.uid()
alter policy ai_sessions_select_own on public.ai_sessions
    using ( owner_id = (select auth.uid()) );

-- ai_sessions_insert_own [0006] INSERT   orig: owner_id = auth.uid()
alter policy ai_sessions_insert_own on public.ai_sessions
    with check ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- ai_steps  (ai_steps_select_own, ai_steps_insert_own)
--   ai_steps_select_admin uses is_admin() — NOT touched.
-- ---------------------------------------------------------------------------
-- ai_steps_select_own [0006] SELECT
--   orig: exists (select 1 from public.ai_sessions s
--                  where s.id = ai_session_id and s.owner_id = auth.uid())
alter policy ai_steps_select_own on public.ai_steps
    using (
        exists (
            select 1 from public.ai_sessions s
            where s.id = ai_session_id and s.owner_id = (select auth.uid())
        )
    );

-- ai_steps_insert_own [0006] INSERT
--   orig: exists (… where s.id = ai_session_id and s.owner_id = auth.uid())
alter policy ai_steps_insert_own on public.ai_steps
    with check (
        exists (
            select 1 from public.ai_sessions s
            where s.id = ai_session_id and s.owner_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- ai_logs  (ai_logs_select_own, ai_logs_insert_own)
--   ai_logs_select_admin uses is_admin() — NOT touched.
-- ---------------------------------------------------------------------------
-- ai_logs_select_own [0015] SELECT   orig: owner_id = auth.uid()
alter policy ai_logs_select_own on public.ai_logs
    using ( owner_id = (select auth.uid()) );

-- ai_logs_insert_own [0015] INSERT   orig: owner_id = auth.uid()
alter policy ai_logs_insert_own on public.ai_logs
    with check ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- files  (files_select_own, files_insert_own, files_update_own, files_delete_own)
--   files_select_class uses is_class_member() — NOT touched.
--   files_insert_own is the 0013 version (defense-in-depth class_material guard).
-- ---------------------------------------------------------------------------
-- files_select_own [0009] SELECT   orig: owner_id = auth.uid()
alter policy files_select_own on public.files
    using ( owner_id = (select auth.uid()) );

-- files_insert_own [0013] INSERT (with check)
--   orig: owner_id = auth.uid()
--           and (kind <> 'class_material' or public.is_class_teacher(space_ref))
--   wrap: owner_id = (select auth.uid()) and (… is_class_teacher(space_ref))
alter policy files_insert_own on public.files
    with check (
        owner_id = (select auth.uid())
        and (kind <> 'class_material' or public.is_class_teacher(space_ref))
    );

-- files_update_own [0009] UPDATE (using + with check)  orig: owner_id = auth.uid()
alter policy files_update_own on public.files
    using ( owner_id = (select auth.uid()) )
    with check ( owner_id = (select auth.uid()) );

-- files_delete_own [0009] DELETE   orig: owner_id = auth.uid()
alter policy files_delete_own on public.files
    using ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- file_chunks  (file_chunks_select_own)
--   file_chunks_select_class uses is_class_member() — NOT touched.
-- ---------------------------------------------------------------------------
-- file_chunks_select_own [0009] SELECT
--   orig: exists (select 1 from public.files f
--                  where f.id = file_id and f.owner_id = auth.uid())
alter policy file_chunks_select_own on public.file_chunks
    using (
        exists (
            select 1 from public.files f
            where f.id = file_id and f.owner_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- jobs  (jobs_select_own)  — only a select policy exists (workers use service_role)
-- ---------------------------------------------------------------------------
-- jobs_select_own [0009] SELECT
--   orig: owner_id = auth.uid() or public.is_admin()
--   wrap: owner_id = (select auth.uid()) or public.is_admin()
alter policy jobs_select_own on public.jobs
    using ( owner_id = (select auth.uid()) or public.is_admin() );

-- ---------------------------------------------------------------------------
-- file_node_links  (select_own, insert_own, delete_own)
-- ---------------------------------------------------------------------------
-- file_node_links_select_own [0010] SELECT   orig: owner_id = auth.uid()
alter policy file_node_links_select_own on public.file_node_links
    using ( owner_id = (select auth.uid()) );

-- file_node_links_insert_own [0010] INSERT   orig: owner_id = auth.uid()
alter policy file_node_links_insert_own on public.file_node_links
    with check ( owner_id = (select auth.uid()) );

-- file_node_links_delete_own [0010] DELETE   orig: owner_id = auth.uid()
alter policy file_node_links_delete_own on public.file_node_links
    using ( owner_id = (select auth.uid()) );

-- ---------------------------------------------------------------------------
-- file_tags  (file_tags_select_own)
-- ---------------------------------------------------------------------------
-- file_tags_select_own [0010] SELECT
--   orig: exists (select 1 from public.files f
--                  where f.id = file_id and f.owner_id = auth.uid())
alter policy file_tags_select_own on public.file_tags
    using (
        exists (
            select 1 from public.files f
            where f.id = file_id and f.owner_id = (select auth.uid())
        )
    );

-- ---------------------------------------------------------------------------
-- file_graph_nodes  (fgn_select_own, fgn_insert_own, fgn_update_own, fgn_delete_own)
-- ---------------------------------------------------------------------------
-- fgn_select_own [0021] SELECT   orig: owner_id = auth.uid()
alter policy fgn_select_own on public.file_graph_nodes
    using ( owner_id = (select auth.uid()) );

-- fgn_insert_own [0021] INSERT   orig: owner_id = auth.uid()
alter policy fgn_insert_own on public.file_graph_nodes
    with check ( owner_id = (select auth.uid()) );

-- fgn_update_own [0021] UPDATE (using + with check)  orig: owner_id = auth.uid()
alter policy fgn_update_own on public.file_graph_nodes
    using ( owner_id = (select auth.uid()) )
    with check ( owner_id = (select auth.uid()) );

-- fgn_delete_own [0021] DELETE   orig: owner_id = auth.uid()
alter policy fgn_delete_own on public.file_graph_nodes
    using ( owner_id = (select auth.uid()) );

-- ============================================================================
-- Summary: 40 policies altered (auth.uid() -> (select auth.uid())), matching
-- auth_rls_initplan ×40. Per-table flagged counts:
--   profiles 2, classes 3, class_members 2, sessions 4, nodes 3, tags 4,
--   node_tags 2, ai_sessions 2, ai_steps 2, ai_logs 2, files 4, file_chunks 1,
--   jobs 1, file_node_links 3, file_tags 1, file_graph_nodes 4  = 40.
-- Visibility/writability unchanged; only per-row -> per-query evaluation.
-- End of 0024_rls_initplan.sql
-- ============================================================================
