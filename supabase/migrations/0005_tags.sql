-- ============================================================================
-- nodi — migration 0005 (concept tags; Stage 2 Part A)
-- Tables: tags, node_tags
-- Isolation: tags are scoped to (owner_id, space_kind, space_ref). Even inside a
-- CLASS space a tag belongs to the individual student (students are mutually
-- private, consistent with 0003 R2). Teacher access to student tags is Stage 4.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0004.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. tags
-- ---------------------------------------------------------------------------
create table if not exists public.tags (
    id          uuid primary key default gen_random_uuid(),
    owner_id    uuid not null references public.profiles (id) on delete cascade,
    space_kind  text not null default 'personal'
                  check (space_kind in ('personal', 'class')),
    -- personal -> owner's user id; class -> classes.id (mirrors sessions).
    space_ref   uuid,
    name        text not null,
    usage_count integer not null default 0,
    created_at  timestamptz not null default now()
);

-- One concept per space (case-insensitive) — dedups reuse vs. new.
create unique index if not exists tags_owner_space_name_uniq
    on public.tags (owner_id, space_kind, space_ref, lower(name));

create index if not exists idx_tags_owner_space
    on public.tags (owner_id, space_kind, space_ref);

-- ---------------------------------------------------------------------------
-- 2. node_tags  (a conversation node carries 1..3 tags)
-- ---------------------------------------------------------------------------
create table if not exists public.node_tags (
    node_id    uuid not null references public.nodes (id) on delete cascade,
    tag_id     uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (node_id, tag_id)
);

create index if not exists idx_node_tags_tag_id  on public.node_tags (tag_id);
create index if not exists idx_node_tags_node_id on public.node_tags (node_id);

-- ---------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------
alter table public.tags      enable row level security;
alter table public.node_tags enable row level security;

-- tags: strictly the owner's own rows.
drop policy if exists tags_select_own on public.tags;
create policy tags_select_own on public.tags
    for select using (owner_id = auth.uid());

drop policy if exists tags_insert_own on public.tags;
create policy tags_insert_own on public.tags
    for insert with check (owner_id = auth.uid());

drop policy if exists tags_update_own on public.tags;
create policy tags_update_own on public.tags
    for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists tags_delete_own on public.tags;
create policy tags_delete_own on public.tags
    for delete using (owner_id = auth.uid());

-- node_tags: readable if the node's session is accessible (owner / class
-- teacher, via 0003 can_access_session); writable only by the session owner.
drop policy if exists node_tags_select on public.node_tags;
create policy node_tags_select on public.node_tags
    for select using (
        exists (
            select 1 from public.nodes n
            where n.id = node_id
              and public.can_access_session(n.session_id)
        )
    );

drop policy if exists node_tags_insert_owner on public.node_tags;
create policy node_tags_insert_owner on public.node_tags
    for insert with check (
        exists (
            select 1 from public.nodes n
            join public.sessions s on s.id = n.session_id
            where n.id = node_id and s.owner_id = auth.uid()
        )
    );

drop policy if exists node_tags_delete_owner on public.node_tags;
create policy node_tags_delete_owner on public.node_tags
    for delete using (
        exists (
            select 1 from public.nodes n
            join public.sessions s on s.id = n.session_id
            where n.id = node_id and s.owner_id = auth.uid()
        )
    );

-- ---------------------------------------------------------------------------
-- 4. upsert_node_tags RPC — reuse-or-create tags in the node's space and link
--    them to the node, atomically. SECURITY DEFINER; ownership enforced inside.
--    Returns the stored tag names actually attached (for the `done`/`tags` SSE).
-- ---------------------------------------------------------------------------
create or replace function public.upsert_node_tags(
    p_node_id    uuid,
    p_session_id uuid,
    p_names      text[]
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
begin
    select owner_id, space_kind, space_ref
      into v_owner, v_kind, v_ref
      from public.sessions
     where id = p_session_id;

    if v_owner is null then
        raise exception 'session not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not session owner' using errcode = 'insufficient_privilege';
    end if;
    if not exists (
        select 1 from public.nodes n
        where n.id = p_node_id and n.session_id = p_session_id
    ) then
        raise exception 'node not in session' using errcode = 'foreign_key_violation';
    end if;

    foreach v_name in array coalesce(p_names, array[]::text[]) loop
        v_name := nullif(btrim(v_name), '');
        if v_name is null then
            continue;
        end if;

        -- Resolve existing tag (case-insensitive) within this (owner, space).
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

        -- Link to node; only count a NEW attachment (avoid double counting).
        insert into public.node_tags (node_id, tag_id)
        values (p_node_id, v_tag_id)
        on conflict (node_id, tag_id) do nothing;

        if found then
            update public.tags
               set usage_count = usage_count + 1
             where id = v_tag_id;
        end if;

        v_result := array_append(v_result, v_stored);
    end loop;

    return v_result;
end;
$$;

revoke execute on function public.upsert_node_tags(uuid, uuid, text[]) from public, anon;
grant  execute on function public.upsert_node_tags(uuid, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. tag_cooccurrence RPC — tag pairs co-attached on the same node, within the
--    caller's space. Material for the concept page's "tree canopy" edges.
--    SECURITY DEFINER + explicit owner filter keeps isolation.
-- ---------------------------------------------------------------------------
create or replace function public.tag_cooccurrence(
    p_space_kind text,
    p_space_ref  uuid
)
returns table (
    tag_a  uuid,
    tag_b  uuid,
    name_a text,
    name_b text,
    count  bigint
)
language sql
stable
security definer
set search_path = public
as $$
    select na.tag_id, nb.tag_id, t1.name, t2.name, count(*)::bigint
      from public.node_tags na
      join public.node_tags nb
        on na.node_id = nb.node_id and na.tag_id < nb.tag_id
      join public.tags t1 on t1.id = na.tag_id
      join public.tags t2 on t2.id = nb.tag_id
     where t1.owner_id = auth.uid()
       and t2.owner_id = auth.uid()
       and t1.space_kind = p_space_kind
       and t2.space_kind = p_space_kind
       and t1.space_ref is not distinct from p_space_ref
       and t2.space_ref is not distinct from p_space_ref
     group by na.tag_id, nb.tag_id, t1.name, t2.name
     order by count(*) desc;
$$;

revoke execute on function public.tag_cooccurrence(text, uuid) from public, anon;
grant  execute on function public.tag_cooccurrence(text, uuid) to authenticated;

-- ============================================================================
-- End of 0005_tags.sql
-- ============================================================================
