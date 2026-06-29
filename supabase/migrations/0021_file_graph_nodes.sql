-- ============================================================================
-- nodi — migration 0021 (file graph-node placements; Stage 06 자료모델 재설계)
--
-- PURPOSE (D58/D59 — 표시(배치) ↔ RAG(링크) 분리)
--   A file is owned by a SPACE, but its visual placement on a graph belongs to a
--   SESSION. Until now both "is this file a node on this graph?" (display) and
--   "is this file a RAG source for this branch?" (file_node_links) were tangled
--   into files.session_id, so linking a file to a branch did not necessarily
--   show it on the graph (item 8), and a file could only sit on ONE graph.
--
--   file_graph_nodes is a per-(file, session) PLACEMENT row: it records that a
--   file is shown as a free node on a session's graph, plus its coordinates. It
--   is INDEPENDENT of file_node_links — RAG retrieval still reads file_node_links
--   ONLY (unchanged). One file can be placed on many session graphs.
--
-- APPLY ORDER: run AFTER 0001..0020. NON-DESTRUCTIVE — a new table + indexes +
--   owner-only RLS + an idempotent BACKFILL of existing files.session_id
--   placements. Nothing is dropped or altered; files.session_id/position_x/y stay
--   in place (read path migrates to placements first; column cleanup is a later,
--   separate migration).
--
-- Apply via Supabase MCP apply_migration (leader). This pass writes the file
-- ONLY — DO NOT apply yet.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. file_graph_nodes — one placement per (file, session)
-- ---------------------------------------------------------------------------
create table if not exists public.file_graph_nodes (
    id          uuid primary key default gen_random_uuid(),
    file_id     uuid not null references public.files (id)    on delete cascade,
    session_id  uuid not null references public.sessions (id) on delete cascade,
    owner_id    uuid not null references public.profiles (id) on delete cascade,
    position_x  double precision,
    position_y  double precision,
    created_at  timestamptz not null default now(),
    unique (file_id, session_id)
);

create index if not exists idx_fgn_session on public.file_graph_nodes (session_id);
create index if not exists idx_fgn_file    on public.file_graph_nodes (file_id);

-- ---------------------------------------------------------------------------
-- 2. RLS — owner-only (matches files/sessions owner isolation)
-- ---------------------------------------------------------------------------
alter table public.file_graph_nodes enable row level security;

drop policy if exists fgn_select_own on public.file_graph_nodes;
create policy fgn_select_own on public.file_graph_nodes
    for select using (owner_id = auth.uid());

drop policy if exists fgn_insert_own on public.file_graph_nodes;
create policy fgn_insert_own on public.file_graph_nodes
    for insert with check (owner_id = auth.uid());

drop policy if exists fgn_update_own on public.file_graph_nodes;
create policy fgn_update_own on public.file_graph_nodes
    for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists fgn_delete_own on public.file_graph_nodes;
create policy fgn_delete_own on public.file_graph_nodes
    for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Non-destructive backfill: existing graph placements (files.session_id)
--    become file_graph_nodes rows so nothing disappears from current graphs.
--    Idempotent via the (file_id, session_id) unique constraint.
-- ---------------------------------------------------------------------------
insert into public.file_graph_nodes (file_id, session_id, owner_id, position_x, position_y)
select f.id, f.session_id, f.owner_id, f.position_x, f.position_y
from public.files f
where f.session_id is not null
on conflict (file_id, session_id) do nothing;

-- ============================================================================
-- End of 0021_file_graph_nodes.sql
-- ============================================================================
