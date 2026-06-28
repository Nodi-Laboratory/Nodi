-- ============================================================================
-- nodi — migration 0015 (chat turn logs + realtime; D25)
-- ai_logs = one row per chat turn (Plant-Counselor LogRecorder pattern): the
-- full turn context (system prompt, Q/A, which context blocks were used, skill
-- calls, errors, token estimate). Distinct from ai_sessions/ai_steps (ReAct
-- step traces) which stay for navigator/overseer.
--
-- RLS (M default): owner select/insert + admin select (sensitive: contains the
-- system prompt and raw text). Retention: unlimited (no purge policy here).
-- Added to the supabase_realtime publication so admins can live-subscribe to
-- INSERTs (the admin RLS policy gates what they receive).
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0014.
-- ============================================================================

create table if not exists public.ai_logs (
    id             uuid primary key default gen_random_uuid(),
    owner_id       uuid not null references public.profiles (id) on delete cascade,
    session_id     uuid references public.sessions (id) on delete set null,
    node_id        uuid references public.nodes (id) on delete set null,
    kind           text not null default 'chat',
    system_prompt  text,
    question       text,
    answer         text,
    contexts       jsonb not null default '{}'::jsonb,   -- which blocks were used
    skill_calls    jsonb not null default '[]'::jsonb,
    errors         jsonb not null default '[]'::jsonb,
    token_estimate integer,
    created_at     timestamptz not null default now()
);

create index if not exists idx_ai_logs_owner_created
    on public.ai_logs (owner_id, created_at desc);
create index if not exists idx_ai_logs_created on public.ai_logs (created_at desc);
create index if not exists idx_ai_logs_session on public.ai_logs (session_id);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.ai_logs enable row level security;

drop policy if exists ai_logs_select_own on public.ai_logs;
create policy ai_logs_select_own on public.ai_logs
    for select using (owner_id = auth.uid());

drop policy if exists ai_logs_insert_own on public.ai_logs;
create policy ai_logs_insert_own on public.ai_logs
    for insert with check (owner_id = auth.uid());

-- Admins read every turn (the log browser). Uses is_admin() from 0008.
drop policy if exists ai_logs_select_admin on public.ai_logs;
create policy ai_logs_select_admin on public.ai_logs
    for select using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Realtime: full row on changes + add to the supabase_realtime publication
-- (idempotent). Admin RLS still governs what a subscriber actually receives.
-- ---------------------------------------------------------------------------
alter table public.ai_logs replica identity full;

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'ai_logs'
    ) then
        alter publication supabase_realtime add table public.ai_logs;
    end if;
end
$$;

-- ============================================================================
-- End of 0015_ai_logs.sql
-- ============================================================================
