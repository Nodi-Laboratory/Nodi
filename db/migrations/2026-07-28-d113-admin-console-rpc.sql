-- D113 — 운영 콘솔 집계 RPC 4종
--
-- 적용법·성격은 같은 폴더의 2026-07-28-d113-admin-observability.sql 머리말 참고.
-- 전부 `create or replace`라 멱등이다.
--
-- 왜 RPC인가: 콘솔이 필요한 것은 집계와 조인이다(역할별 사용자 수, 파일별 청크
-- 상태, 세션별 토큰 합). db/query.py의 PostgREST 문법 번역기는 이걸 표현하지
-- 못하고, 앱에서 행을 다 끌어와 파이썬으로 세면 수천 행이 오간다. 권한 검사는
-- 함수 안 `is_admin()`이 하고, 호출은 여전히 사용자 JWT로 나간다(D104).

begin;

-- ── 1) 전체 개요 ──────────────────────────────────────────────────────
create or replace function public.admin_overview() returns jsonb
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
declare
    v jsonb;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    select jsonb_build_object(
        'users', jsonb_build_object(
            'total', (select count(*) from public.profiles),
            'by_role', coalesce((
                select jsonb_object_agg(role, n)
                  from (select role, count(*) n from public.profiles group by role) t
            ), '{}'::jsonb)
        ),
        'classes', (select count(*) from public.classes),
        'sessions', jsonb_build_object(
            'total', (select count(*) from public.sessions),
            'by_space', coalesce((
                select jsonb_object_agg(space_kind, n)
                  from (select space_kind, count(*) n from public.sessions group by space_kind) t
            ), '{}'::jsonb)
        ),
        'nodes', (select count(*) from public.nodes),
        'files', jsonb_build_object(
            'total', (select count(*) from public.files),
            'bytes', (select coalesce(sum(size_bytes), 0) from public.files),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.files group by status) t
            ), '{}'::jsonb),
            'by_kind', coalesce((
                select jsonb_object_agg(kind, n)
                  from (select kind, count(*) n from public.files group by kind) t
            ), '{}'::jsonb)
        ),
        'chunks', jsonb_build_object(
            'total', (select count(*) from public.file_chunks),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.file_chunks group by status) t
            ), '{}'::jsonb)
        ),
        'figures', jsonb_build_object(
            'total', (select count(*) from public.textbook_figures),
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.textbook_figures group by status) t
            ), '{}'::jsonb)
        ),
        'jobs', jsonb_build_object(
            'by_status', coalesce((
                select jsonb_object_agg(status, n)
                  from (select status, count(*) n from public.jobs group by status) t
            ), '{}'::jsonb)
        ),
        'turns', jsonb_build_object(
            'total', (select count(*) from public.ai_logs),
            'last_7d', (select count(*) from public.ai_logs
                         where created_at >= now() - interval '7 days'),
            'with_errors', (select count(*) from public.ai_logs
                             where jsonb_array_length(errors) > 0),
            'by_route', coalesce((
                select jsonb_object_agg(coalesce(route, 'unknown'), n)
                  from (select route, count(*) n from public.ai_logs group by route) t
            ), '{}'::jsonb)
        ),
        -- 실측 토큰과 어림(token_estimate)을 **나란히** 돌려준다. 하나로 합치면
        -- 콘솔이 어림을 실측으로 표시하게 된다(실측 2026-07-28: 어림이 실측의
        -- 1/4.5였다 — 한국어에서 글자수/4 상수가 안 맞는다).
        'tokens', (
            select jsonb_build_object(
                'measured_turns', count(*) filter (where tokens ? 'total'),
                'prompt',     coalesce(sum((tokens->>'prompt')::bigint), 0),
                'completion', coalesce(sum((tokens->>'completion')::bigint), 0),
                'total',      coalesce(sum((tokens->>'total')::bigint), 0),
                'cached',     coalesce(sum((tokens->>'cached')::bigint), 0),
                'estimate_total', coalesce(sum(token_estimate), 0)
            ) from public.ai_logs
        ),
        'latency', (
            select jsonb_build_object(
                'p50', coalesce(percentile_disc(0.5) within group (order by duration_ms), 0),
                'p95', coalesce(percentile_disc(0.95) within group (order by duration_ms), 0)
            ) from public.ai_logs where duration_ms is not null
        )
    ) into v;

    return v;
end;
$$;

