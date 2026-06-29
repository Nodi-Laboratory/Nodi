-- ============================================================================
-- nodi — migration 0025 (FK covering indexes; 08 refactoring D72)
--
-- PROBLEM (Supabase performance advisor: unindexed_foreign_keys ×9)
--   Several foreign-key columns used in joins / filters lack a covering index,
--   so the planner may seq-scan / hash-join on them.
--
-- FIX  Add a covering index for the FK columns that are clearly used in joins
--      or filters. ADD-ONLY (create index if not exists) — NON-DESTRUCTIVE.
--      Writes get marginally heavier, so only the obviously-useful 7 are added.
--      Deferred (low-frequency / admin-only, decide after measurement):
--        app_settings.updated_by, jobs.parent_job_id  — intentionally NOT added.
--
-- Apply via Supabase MCP (leader). baseline = 0023. Safe to run anytime.
-- ============================================================================

-- sessions.current_head_id -> nodes.id (FK from 0001)
create index if not exists idx_sessions_current_head
    on public.sessions (current_head_id);

-- sessions.root_node_id -> nodes.id (FK from 0001)
create index if not exists idx_sessions_root_node
    on public.sessions (root_node_id);

-- classes.teacher_id -> profiles.id (FK from 0001; teacher_classes / overview joins)
create index if not exists idx_classes_teacher
    on public.classes (teacher_id);

-- file_graph_nodes.owner_id -> profiles.id (FK from 0021; owner-scoped RLS reads)
create index if not exists idx_fgn_owner
    on public.file_graph_nodes (owner_id);

-- file_node_links.owner_id -> profiles.id (FK from 0010; owner-scoped RLS reads)
create index if not exists idx_fnl_owner
    on public.file_node_links (owner_id);

-- files.uploader_id -> profiles.id (FK from 0009)
create index if not exists idx_files_uploader
    on public.files (uploader_id);

-- ai_logs.node_id -> nodes.id (FK from 0015)
create index if not exists idx_ai_logs_node
    on public.ai_logs (node_id);

-- ============================================================================
-- End of 0025_fk_covering_indexes.sql
-- ============================================================================
