-- ============================================================================
-- nodi — migration 0017 (RAG source provenance; D32 + D34/D35 correlation)
--
-- PURPOSE
--   D32: persist where a RAG answer came from. Adds `nodes.rag_sources jsonb`
--        (per-answer source list) and exposes the chunk `meta` (page/etc, when
--        present) from search_file_chunks so the app can record file·#seq·page.
--   D34/D35: composite index on ai_logs(session_id, created_at) so the admin turn
--        detail can correlate a turn with its ReAct traces quickly.
--
-- APPLY ORDER: run AFTER 0001..0016. Non-destructive (additive column + index +
--   a CREATE-OR-REPLACE that only widens the RPC's return columns).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. nodes.rag_sources — provenance of an answer node's RAG context.
--    Shape: [ {file_id, name, seq, page?, distance, snippet} ] (D32 / D35).
-- ---------------------------------------------------------------------------
alter table public.nodes
    add column if not exists rag_sources jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. search_file_chunks — also return chunk `meta` (page metadata when the
--    splitter stored it). seq was already returned (0010/0012). The RETURNS
--    TABLE signature changes, so DROP then re-create (keeps 0012's class-material
--    visibility: owner OR class member of a class_material).
-- ---------------------------------------------------------------------------
drop function if exists public.search_file_chunks(vector, uuid[], int);

create or replace function public.search_file_chunks(
    p_query_embedding vector(768),
    p_file_ids        uuid[],
    p_k               int default 5
)
returns table (
    file_id    uuid,
    chunk_id   uuid,
    seq        int,
    chunk_text text,
    distance   double precision,
    meta       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
    select fc.file_id,
           fc.id,
           fc.seq,
           fc.chunk_text,
           (fc.embedding <=> p_query_embedding)::double precision as distance,
           fc.meta
      from public.file_chunks fc
      join public.files f on f.id = fc.file_id
     where fc.file_id = any (p_file_ids)
       and (
            f.owner_id = auth.uid()
         or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
       )
       and fc.status = 'embedded'
       and fc.embedding is not null
     order by fc.embedding <=> p_query_embedding
     limit greatest(1, p_k);
$$;

revoke execute on function public.search_file_chunks(vector, uuid[], int)
    from public, anon;
grant  execute on function public.search_file_chunks(vector, uuid[], int)
    to authenticated;

-- ---------------------------------------------------------------------------
-- 3. ai_logs(session_id, created_at) — turn↔trace correlation (D34/D35).
-- ---------------------------------------------------------------------------
create index if not exists idx_ai_logs_session_created
    on public.ai_logs (session_id, created_at desc);

-- ai_sessions(session_id) — fast "traces for THIS session" filter (D34 timeline).
create index if not exists idx_ai_sessions_session
    on public.ai_sessions (session_id);

-- ============================================================================
-- End of 0017_rag_sources.sql
-- ============================================================================
