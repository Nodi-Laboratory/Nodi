-- ============================================================================
-- nodi — migration 0014 (file tag read RPC; Stage 3b-3)
-- get_file_tags(): return a file's tag names to anyone who can ACCESS the file
-- (its owner, or any member of the class for a class_material). The `tags`
-- table is owner-only under RLS, so a class student cannot read a teacher's
-- class-material tags directly — this SECURITY DEFINER RPC bridges that, after
-- an explicit access check.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0013.
-- ============================================================================

create or replace function public.get_file_tags(p_file_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_owner uuid;
    v_kind  text;
    v_ref   uuid;
    v_names text[];
begin
    select owner_id, kind, space_ref
      into v_owner, v_kind, v_ref
      from public.files
     where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    -- Access: owner, or any class member for a class_material.
    if v_owner <> auth.uid()
       and not (v_kind = 'class_material' and public.is_class_member(v_ref)) then
        raise exception 'not allowed' using errcode = 'insufficient_privilege';
    end if;

    select coalesce(array_agg(t.name order by t.name), array[]::text[])
      into v_names
      from public.file_tags ft
      join public.tags t on t.id = ft.tag_id
     where ft.file_id = p_file_id;
    return v_names;
end;
$$;

revoke execute on function public.get_file_tags(uuid) from public, anon;
grant  execute on function public.get_file_tags(uuid) to authenticated;

-- ============================================================================
-- End of 0014_file_tags_read.sql
-- ============================================================================