-- ── 2) 대화(세션) 목록 ────────────────────────────────────────────────
-- Plant-Counselor의 로그 화면은 대화를 파일 단위로 흩어 놓아 읽기 어려웠다.
-- 여기서는 **세션이 단위**다 — 누가·어디서·몇 턴·토큰 얼마를 한 줄로 본다.
create or replace function public.admin_conversations(
    p_owner  uuid default null,
    p_space  text default null,
    p_search text default null,
    p_limit  int  default 30,
    p_offset int  default 0
) returns table (
    session_id    uuid,
    title         text,
    space_kind    text,
    space_ref     uuid,
    class_name    text,
    owner_id      uuid,
    owner_email   text,
    owner_role    text,
    node_count    bigint,
    turn_count    bigint,
    token_total   bigint,
    error_turns   bigint,
    created_at    timestamptz,
    updated_at    timestamptz,
    last_activity timestamptz,
    total_count   bigint
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    with filtered as (
        select s.*
          from public.sessions s
          join public.profiles p on p.id = s.owner_id
         where (p_owner is null or s.owner_id = p_owner)
           and (p_space is null or s.space_kind = p_space)
           and (
                p_search is null
             or s.title ilike '%' || p_search || '%'
             or p.email ilike '%' || p_search || '%'
             or exists (
                    select 1 from public.nodes n
                     where n.session_id = s.id
                       and (n.question ilike '%' || p_search || '%'
                         or n.answer   ilike '%' || p_search || '%')
                )
           )
    ),
    total as (select count(*) c from filtered)
    select
        f.id,
        f.title,
        f.space_kind,
        f.space_ref,
        c.name,
        f.owner_id,
        p.email,
        p.role,
        (select count(*) from public.nodes n where n.session_id = f.id),
        (select count(*) from public.ai_logs l where l.session_id = f.id),
        -- sum()은 numeric을 돌려주므로 **밖에서** bigint로 맞춘다. 안쪽만
        -- 캐스팅하면 반환 타입과 어긋나 함수 자체가 실패한다.
        (select coalesce(sum((l.tokens->>'total')::bigint), 0)::bigint
           from public.ai_logs l where l.session_id = f.id),
        (select count(*) from public.ai_logs l
          where l.session_id = f.id and jsonb_array_length(l.errors) > 0),
        f.created_at,
        f.updated_at,
        greatest(
            f.updated_at,
            coalesce((select max(n.created_at) from public.nodes n
                       where n.session_id = f.id), f.updated_at)
        ),
        (select c from total)
      from filtered f
      join public.profiles p on p.id = f.owner_id
      left join public.classes c on c.id = f.space_ref
     order by 15 desc
     limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- ── 3) 문서(파일) 인제스트 현황 ───────────────────────────────────────
-- "문서가 어떻게 올라갔는가" = 청킹이 몇 조각으로 끊겼고 그중 몇 개가 임베딩에
-- 성공했는가. files.chunk_total/chunk_done은 워커가 쓰는 진행률이라 실제 행
-- 개수와 어긋날 수 있어 **양쪽을 다 돌려준다**.
create or replace function public.admin_documents(
    p_kind   text default null,
    p_status text default null,
    p_search text default null,
    p_limit  int  default 30,
    p_offset int  default 0
) returns table (
    file_id         uuid,
    name            text,
    kind            text,
    space_kind      text,
    space_ref       uuid,
    class_name      text,
    owner_id        uuid,
    owner_email     text,
    status          text,
    mime            text,
    size_bytes      bigint,
    chunk_total     int,
    chunk_done      int,
    context_chars   int,
    error           text,
    session_id      uuid,
    chunks_rows     bigint,
    chunks_embedded bigint,
    chunks_stored   bigint,
    chunks_failed   bigint,
    chunk_chars     bigint,
    figures_total   bigint,
    figures_ok      bigint,
    created_at      timestamptz,
    updated_at      timestamptz,
    total_count     bigint
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    with filtered as (
        select f.*
          from public.files f
          left join public.profiles p on p.id = f.owner_id
         where (p_kind   is null or f.kind = p_kind)
           and (p_status is null or f.status = p_status)
           and (p_search is null
                or f.name ilike '%' || p_search || '%'
                or p.email ilike '%' || p_search || '%')
    ),
    total as (select count(*) c from filtered)
    select
        f.id, f.name, f.kind, f.space_kind, f.space_ref, c.name,
        f.owner_id, p.email, f.status, f.mime, f.size_bytes,
        f.chunk_total, f.chunk_done, f.context_chars, f.error, f.session_id,
        (select count(*) from public.file_chunks k where k.file_id = f.id),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'embedded'),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'stored'),
        (select count(*) from public.file_chunks k
          where k.file_id = f.id and k.status = 'failed'),
        (select coalesce(sum(length(k.chunk_text)), 0) from public.file_chunks k
          where k.file_id = f.id),
        (select count(*) from public.textbook_figures g where g.file_id = f.id),
        (select count(*) from public.textbook_figures g
          where g.file_id = f.id and g.status = 'embedded'),
        f.created_at, f.updated_at,
        (select c from total)
      from filtered f
      left join public.profiles p on p.id = f.owner_id
      left join public.classes  c on c.id = f.space_ref
     order by f.created_at desc
     limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end;
$$;

-- ── 4) 스킬 사용 통계 ─────────────────────────────────────────────────
-- ai_logs.skill_calls(D113 트레이스)를 펼쳐 스킬별로 센다. 어떤 스킬이 실제로
-- 쓰이는지, 얼마나 걸리는지, 얼마나 실패하는지 — 카탈로그를 좁힐 근거가 된다.
create or replace function public.admin_skill_usage(p_days int default 30)
returns table (
    skill      text,
    calls      bigint,
    failures   bigint,
    skipped    bigint,
    turns      bigint,
    avg_ms     numeric,
    max_ms     bigint,
    last_used  timestamptz
)
    language plpgsql stable security definer
    set search_path to 'public'
    as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;

    return query
    select
        s.value->>'skill',
        count(*),
        count(*) filter (where (s.value->>'ok')::boolean is not true),
        count(*) filter (where (s.value->>'skipped')::boolean is true),
        count(distinct l.id),
        round(avg(nullif((s.value->>'duration_ms')::numeric, null)), 1),
        max((s.value->>'duration_ms')::bigint),
        max(l.created_at)
      from public.ai_logs l
      cross join lateral jsonb_array_elements(l.skill_calls) s(value)
     where l.created_at >= now() - make_interval(days => greatest(p_days, 1))
       and s.value->>'skill' is not null
     group by 1
     order by 2 desc;
end;
$$;

commit;
