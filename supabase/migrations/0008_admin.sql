-- ============================================================================
-- nodi — migration 0008 (admin console backend; Stage 4c)
-- Adds: is_admin() helper, ADDITIVE admin RLS policies (existing owner policies
-- untouched — Postgres OR-combines policies), app_settings table + seed, and
-- SECURITY DEFINER RPCs for role changes and token-usage aggregation.
--
-- NOTE on role changes: migration 0003 revoked UPDATE on profiles and granted
-- only UPDATE(display_name, avatar_url) to `authenticated`. That column grant is
-- role-wide, so we CANNOT simply add an admin UPDATE policy for `role` (it would
-- still be blocked, and granting UPDATE(role) to authenticated would reopen the
-- self-escalation hole B1). Role changes therefore go through the
-- admin_set_user_role() SECURITY DEFINER RPC, which checks is_admin() itself.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0007.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. is_admin() — true if the caller's profile role is 'admin'
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin'
    );
$$;

revoke execute on function public.is_admin() from public, anon;
grant  execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Additive admin RLS policies (read-all for the console).
--    Only *_admin policies are touched here; owner policies remain.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
    for select using (public.is_admin());

drop policy if exists ai_sessions_select_admin on public.ai_sessions;
create policy ai_sessions_select_admin on public.ai_sessions
    for select using (public.is_admin());

drop policy if exists ai_steps_select_admin on public.ai_steps;
create policy ai_steps_select_admin on public.ai_steps
    for select using (public.is_admin());

-- Optional: let admins read all sessions for usage/audit.
drop policy if exists sessions_select_admin on public.sessions;
create policy sessions_select_admin on public.sessions
    for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 3. app_settings — runtime configuration (admin-only)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
    key        text primary key,
    value      jsonb not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references public.profiles (id) on delete set null
);

alter table public.app_settings enable row level security;

drop policy if exists app_settings_admin_select on public.app_settings;
create policy app_settings_admin_select on public.app_settings
    for select using (public.is_admin());

drop policy if exists app_settings_admin_insert on public.app_settings;
create policy app_settings_admin_insert on public.app_settings
    for insert with check (public.is_admin());

drop policy if exists app_settings_admin_update on public.app_settings;
create policy app_settings_admin_update on public.app_settings
    for update using (public.is_admin()) with check (public.is_admin());

-- Seed current config.py constants (idempotent). Values are jsonb.
insert into public.app_settings (key, value) values
    ('chat_model',         '"gemini-2.5-flash"'::jsonb),
    ('label_model',        '"gemini-2.5-flash-lite"'::jsonb),
    ('tag_model',          '"gemini-2.5-flash-lite"'::jsonb),
    ('navigator_model',    '"gemini-2.5-flash"'::jsonb),
    ('navigator_k',        '3'::jsonb),
    ('navigator_c',        '1'::jsonb),
    ('navigator_period',   '3'::jsonb),
    ('navigator_question_count', '3'::jsonb),
    ('react_max_steps',    '5'::jsonb),
    ('react_max_tokens',   '100000'::jsonb),
    ('max_tags_per_node',  '3'::jsonb),
    ('node_label_max_chars', '10'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. admin_set_user_role — change a user's app role (admin only)
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_role(
    p_user_id uuid,
    p_role    text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row public.profiles;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    if p_role not in ('student', 'teacher', 'admin') then
        raise exception 'invalid role' using errcode = 'check_violation';
    end if;
    -- Prevent an admin from demoting themselves (avoid lockout).
    if p_user_id = auth.uid() and p_role <> 'admin' then
        raise exception 'cannot change your own admin role'
            using errcode = 'check_violation';
    end if;

    update public.profiles
       set role = p_role, updated_at = now()
     where id = p_user_id
     returning * into v_row;
    if not found then
        raise exception 'user not found' using errcode = 'no_data_found';
    end if;
    return v_row;
end;
$$;

revoke execute on function public.admin_set_user_role(uuid, text) from public, anon;
grant  execute on function public.admin_set_user_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_token_usage — token totals per user (admin only)
--    PARTIAL: ai_steps.tokens currently covers only ReAct skill steps
--    (navigator / overseer). Chat & tagging token usage is not yet logged.
-- ---------------------------------------------------------------------------
create or replace function public.admin_token_usage()
returns table (
    owner_id     uuid,
    email        text,
    total_tokens bigint,
    step_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    return query
        select s.owner_id,
               p.email,
               coalesce(sum(st.tokens), 0)::bigint as total_tokens,
               count(st.*)::bigint as step_count
          from public.ai_sessions s
          join public.ai_steps st on st.ai_session_id = s.id
          left join public.profiles p on p.id = s.owner_id
         group by s.owner_id, p.email
         order by total_tokens desc;
end;
$$;

revoke execute on function public.admin_token_usage() from public, anon;
grant  execute on function public.admin_token_usage() to authenticated;

-- ============================================================================
-- End of 0008_admin.sql
-- ============================================================================
