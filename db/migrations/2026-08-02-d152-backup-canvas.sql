-- D152: 백업·복원이 **캔버스를 빠뜨리던 것**을 메꾼다.
--
-- ## 무엇이 문제였나
--
-- `admin_restore_conversations`는 sessions·nodes·ai_logs만 되살렸다. 그런데
-- D122 이후 "대화 내용"의 실체는 **canvas_items**다 — 학생이 읽고 고치고
-- 옮기는 글이 거기 있고, 그림은 canvas_drawings에 있다.
--
-- 그래서 백업을 뜬 뒤 초기화하면 세션 껍데기와 옛 nodes.answer 텍스트만
-- 돌아오고 **캔버스는 빈 채로 복원된다.** 백업 파일에는 아무 오류도 없고
-- 복원도 성공했다고 보고하므로, 학생이 캔버스를 열어 보기 전까지 아무도
-- 모른다. 초기화 직전에 이걸 먼저 고치는 이유다.
--
-- ## 순서
--
-- `canvas_items.parent_item_id`는 자기 참조다(트리, D151). nodes와 같은
-- 방식으로 **부모를 비운 채 넣고 나중에 잇는다** — FK가 deferrable이 아니라
-- 부모가 아직 없는 행을 가리키면 그 자리에서 실패한다.
--
-- `node_id`는 ON DELETE CASCADE라 노드가 복원되지 않았으면 **비워서** 넣는다.
-- 그대로 넣으면 FK 위반으로 그 글이 통째로 사라진다 — 노드는 못 살려도
-- 글은 살려야 한다(글이 본체다).
--
-- 멱등: CREATE OR REPLACE + on conflict do nothing.

CREATE OR REPLACE FUNCTION public.admin_restore_conversations(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_sessions bigint := 0;
    v_nodes    bigint := 0;
    v_logs     bigint := 0;
    v_heads    bigint := 0;
    v_items    bigint := 0;
    v_links    bigint := 0;
    v_draw     bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    -- 1) 세션 (root/head는 아직 비운다)
    with src as (
        select * from jsonb_populate_recordset(null::public.sessions,
                                               coalesce(p_data->'sessions', '[]'::jsonb))
    ), ins as (
        insert into public.sessions
            (id, owner_id, space_kind, space_ref, title, emoji, created_at, updated_at)
        select s.id, s.owner_id, s.space_kind, s.space_ref, s.title, s.emoji,
               s.created_at, s.updated_at
          from src s
          -- 소유자가 사라진 세션은 FK가 막는다. 조용히 실패하지 말고 걸러 낸다.
         where exists (select 1 from public.profiles p where p.id = s.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_sessions from ins;

    -- 2) 노드 (부모는 자기 참조라 순서 무관 — FK가 deferrable이 아니므로
    --    parent_id를 일단 비우고 넣은 뒤 3)에서 잇는다)
    with src as (
        select * from jsonb_populate_recordset(null::public.nodes,
                                               coalesce(p_data->'nodes', '[]'::jsonb))
    ), ins as (
        insert into public.nodes
            (id, session_id, question, answer, label, attachments, rag_sources, created_at)
        select n.id, n.session_id, n.question, n.answer, n.label,
               n.attachments, n.rag_sources, n.created_at
          from src n
         where exists (select 1 from public.sessions s where s.id = n.session_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_nodes from ins;

    -- 3) 부모 연결 + 세션 머리 복원
    update public.nodes n
       set parent_id = src.parent_id
      from jsonb_populate_recordset(null::public.nodes,
                                    coalesce(p_data->'nodes', '[]'::jsonb)) src
     where n.id = src.id
       and n.parent_id is null
       and src.parent_id is not null
       and exists (select 1 from public.nodes p where p.id = src.parent_id);

    with src as (
        select * from jsonb_populate_recordset(null::public.sessions,
                                               coalesce(p_data->'sessions', '[]'::jsonb))
    ), upd as (
        update public.sessions s
           set root_node_id = src.root_node_id,
               current_head_id = src.current_head_id
          from src
         where s.id = src.id
           and s.root_node_id is null
           and (src.root_node_id is not null or src.current_head_id is not null)
        returning 1
    ) select count(*) into v_heads from upd;

    -- 4) 턴 로그
    with src as (
        select * from jsonb_populate_recordset(null::public.ai_logs,
                                               coalesce(p_data->'ai_logs', '[]'::jsonb))
    ), ins as (
        insert into public.ai_logs
            (id, owner_id, session_id, node_id, kind, system_prompt, question, answer,
             contexts, skill_calls, errors, token_estimate, tokens, route, model,
             duration_ms, created_at)
        select l.id, l.owner_id,
               -- 세션·노드가 복원되지 않았으면 참조를 비운다(로그 자체는 살린다).
               (select s.id from public.sessions s where s.id = l.session_id),
               (select n.id from public.nodes n where n.id = l.node_id),
               l.kind, l.system_prompt, l.question, l.answer, l.contexts,
               l.skill_calls, l.errors, l.token_estimate, l.tokens, l.route,
               l.model, l.duration_ms, l.created_at
          from src l
         where exists (select 1 from public.profiles p where p.id = l.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_logs from ins;

    -- 5) 캔버스 글 (D152) — **부모는 비운 채** 넣는다(자기 참조 FK).
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_items,
                                               coalesce(p_data->'canvas_items', '[]'::jsonb))
    ), ins as (
        insert into public.canvas_items
            (id, session_id, node_id, kind, source, title, body, tag,
             x, y, pinned, seq, data, created_at, updated_at)
        select i.id, i.session_id,
               -- 노드를 못 살렸으면 참조만 비운다. 글은 살린다.
               (select n.id from public.nodes n where n.id = i.node_id),
               i.kind, i.source, i.title, i.body, i.tag,
               i.x, i.y, i.pinned, i.seq, i.data, i.created_at, i.updated_at
          from src i
         where exists (select 1 from public.sessions s where s.id = i.session_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_items from ins;

    -- 6) 트리 간선 잇기 (D151) — 부모가 실제로 복원됐을 때만.
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_items,
                                               coalesce(p_data->'canvas_items', '[]'::jsonb))
    ), upd as (
        update public.canvas_items c
           set parent_item_id = src.parent_item_id
          from src
         where c.id = src.id
           and c.parent_item_id is null
           and src.parent_item_id is not null
           and exists (select 1 from public.canvas_items p where p.id = src.parent_item_id)
        returning 1
    ) select count(*) into v_links from upd;

    -- 7) 그림 (세션당 한 행)
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_drawings,
                                               coalesce(p_data->'canvas_drawings', '[]'::jsonb))
    ), ins as (
        insert into public.canvas_drawings (session_id, elements, files, updated_at)
        select d.session_id, d.elements, d.files, d.updated_at
          from src d
         where exists (select 1 from public.sessions s where s.id = d.session_id)
        on conflict (session_id) do nothing
        returning 1
    ) select count(*) into v_draw from ins;

    return jsonb_build_object(
        'sessions', v_sessions, 'nodes', v_nodes,
        'ai_logs', v_logs, 'heads_relinked', v_heads,
        'canvas_items', v_items, 'canvas_links', v_links,
        'canvas_drawings', v_draw
    );
end;
$$;
