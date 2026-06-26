-- ============================================================================
-- nodi — migration 0004 (atomic chat-node append)
-- Adds append_chat_node(): insert one (Q+A) node AND advance the session head
-- (and root, if first) in a SINGLE transaction, so a node can never be orphaned
-- with a stale current_head_id.
--
-- SECURITY DEFINER: ownership is enforced INSIDE the function
-- (sessions.owner_id = auth.uid()), so it cannot be used to write into someone
-- else's session. EXECUTE is revoked from public/anon and granted only to
-- authenticated.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0003.
-- ============================================================================

create or replace function public.append_chat_node(
    p_session_id uuid,
    p_parent_id  uuid,
    p_question   text,
    p_answer     text,
    p_label      text default null
)
returns public.nodes
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner    uuid;
    v_has_root uuid;
    v_node     public.nodes;
begin
    -- Ownership check (lock the session row for the duration of the tx).
    select owner_id, root_node_id
      into v_owner, v_has_root
      from public.sessions
     where id = p_session_id
     for update;

    if v_owner is null then
        raise exception 'session not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not session owner' using errcode = 'insufficient_privilege';
    end if;

    -- If a parent is given, it must belong to the same session.
    if p_parent_id is not null then
        if not exists (
            select 1 from public.nodes n
            where n.id = p_parent_id and n.session_id = p_session_id
        ) then
            raise exception 'parent node not in session'
                using errcode = 'foreign_key_violation';
        end if;
    end if;

    insert into public.nodes (session_id, parent_id, question, answer, label)
    values (p_session_id, p_parent_id, p_question, p_answer, p_label)
    returning * into v_node;

    update public.sessions
       set current_head_id = v_node.id,
           root_node_id     = coalesce(root_node_id, v_node.id),
           updated_at       = now()
     where id = p_session_id;

    return v_node;
end;
$$;

revoke execute on function
    public.append_chat_node(uuid, uuid, text, text, text) from public, anon;
grant execute on function
    public.append_chat_node(uuid, uuid, text, text, text) to authenticated;

-- ============================================================================
-- End of 0004_append_node.sql
-- ============================================================================
