-- ============================================================================
-- nodi — migration 0016 (tag normalization + delete cascade; D29 · D30)
--
-- PURPOSE
--   D30: collapse表기 변형 duplicate tags into ONE row per concept, by adding a
--        normalized key `tags.norm_name` and a per-(owner,space) UNIQUE on it,
--        and making the reuse RPCs match on norm_name.
--   D29: `delete_file_cascade(p_file_id)` — when a file is deleted, remove its
--        chunks/links/file_tags (FK cascade) AND delete only the tags that became
--        ORPHANS (refcount node_tags+file_tags = 0); shared tags are preserved.
--
-- APPLY ORDER: run AFTER 0001..0015 (baseline 0015 = ai_logs).
--
-- ⚠️ DESTRUCTIVE STEP (section 3 — duplicate merge). It REMAPS node_tags/file_tags
--   to a canonical tag per (owner_id, space_kind, space_ref, norm_name) group and
--   DELETES the surplus tag rows. It is idempotent (re-running after the UNIQUE
--   index exists is a no-op: no duplicate groups remain), but irreversible.
--   BEFORE APPLYING (leader, via Supabase MCP): take a backup / snapshot and run
--   the COUNT queries below to record before/after numbers.
--
--   -- (A) total tags + how many will collapse (duplicate groups):
--   --   select count(*) as total_tags from public.tags;
--   --   select count(*) as surplus_to_delete from (
--   --     select 1 from public.tags
--   --      group by owner_id, space_kind, space_ref, public.nodi_norm_tag(name)
--   --     having count(*) > 1
--   --   ) g;   -- ≈ groups with dups; exact surplus = sum(count-1) per group:
--   --   select coalesce(sum(c-1),0) as rows_deleted from (
--   --     select count(*) c from public.tags
--   --      group by owner_id, space_kind, space_ref, public.nodi_norm_tag(name)
--   --     having count(*) > 1
--   --   ) g;
--   -- (B) link counts before/after (should be preserved, only de-duplicated):
--   --   select count(*) from public.node_tags;  select count(*) from public.file_tags;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. nodi_norm_tag(text) — the single normalization rule (DB = source of truth).
--    NFKC → casefold(lower) → collapse internal whitespace → strip surrounding
--    punctuation/space → trim. Returns NULL for an empty result.
-- ---------------------------------------------------------------------------
create or replace function public.nodi_norm_tag(p_in text)
returns text
language sql
immutable
set search_path = public
as $$
    select nullif(
        btrim(
            regexp_replace(
                regexp_replace(
                    lower(normalize(coalesce(p_in, ''), NFKC)),
                    '\s+', ' ', 'g'                       -- collapse whitespace
                ),
                '^[[:punct:][:space:]]+|[[:punct:][:space:]]+$', '', 'g'  -- strip ends
            )
        ),
        ''
    );
$$;

-- ---------------------------------------------------------------------------
-- 2. tags.norm_name column + backfill (idempotent).
-- ---------------------------------------------------------------------------
alter table public.tags add column if not exists norm_name text;

update public.tags
   set norm_name = public.nodi_norm_tag(name)
 where norm_name is null
    or norm_name is distinct from public.nodi_norm_tag(name);

-- Fallback: if normalization produced NULL (pathological all-punct name), keep a
-- stable key so the row is not lost to the UNIQUE index (use lower(name) or id).
update public.tags
   set norm_name = coalesce(nullif(lower(btrim(name)), ''), id::text)
 where norm_name is null;

-- ---------------------------------------------------------------------------
-- 3. DESTRUCTIVE — merge duplicate tags per (owner, space, norm_name).
--    canonical = oldest created_at (then smallest id). Remap links to canonical,
--    de-duplicate, delete surplus tags, then recompute usage_count from refs.
--    Idempotent: once UNIQUE holds there are no groups with >1, so this is a no-op.
-- ---------------------------------------------------------------------------
do $$
begin
    -- mapping duplicate_tag_id -> canonical_tag_id within each concept group
    create temporary table _tag_canon on commit drop as
    select t.id as dup_id,
           first_value(t.id) over (
               partition by t.owner_id, t.space_kind, t.space_ref, t.norm_name
               order by t.created_at asc, t.id asc
           ) as canonical_id
      from public.tags t;

    -- node_tags: add canonical links (skip existing), then drop the dup links
    insert into public.node_tags (node_id, tag_id, created_at)
    select nt.node_id, c.canonical_id, nt.created_at
      from public.node_tags nt
      join _tag_canon c on c.dup_id = nt.tag_id
     where c.canonical_id <> nt.tag_id
    on conflict (node_id, tag_id) do nothing;

    delete from public.node_tags nt
     using _tag_canon c
     where c.dup_id = nt.tag_id
       and c.canonical_id <> nt.tag_id;

    -- file_tags: same remap+dedup
    insert into public.file_tags (file_id, tag_id, created_at)
    select ft.file_id, c.canonical_id, ft.created_at
      from public.file_tags ft
      join _tag_canon c on c.dup_id = ft.tag_id
     where c.canonical_id <> ft.tag_id
    on conflict (file_id, tag_id) do nothing;

    delete from public.file_tags ft
     using _tag_canon c
     where c.dup_id = ft.tag_id
       and c.canonical_id <> ft.tag_id;

    -- delete the now-unreferenced surplus tag rows
    delete from public.tags t
     using _tag_canon c
     where c.dup_id = t.id
       and c.canonical_id <> t.id;
