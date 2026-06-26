-- ============================================================================
-- nodi — migration 0007 (node memory-link connections; Stage 3a)
-- RPCs to add/remove an entry in nodes.connections (uuid[], already in 0001).
-- Atomic array edit + ownership checks in one place; no schema change.
--
-- Both the TARGET node and the SOURCE node must live in a session owned by the
-- caller (you import YOUR other branches/sessions). SECURITY DEFINER; ownership
-- is enforced inside. Returns the updated connections array.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0006.
-- ============================================================================

create or replace function public.add_node_connection(
    p_node_id        uuid,
    p_source_node_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_conn uuid[];
begin
    if p_node_id = p_source_node_id then
        raise exception 'cannot connect a node to itself'
            using errcode = 'check_violation';
    end if;

    -- Target must be owned by the caller (and lock it for the edit).
    select n.connections
      into v_conn
      from public.nodes n
      join public.sessions s on s.id = n.session_id
     where n.id = p_node_id and s.owner_id = auth.uid()
     for update of n;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    -- Source must also be owned by the caller.
    if not exists (
        select 1
          from public.nodes n2
          join public.sessions s2 on s2.id = n2.session_id
         where n2.id = p_source_node_id and s2.owner_id = auth.uid()
    ) then
        raise exception 'source node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    v_conn := coalesce(v_conn, array[]::uuid[]);
    if not (p_source_node_id = any (v_conn)) then
        update public.nodes
           set connections = array_append(connections, p_source_node_id)
         where id = p_node_id
         returning connections into v_conn;
    end if;

    return v_conn;
end;
$$;

create or replace function public.remove_node_connection(
    p_node_id        uuid,
    p_source_node_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_conn uuid[];
begin
    update public.nodes n
       set connections = array_remove(n.connections, p_source_node_id)
      from public.sessions s
     where n.id = p_node_id
       and s.id = n.session_id
       and s.owner_id = auth.uid()
     returning n.connections into v_conn;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;
    return v_conn;
end;
$$;

revoke execute on function public.add_node_connection(uuid, uuid) from public, anon;
grant  execute on function public.add_node_connection(uuid, uuid) to authenticated;
revoke execute on function public.remove_node_connection(uuid, uuid) from public, anon;
grant  execute on function public.remove_node_connection(uuid, uuid) to authenticated;

-- ============================================================================
-- End of 0007_node_connections.sql
-- ============================================================================
