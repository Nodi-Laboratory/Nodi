-- ============================================================================
-- nodi — migration 0010 (visual RAG links + file tags + search; Stage 3b-2)
-- Tables: file_node_links, file_tags. RPCs: upsert_file_tags, search_file_chunks.
--
-- file_node_links = "use this file when answering from this branch": a file is
-- linked to a node; the link applies to that node and its descendant branch
-- (the app resolves which links apply to the current head's ancestor chain).
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0009.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. file_node_links
-- ---------------------------------------------------------------------------
create table if not exists public.file_node_links (
    id             uuid primary key default gen_random_uuid(),
    file_id        uuid not null references public.files (id) on delete cascade,
    target_node_id uuid not null references public.nodes (id) on delete cascade,
    owner_id       uuid not null references public.profiles (id) on delete cascade,
    created_at     timestamptz not null default now(),
    unique (file_id, target_node_id)
);

create index if not exists idx_file_node_links_node on public.file_node_links (target_node_id);
create index if not exists idx_file_node_links_file on public.file_node_links (file_id);

alter table public.file_node_links enable row level security;

drop policy if exists file_node_links_select_own on public.file_node_links;
create policy file_node_links_select_own on public.file_node_links
    for select using (owner_id = auth.uid());
drop policy if exists file_node_links_insert_own on public.file_node_links;
create policy file_node_links_insert_own on public.file_node_links
    for insert with check (owner_id = auth.uid());
drop policy if exists file_node_links_delete_own on public.file_node_links;
create policy file_node_links_delete_own on public.file_node_links
    for delete using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. file_tags — file <-> tags (shares the 0005 tags pool, owner x space)
-- ---------------------------------------------------------------------------
create table if not exists public.file_tags (
    file_id    uuid not null references public.files (id) on delete cascade,
    tag_id     uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (file_id, tag_id)
);

create index if not exists idx_file_tags_tag on public.file_tags (tag_id);

alter table public.file_tags enable row level security;

-- Readable when the parent file is the caller's (worker writes via service_role).
drop policy if exists file_tags_select_own on public.file_tags;
create policy file_tags_select_own on public.file_tags
    for select using (
        exists (
            select 1 from public.files f
            where f.id = file_id and f.owner_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- 3. upsert_file_tags — reuse/create tags in the file's (owner, space) and link
--    them to the file (cap `file_tag_max`=50). SECURITY DEFINER.
--    Callable by the file OWNER (auth.uid()) OR the service_role worker
--    (auth.role()='service_role'); the worker has no auth.uid().
-- ---------------------------------------------------------------------------
create or replace function public.upsert_file_tags(
    p_file_id uuid,
    p_names   text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner  uuid;
    v_kind   text;
    v_ref    uuid;
    v_name   text;
    v_tag_id uuid;
    v_stored text;
    v_result text[] := '{}';
    v_count  int := 0;
begin
    select owner_id, space_kind, space_ref
      into v_owner, v_kind, v_ref
      from public.files
     where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if auth.role() <> 'service_role' and v_owner <> auth.uid() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    foreach v_name in array coalesce(p_names, array[]::text[]) loop
        exit when v_count >= 50;
        v_name := nullif(btrim(v_name), '');
        if v_name is null then
            continue;
        end if;

        select id, name into v_tag_id, v_stored
          from public.tags
         where owner_id = v_owner
           and space_kind = v_kind
           and space_ref is not distinct from v_ref
           and lower(name) = lower(v_name)
         limit 1;

        if v_tag_id is null then
            insert into public.tags (owner_id, space_kind, space_ref, name, usage_count)
            values (v_owner, v_kind, v_ref, v_name, 0)
            returning id, name into v_tag_id, v_stored;
        end if;

        insert into public.file_tags (file_id, tag_id)
        values (p_file_id, v_tag_id)
        on conflict (file_id, tag_id) do nothing;

        if found then
            update public.tags
               set usage_count = usage_count + 1
             where id = v_tag_id;
        end if;

        v_result := array_append(v_result, v_stored);
        v_count := v_count + 1;
    end loop;

    return v_result;
end;
$$;

revoke execute on function public.upsert_file_tags(uuid, text[]) from public, anon;
grant  execute on function public.upsert_file_tags(uuid, text[])
    to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. search_file_chunks — cosine top-K over the caller's OWN linked file chunks.
--    SECURITY DEFINER, but explicitly filtered to f.owner_id = auth.uid(), so an
--    authenticated user can only search their own files (called at chat time
--    with the user's JWT).
-- ---------------------------------------------------------------------------
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
    distance   double precision
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
           (fc.embedding <=> p_query_embedding)::double precision as distance
      from public.file_chunks fc
      join public.files f on f.id = fc.file_id
     where fc.file_id = any (p_file_ids)
       and f.owner_id = auth.uid()
       and fc.status = 'embedded'
       and fc.embedding is not null
     order by fc.embedding <=> p_query_embedding
     limit greatest(1, p_k);
$$;

revoke execute on function public.search_file_chunks(vector, uuid[], int)
    from public, anon;
grant  execute on function public.search_file_chunks(vector, uuid[], int)
    to authenticated;

-- ============================================================================
-- End of 0010_file_rag_links.sql
-- ============================================================================