end
$$;

-- Recompute usage_count as the authoritative live refcount (self-heal, D29 #1).
update public.tags t
   set usage_count = (
        (select count(*) from public.node_tags nt where nt.tag_id = t.id)
      + (select count(*) from public.file_tags ft where ft.tag_id = t.id)
   );

-- ---------------------------------------------------------------------------
-- 4. Per-(owner,space) UNIQUE on the normalized key (after merge).
--    Coexists with the legacy lower(name) index from 0005 (compatible; norm is
--    a strict superset of case-folding).
-- ---------------------------------------------------------------------------
create unique index if not exists tags_owner_space_norm_uniq
    on public.tags (owner_id, space_kind, space_ref, norm_name);

-- ---------------------------------------------------------------------------
-- 5. upsert_node_tags — reuse-or-create by NORM_NAME (was lower(name)).
--    Display `name` keeps the FIRST-seen表기 (canonical = earliest row).
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
    v_norm   text;
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
        v_norm := public.nodi_norm_tag(v_name);
        if v_norm is null then
            continue;
        end if;

        -- Resolve existing tag by NORM_NAME within this (owner, space).
        select id, name into v_tag_id, v_stored
          from public.tags
         where owner_id = v_owner
           and space_kind = v_kind
           and space_ref is not distinct from v_ref
           and norm_name = v_norm
         limit 1;

        if v_tag_id is null then
            insert into public.tags (owner_id, space_kind, space_ref, name, norm_name, usage_count)
            values (v_owner, v_kind, v_ref, v_name, v_norm, 0)
            on conflict (owner_id, space_kind, space_ref, norm_name) do update
                set name = public.tags.name          -- keep first-seen表기
            returning id, name into v_tag_id, v_stored;
        end if;

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
-- 6. upsert_file_tags — reuse-or-create by NORM_NAME (was lower(name)).
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
    v_norm   text;
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
        v_norm := public.nodi_norm_tag(v_name);
        if v_norm is null then
            continue;
        end if;

        select id, name into v_tag_id, v_stored
          from public.tags
         where owner_id = v_owner
           and space_kind = v_kind
           and space_ref is not distinct from v_ref
           and norm_name = v_norm
         limit 1;

        if v_tag_id is null then
            insert into public.tags (owner_id, space_kind, space_ref, name, norm_name, usage_count)
            values (v_owner, v_kind, v_ref, v_name, v_norm, 0)
            on conflict (owner_id, space_kind, space_ref, norm_name) do update
                set name = public.tags.name
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
-- 7. delete_file_cascade(p_file_id) — owner-only file delete + orphan-tag cleanup.
--    Single transaction: collect the file's tag_ids → delete the file (FK cascade
--    removes file_chunks/file_node_links/file_tags) → recompute usage_count for
--    those tags → delete the ones that fell to refcount 0 (orphans). Shared tags
--    (still used by other nodes/files) are preserved.
--    Storage object deletion stays in the app (service_role) — see files.py.
-- ---------------------------------------------------------------------------
create or replace function public.delete_file_cascade(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner   uuid;
    v_tag_ids uuid[];
begin
    select owner_id into v_owner from public.files where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    -- (a) tags this file contributed to (capture before the cascade wipes file_tags)
    select coalesce(array_agg(tag_id), '{}')
      into v_tag_ids
      from public.file_tags
     where file_id = p_file_id;

    -- (b) delete the file → cascades file_chunks / file_node_links / file_tags
    delete from public.files where id = p_file_id;

    -- (c) refcount self-heal + orphan removal for the affected tags only
    if array_length(v_tag_ids, 1) is not null then
        update public.tags t
           set usage_count = (
                (select count(*) from public.node_tags nt where nt.tag_id = t.id)
              + (select count(*) from public.file_tags ft where ft.tag_id = t.id)
           )
         where t.id = any (v_tag_ids);

        delete from public.tags t
         where t.id = any (v_tag_ids)
           and not exists (select 1 from public.node_tags nt where nt.tag_id = t.id)
           and not exists (select 1 from public.file_tags ft where ft.tag_id = t.id);
    end if;
end;
$$;

revoke execute on function public.delete_file_cascade(uuid) from public, anon;
grant  execute on function public.delete_file_cascade(uuid) to authenticated;

-- ============================================================================
-- End of 0016_tag_normalize_cascade.sql
-- ============================================================================
