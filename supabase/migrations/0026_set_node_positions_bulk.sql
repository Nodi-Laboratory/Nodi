-- ============================================================================
-- nodi — migration 0026 (bulk node-position RPC; 08 refactoring D69)
--
-- PURPOSE  Persist many node coordinates (subtree / multi-node drag) in ONE
--   round-trip. Today services/sessions.py:set_node_positions() issues one
--   PostgREST UPDATE per node (up to 2000), each a fresh round-trip. This RPC
--   does the whole batch in a single statement.
--
-- SECURITY  SECURITY INVOKER (default) — runs under the CALLER'S JWT, so the
--   existing nodes_update_owner RLS policy enforces per-row ownership exactly as
--   the per-node PATCH does today. No SECURITY DEFINER, no privilege widening.
--   The p_session_id scope (n.session_id = p_session_id) mirrors the current
--   {id, session_id} filter pair.
--
-- NON-UUID DEFENSE (recurring-bug-patterns #2)  Optimistic client-only ids
--   (optimistic:/provisional:/pending:) must never reach a uuid cast (06 D52:
--   bad cast -> PostgREST 400 -> 502). The frontend D63 guard is the primary
--   filter; this RPC is a second line: elements whose node_id is not a valid
--   uuid, or whose x/y are not json numbers, are SILENTLY SKIPPED (filtered in
--   the WHERE clause BEFORE any ::uuid cast) instead of erroring the whole call.
--
-- RESULT  Returns the count of rows actually updated (== number of valid ids
--   the caller owns within the session), matching set_node_positions()'s return.
--
-- NON-DESTRUCTIVE (add-only function). Apply via Supabase MCP (leader).
-- baseline = 0023.
-- ============================================================================

create or replace function public.set_node_positions_bulk(
    p_session_id uuid,
    p_positions  jsonb   -- [{"node_id": uuid, "x": number, "y": number}, ...]
)
returns integer
language sql
security invoker
set search_path = public
as $$
    with input as (
        select e
          from jsonb_array_elements(coalesce(p_positions, '[]'::jsonb)) e
         where -- drop optimistic/non-uuid ids before they hit the ::uuid cast
               (e->>'node_id') ~*
                 '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               -- only persist well-formed numeric coordinates
           and jsonb_typeof(e->'x') = 'number'
           and jsonb_typeof(e->'y') = 'number'
    ),
    upd as (
        update public.nodes n
           set position_x = (i.e->>'x')::double precision,
               position_y = (i.e->>'y')::double precision
          from input i
         where n.id = (i.e->>'node_id')::uuid
           and n.session_id = p_session_id
        returning n.id
    )
    select count(*)::int from upd;
$$;

revoke execute on function public.set_node_positions_bulk(uuid, jsonb)
    from public, anon;
grant  execute on function public.set_node_positions_bulk(uuid, jsonb)
    to authenticated;

-- ============================================================================
-- End of 0026_set_node_positions_bulk.sql
-- ============================================================================
