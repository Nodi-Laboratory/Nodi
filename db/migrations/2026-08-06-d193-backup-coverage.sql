-- D193 백업이 담지 않던 것들 — 개념 연결 · 강의 · 도판 · 원자
--
-- 점검 2026-08-06: 표 23개 중 백업이 담는 것은 11개였다. 빠진 것 중 여럿이
-- **재생성이 불가능하거나 아주 비싼** 데이터다.
--
--   item_links       개념 연결 배지. canvas_items에 CASCADE라 초기화 때 같이
--                    지워지는데 백업에는 없었다 — 백업→초기화→복원 하면
--                    링크만 사라진다. D152가 canvas_items에서 고친 것과
--                    **정확히 같은 형태의 구멍**이다.
--   lecture_*        EBS 인제스트 결과(자막 전사·클립·원자). 다시 만들려면
--                    Whisper와 solar를 다시 태워야 한다.
--   clip_thumbnails  관리자가 올린 그림. 바이트는 Storage에 있고 행이 없으면
--                    어느 그림인지 모른다.
--   textbook_figures 교과서 도판 행(캡션·좌표). 다시 만들려면 비전 모델을
--                    전 도판에 다시 돌려야 한다.
--   chunk_atoms      원자 질문. solar를 청크마다 다시 돌려야 한다.
--
-- 담지 않는 것도 정한다:
--   jobs   큐다. 복원하면 이미 끝난 일을 다시 돌린다.
--   users  비밀번호 해시가 든다. 백업 파일에 자격 증명을 적지 않는다 —
--          profiles가 계정의 안전한 사본이고, 시연 계정은 CLI로 만든다.
--
-- **멱등이다.** 여러 번 돌려도 같은 결과여야 한다(CLAUDE.md 규약).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) 대화 복원에 개념 연결을 더한다
--
-- `admin_restore_conversations`를 **통째로 다시 만든다**(CREATE OR REPLACE).
-- 표를 더할 때 이 함수를 안 고치면 백업 파일에는 들어 있는데 복원은 조용히
-- 건너뛴다 — D152가 canvas_items에서 겪은 그것이다(오류도 안 난다).
-- ---------------------------------------------------------------------------
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
    v_ilinks   bigint := 0;
    v_runs     bigint := 0;
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
         where exists (select 1 from public.profiles p where p.id = s.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_sessions from ins;

    -- 2) 노드
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

    -- 3) 부모 연결 + 세션 머리
    update public.nodes n
       set parent_id = src.parent_id
      from (select * from jsonb_populate_recordset(null::public.nodes,
                                                  coalesce(p_data->'nodes', '[]'::jsonb))) src
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
           and src.root_node_id is not null
           and exists (select 1 from public.nodes n where n.id = src.root_node_id)
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
        select l.id, l.owner_id, l.session_id, l.node_id, l.kind, l.system_prompt,
               l.question, l.answer, l.contexts, l.skill_calls, l.errors,
               l.token_estimate, l.tokens, l.route, l.model, l.duration_ms, l.created_at
          from src l
         where exists (select 1 from public.profiles p where p.id = l.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_logs from ins;

    -- 5) 캔버스 아이템 (부모는 6에서 잇는다)
    with src as (
        select * from jsonb_populate_recordset(null::public.canvas_items,
                                               coalesce(p_data->'canvas_items', '[]'::jsonb))
    ), ins as (
        insert into public.canvas_items
            (id, session_id, node_id, kind, source, title, body, tag,
             x, y, pinned, seq, data, created_at, updated_at)
        select c.id, c.session_id, c.node_id, c.kind, c.source, c.title, c.body, c.tag,
               c.x, c.y, c.pinned, c.seq, c.data, c.created_at, c.updated_at
          from src c
         where exists (select 1 from public.sessions s where s.id = c.session_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_items from ins;

    -- 6) 트리 간선 (D151)
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

    -- 7) 그림
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

    -- 8) 개념 연결 배지 (D171) — **양 끝 카드가 실제로 복원됐을 때만.**
    --    한쪽만 있는 링크는 화면에서 "어디로도 안 가는 배지"가 된다.
    with src as (
        select * from jsonb_populate_recordset(null::public.item_links,
                                               coalesce(p_data->'item_links', '[]'::jsonb))
    ), ins as (
        insert into public.item_links
            (id, owner_id, from_item_id, to_item_id, explanation, distance,
             opened_at, created_at)
        select l.id, l.owner_id, l.from_item_id, l.to_item_id, l.explanation,
               l.distance, l.opened_at, l.created_at
          from src l
         where exists (select 1 from public.canvas_items a where a.id = l.from_item_id)
           and exists (select 1 from public.canvas_items b where b.id = l.to_item_id)
        on conflict do nothing
        returning 1
    ) select count(*) into v_ilinks from ins;

    -- 9) 판정 이력 (D172) — 진단용이라 없어도 서비스는 돈다. 그래도 담는 이유는
    --    "왜 이 배지가 떴나"를 나중에 되짚을 수 있어야 하기 때문이다.
    with src as (
        select * from jsonb_populate_recordset(null::public.crosslink_runs,
                                               coalesce(p_data->'crosslink_runs', '[]'::jsonb))
    ), ins as (
        insert into public.crosslink_runs
            (id, owner_id, from_item_id, from_session_id, from_title, from_tag,
             from_space_kind, knobs, candidates, outcome, link_id, explanation,
             searched_sessions, duration_ms, created_at)
        select r.id, r.owner_id, r.from_item_id, r.from_session_id, r.from_title,
               r.from_tag, r.from_space_kind, r.knobs, r.candidates, r.outcome,
               r.link_id, r.explanation, r.searched_sessions, r.duration_ms, r.created_at
          from src r
         where exists (select 1 from public.profiles p where p.id = r.owner_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_runs from ins;

    return jsonb_build_object(
        'sessions', v_sessions, 'nodes', v_nodes,
        'ai_logs', v_logs, 'heads_relinked', v_heads,
        'canvas_items', v_items, 'canvas_links', v_links,
        'canvas_drawings', v_draw,
        'item_links', v_ilinks, 'crosslink_runs', v_runs
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) 강의 복원 — 시연 시나리오의 핵심
--
-- 인제스트를 다시 돌리면 Whisper 전사와 solar 원자 생성이 다시 나간다(느리고
-- 비싸다). 시연 직전에 그걸 기다릴 수는 없다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_restore_lectures(p_data jsonb)
returns jsonb
    language plpgsql security definer
    set search_path to 'public'
    as $$
declare
    v_pkg   bigint := 0;
    v_vid   bigint := 0;
    v_clip  bigint := 0;
    v_atom  bigint := 0;
    v_map   bigint := 0;
    v_thumb bigint := 0;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    with src as (
        select * from jsonb_populate_recordset(null::public.lecture_packages,
                                               coalesce(p_data->'lecture_packages', '[]'::jsonb))
    ), ins as (
        insert into public.lecture_packages (id, grade, subject, title, created_by, created_at)
        select p.id, p.grade, p.subject, p.title, p.created_by, p.created_at
          from src p
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_pkg from ins;

    with src as (
        select * from jsonb_populate_recordset(null::public.lecture_videos,
                                               coalesce(p_data->'lecture_videos', '[]'::jsonb))
    ), ins as (
        insert into public.lecture_videos
            (id, package_id, source, page_url, subtitle_path, title, status, error, created_at)
        select v.id, v.package_id, v.source, v.page_url, v.subtitle_path, v.title,
               v.status, v.error, v.created_at
          from src v
         where exists (select 1 from public.lecture_packages p where p.id = v.package_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_vid from ins;

    with src as (
        select * from jsonb_populate_recordset(null::public.lecture_clips,
                                               coalesce(p_data->'lecture_clips', '[]'::jsonb))
    ), ins as (
        insert into public.lecture_clips
            (id, video_id, seq, start_sec, end_sec, title, transcript, status, created_at)
        select c.id, c.video_id, c.seq, c.start_sec, c.end_sec, c.title,
               c.transcript, c.status, c.created_at
          from src c
         where exists (select 1 from public.lecture_videos v where v.id = c.video_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_clip from ins;

    with src as (
        select * from jsonb_populate_recordset(null::public.lecture_clip_atoms,
                                               coalesce(p_data->'lecture_clip_atoms', '[]'::jsonb))
    ), ins as (
        insert into public.lecture_clip_atoms
            (id, clip_id, package_id, question, status, created_at)
        select a.id, a.clip_id, a.package_id, a.question, a.status, a.created_at
          from src a
         where exists (select 1 from public.lecture_clips c where c.id = a.clip_id)
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_atom from ins;

    -- 학급별 노출 토글 — 학급이 복원돼 있어야 의미가 있다.
    with src as (
        select * from jsonb_populate_recordset(null::public.class_lecture_packages,
                                               coalesce(p_data->'class_lecture_packages', '[]'::jsonb))
    ), ins as (
        insert into public.class_lecture_packages (class_id, package_id, created_at)
        select m.class_id, m.package_id, m.created_at
          from src m
         where exists (select 1 from public.classes c where c.id = m.class_id)
           and exists (select 1 from public.lecture_packages p where p.id = m.package_id)
        on conflict do nothing
        returning 1
    ) select count(*) into v_map from ins;

    -- 클립 썸네일 (D190) — 바이트는 Storage에 있고, 행이 없으면 어느 그림인지
    -- 모른다. 파일이 없는 행은 화면에서 빈 자리가 될 뿐 카드를 깨지 않는다.
    with src as (
        select * from jsonb_populate_recordset(null::public.clip_thumbnails,
                                               coalesce(p_data->'clip_thumbnails', '[]'::jsonb))
    ), ins as (
        insert into public.clip_thumbnails
            (id, storage_path, mime, size_bytes, name, created_by, created_at)
        select t.id, t.storage_path, t.mime, t.size_bytes, t.name, t.created_by, t.created_at
          from src t
        on conflict (id) do nothing
        returning 1
    ) select count(*) into v_thumb from ins;

    return jsonb_build_object(
        'lecture_packages', v_pkg, 'lecture_videos', v_vid,
        'lecture_clips', v_clip, 'lecture_clip_atoms', v_atom,
        'class_lecture_packages', v_map, 'clip_thumbnails', v_thumb
    );
end;
$$;

GRANT EXECUTE ON FUNCTION public.admin_restore_lectures(jsonb) TO nodi_app;

COMMIT;
