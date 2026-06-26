-- ============================================================================
-- nodi — migration 0006 (AI ReAct trace; Stage 2 Part B)
-- Tables: ai_sessions, ai_steps  (owner-isolated)
-- One ReAct run = an ai_session; each thought->skill->observation = an ai_step.
--
-- NOTE: the `jobs` background-queue table (architecture §7) is intentionally NOT
-- created here. Stage 2 runs the navigator INLINE inside the user's chat request
-- (user JWT / RLS), because the apscheduler worker needs a service_role key that
-- is currently empty. Real background infra (jobs + apscheduler + service_role)
-- is deferred to Stage 3 (embeddings).
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0005.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ai_sessions  (one ReAct run)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_sessions (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null references public.profiles (id) on delete cascade,
    session_id uuid references public.sessions (id) on delete set null,
    kind       text not null,            -- e.g. 'navigator'
    created_at timestamptz not null default now()
);

create index if not exists idx_ai_sessions_owner on public.ai_sessions (owner_id);

-- ---------------------------------------------------------------------------
-- 2. ai_steps  (one thought -> skill -> observation step)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_steps (
    id            uuid primary key default gen_random_uuid(),
    ai_session_id uuid not null references public.ai_sessions (id) on delete cascade,
    seq           integer not null,
    thought       text,
    skill         text,
    input         jsonb not null default '{}'::jsonb,
    observation   jsonb not null default '{}'::jsonb,
    tokens        integer,
    created_at    timestamptz not null default now()
);

create index if not exists idx_ai_steps_session on public.ai_steps (ai_session_id, seq);

-- ---------------------------------------------------------------------------
-- 3. RLS — owner isolation
-- ---------------------------------------------------------------------------
alter table public.ai_sessions enable row level security;
alter table public.ai_steps    enable row level security;

drop policy if exists ai_sessions_select_own on public.ai_sessions;
create policy ai_sessions_select_own on public.ai_sessions
    for select using (owner_id = auth.uid());

drop policy if exists ai_sessions_insert_own on public.ai_sessions;
create policy ai_sessions_insert_own on public.ai_sessions
    for insert with check (owner_id = auth.uid());

-- ai_steps belong to the caller only if their parent ai_session is theirs.
drop policy if exists ai_steps_select_own on public.ai_steps;
create policy ai_steps_select_own on public.ai_steps
    for select using (
        exists (
            select 1 from public.ai_sessions s
            where s.id = ai_session_id and s.owner_id = auth.uid()
        )
    );

drop policy if exists ai_steps_insert_own on public.ai_steps;
create policy ai_steps_insert_own on public.ai_steps
    for insert with check (
        exists (
            select 1 from public.ai_sessions s
            where s.id = ai_session_id and s.owner_id = auth.uid()
        )
    );

-- ============================================================================
-- End of 0006_ai_trace.sql
-- ============================================================================
