-- ============================================================================
-- nodi — migration 0020 (RAG source detail; D41)
--
-- PURPOSE
--   D41: get_chunk_context — given a chunk id, return that chunk's FULL text +
--        its neighbours (seq ± p_neighbors) + location (file, filename, seq,
--        page) so the NotebookLM-style "⋯" panel can show the source passage on
--        demand. Full text is NOT persisted on nodes; it is fetched only when a
--        user opens the panel.
--
-- VISIBILITY: identical to search_file_chunks (0017) — the caller may read a
--   chunk only if they OWN the file OR it is a class_material of a class they
--   belong to. Out-of-scope chunks yield 0 rows (the endpoint maps that to 404).
--
-- NOTE ON FILENAME: public.files has NO `name` column (verified 0009/0012); the
--   human filename lives at the tail of `storage_path` ("{owner}/{file_id}/{name}").
--   `name` here = that basename, matching services/rag._file_basename().
--
-- APPLY ORDER: run AFTER 0001..0019. Non-destructive (adds one read-only RPC).
-- ============================================================================

create or replace function public.get_chunk_context(
    p_chunk_id  uuid,
    p_neighbors int default 1
)
returns table (
    file_id    uuid,
    name       text,
    seq        int,
    page       int,
    chunk_text text,
    prev_text  text,
    next_text  text
)
language sql
stable
security definer
set search_path = public
as $$
    with target as (
        select fc.id, fc.file_id, fc.seq, fc.chunk_text, fc.meta
          from public.file_chunks fc
          join public.files f on f.id = fc.file_id
         where fc.id = p_chunk_id
           and (
                f.owner_id = auth.uid()
             or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
           )
    )
    select t.file_id,
           split_part(
               f.storage_path, '/',
               array_length(string_to_array(f.storage_path, '/'), 1)
           ) as name,
           t.seq,
           -- null-safe page: only cast a clean integer string, else NULL.
           case
               when t.meta->>'page' ~ '^[0-9]+$' then (t.meta->>'page')::int
               else null
           end as page,
           t.chunk_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq - p_neighbors) as prev_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq + p_neighbors) as next_text
      from target t
      join public.files f on f.id = t.file_id;
$$;

revoke execute on function public.get_chunk_context(uuid, int) from public, anon;
grant  execute on function public.get_chunk_context(uuid, int) to authenticated;
