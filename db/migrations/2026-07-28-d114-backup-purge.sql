-- D114 — 데이터 백업 · 초기화 RPC
--
-- 적용법은 같은 폴더의 다른 스크립트 머리말 참고. 전부 멱등이다.
--
-- 왜 RPC인가: 삭제는 소유자 정책이 막는다(`sessions_delete_owner`). 관리자에게는
-- SELECT 정책만 있어서 콘솔이 남의 세션을 지울 수 없다. 여기서 앱 코드로 우회하면
-- (워커 BYPASSRLS 커넥션 사용) "권한은 DB가 강제한다"(D104)가 깨진다. 대신 함수
-- 안에서 is_admin()을 확인하는 SECURITY DEFINER를 둔다 — 기존 admin_* RPC와 같은 형태.

begin;

-- ── 파일 삭제를 관리자에게도 허용 ─────────────────────────────────────
-- 콘솔의 문서 초기화가 이 함수를 재사용해야 Qdrant·Storage 정리 경로가 하나로
-- 유지된다. 별도 삭제 경로를 만들면 그쪽만 오펀 벡터를 남긴다.
create or replace function public.delete_file_cascade(p_file_id uuid) returns void
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_owner uuid;
begin
    select owner_id into v_owner from public.files where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() and not public.is_admin() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    -- 파일 삭제 → file_chunks / textbook_figures 를 FK cascade 로 제거.
    delete from public.files where id = p_file_id;
end;
$$;

-- ── 대화 초기화 ───────────────────────────────────────────────────────
-- ai_logs를 **먼저** 지운다. sessions FK가 ON DELETE SET NULL이라 세션만 지우면
-- 로그는 owner만 남은 고아 행으로 살아남는다 — "대화 기록 초기화"라는 말과 어긋난다.
create or replace function public.admin_purge_conversations(
    p_owner uuid default null
) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_logs     bigint := 0;
    v_nodes    bigint := 0;
    v_sessions bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    -- 노드는 sessions FK의 ON DELETE CASCADE로 함께 사라진다. 지워질 개수를
    -- 미리 세어 두지 않으면 보고할 수가 없다(삭제 후에는 셀 대상이 없다).
    select count(*) into v_nodes
      from public.nodes n
      join public.sessions s on s.id = n.session_id
     where p_owner is null or s.owner_id = p_owner;

    with d as (
        delete from public.ai_logs l
         where p_owner is null or l.owner_id = p_owner
        returning 1
    ) select count(*) into v_logs from d;

    with d as (
        delete from public.sessions s
         where p_owner is null or s.owner_id = p_owner
        returning 1
    ) select count(*) into v_sessions from d;

    return jsonb_build_object(
        'ai_logs', v_logs, 'nodes', v_nodes, 'sessions', v_sessions
    );
end;
$$;

-- ── 복원 ──────────────────────────────────────────────────────────────
-- **덮어쓰지 않는다.** 같은 id가 이미 있으면 건너뛴다(on conflict do nothing).
-- 복원이 현재 데이터를 조용히 갈아엎으면 "복원했더니 최근 것이 사라졌다"가 된다.
--
-- sessions ↔ nodes는 서로를 참조한다(nodes.session_id / sessions.root_node_id).
-- 그래서 세션을 **머리 없이** 먼저 넣고, 노드를 넣은 뒤, 머리를 이어 붙인다.
create or replace function public.admin_restore_conversations(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_sessions bigint := 0;
    v_nodes    bigint := 0;
    v_logs     bigint := 0;
    v_heads    bigint := 0;
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

    return jsonb_build_object(
        'sessions', v_sessions, 'nodes', v_nodes,
        'ai_logs', v_logs, 'heads_relinked', v_heads
    );
end;
$$;

-- 설정 복원 — 이쪽은 **덮어쓴다.** 설정은 "현재 유효한 값"이 하나뿐이라
-- 건너뛰면 복원이 아무 일도 하지 않는 것과 같다.
create or replace function public.admin_restore_settings(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_count bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    with src as (
        select key, value
          from jsonb_to_recordset(coalesce(p_data->'app_settings', '[]'::jsonb))
               as t(key text, value jsonb)
    ), ups as (
        insert into public.app_settings (key, value, updated_by, updated_at)
        select s.key, s.value, auth.uid(), now() from src s
        on conflict (key) do update
            set value = excluded.value,
                updated_by = excluded.updated_by,
                updated_at = excluded.updated_at
        returning 1
    ) select count(*) into v_count from ups;

    return jsonb_build_object('app_settings', v_count);
end;
$$;

commit;
