-- ============================================================================
-- nodi — migration 0001 (Stage 0 foundation)
-- Tables: profiles, classes, class_members, sessions, nodes
-- Source of truth: planning/01-초기설계/architecture.md §3 (data model), §8.
-- Scope isolation is the core invariant: data is either PERSONAL (owner) or
-- CLASS (visible to class members) and RLS enforces that boundary.
--
-- NOTE: pgvector is already enabled on this project (file_chunks.embedding
-- arrives in Stage 3, not here). This migration only covers Stage 0 tables.
-- Apply via Supabase MCP apply_migration (leader). Idempotent-ish where cheap.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles  (1 row per auth.users user; app role lives here)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
    id            uuid primary key references auth.users (id) on delete cascade,
    email         text,
    -- APP role (distinct from the Postgres "authenticated" role in the JWT).
    role          text not null default 'student'
                    check (role in ('student', 'teacher', 'admin')),
    display_name  text,
    avatar_url    text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. classes
-- ---------------------------------------------------------------------------
create table if not exists public.classes (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    join_code   text not null unique,
    teacher_id  uuid references public.profiles (id) on delete set null,
    created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. class_members  (a user may join many classes)
-- ---------------------------------------------------------------------------
create table if not exists public.class_members (
    class_id      uuid not null references public.classes (id) on delete cascade,
    user_id       uuid not null references public.profiles (id) on delete cascade,
    role_in_class text not null default 'student'
                    check (role_in_class in ('student', 'teacher')),
    created_at    timestamptz not null default now(),
    primary key (class_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 4. sessions  (a conversation tree; scoped personal | class)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references public.profiles (id) on delete cascade,
    space_kind      text not null default 'personal'
                      check (space_kind in ('personal', 'class')),
    -- personal -> owner's user id; class -> classes.id
    space_ref       uuid,
    title           text,
    emoji           text,
    root_node_id    uuid,     -- FK to nodes added after nodes table (see below)
    current_head_id uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. nodes  (1 row = one (question + answer) pair in the tree)
-- ---------------------------------------------------------------------------
create table if not exists public.nodes (
    id                 uuid primary key default gen_random_uuid(),
    session_id         uuid not null references public.sessions (id) on delete cascade,
    parent_id          uuid references public.nodes (id) on delete cascade,
    question           text,
    answer             text,
    label              text,            -- intended <= 10 chars (auto-labeled, Stage 1)
    position_x         double precision,
    position_y         double precision,
    is_navigator       boolean not null default false,
    navigator_question text,
    connections        uuid[] not null default '{}',   -- memory-link source nodes
    attachments        jsonb  not null default '{}'::jsonb,
    created_at         timestamptz not null default now()
);

-- sessions.root/head reference nodes; add FKs now that nodes exists.
alter table public.sessions
    drop constraint if exists sessions_root_node_id_fkey,
    add  constraint sessions_root_node_id_fkey
         foreign key (root_node_id) references public.nodes (id) on delete set null;

alter table public.sessions
    drop constraint if exists sessions_current_head_id_fkey,
    add  constraint sessions_current_head_id_fkey
         foreign key (current_head_id) references public.nodes (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_nodes_session_id      on public.nodes (session_id);
create index if not exists idx_nodes_parent_id       on public.nodes (parent_id);
create index if not exists idx_sessions_owner_id     on public.sessions (owner_id);
create index if not exists idx_sessions_space        on public.sessions (space_kind, space_ref);
create index if not exists idx_class_members_user_id on public.class_members (user_id);

-- ---------------------------------------------------------------------------
-- 7. Helper functions (SECURITY DEFINER -> bypass RLS to avoid recursion)
--    These are the membership/access predicates used inside policies.
-- ---------------------------------------------------------------------------

-- True if the current auth user is a member of the given class.
create or replace function public.is_class_member(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = auth.uid()
    );
$$;

-- True if the current auth user may READ the given session
-- (owner, OR member of the class the session belongs to).
create or replace function public.can_access_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.sessions s
        where s.id = p_session_id
          and (
                s.owner_id = auth.uid()
             or (s.space_kind = 'class' and public.is_class_member(s.space_ref))
          )
    );
$$;

-- ---------------------------------------------------------------------------
-- 8. handle_new_user trigger — auto-create a profile on auth.users insert
--    (Supabase standard pattern). Runs as definer so it bypasses RLS.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, email, display_name, avatar_url)
    values (
        new.id,
        new.email,
        coalesce(
            new.raw_user_meta_data ->> 'full_name',
            new.raw_user_meta_data ->> 'name',
            split_part(new.email, '@', 1)
        ),
        new.raw_user_meta_data ->> 'avatar_url'
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 9. Row Level Security
--    Baseline policy: callers see PERSONAL data they own + CLASS data of
--    classes they belong to. Writes to sessions/nodes are owner-only in
--    Stage 0 (class members are read-only); revisit when collaboration lands.
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.classes       enable row level security;
alter table public.class_members enable row level security;
alter table public.sessions      enable row level security;
alter table public.nodes         enable row level security;

-- ---- profiles: own row only (insert handled by trigger / definer) ----------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
    for select using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
    for update using (id = auth.uid()) with check (id = auth.uid());

-- ---- classes: members + teacher can read; teacher (self) can create/update -
drop policy if exists classes_select_member on public.classes;
create policy classes_select_member on public.classes
    for select using (
        teacher_id = auth.uid() or public.is_class_member(id)
    );

drop policy if exists classes_insert_teacher on public.classes;
create policy classes_insert_teacher on public.classes
    for insert with check (teacher_id = auth.uid());

drop policy if exists classes_update_teacher on public.classes;
create policy classes_update_teacher on public.classes
    for update using (teacher_id = auth.uid())
    with check (teacher_id = auth.uid());

-- ---- class_members: see own membership + co-members of shared classes ------
-- self-enrollment via join_code (class-join service) inserts a row for self.
drop policy if exists class_members_select on public.class_members;
create policy class_members_select on public.class_members
    for select using (
        user_id = auth.uid() or public.is_class_member(class_id)
    );

drop policy if exists class_members_insert_self on public.class_members;
create policy class_members_insert_self on public.class_members
    for insert with check (user_id = auth.uid());

drop policy if exists class_members_delete_self on public.class_members;
create policy class_members_delete_self on public.class_members
    for delete using (user_id = auth.uid());

-- ---- sessions: owner full access; class members read-only ------------------
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
    for select using (
        owner_id = auth.uid()
        or (space_kind = 'class' and public.is_class_member(space_ref))
    );

drop policy if exists sessions_insert_owner on public.sessions;
create policy sessions_insert_owner on public.sessions
    for insert with check (owner_id = auth.uid());

drop policy if exists sessions_update_owner on public.sessions;
create policy sessions_update_owner on public.sessions
    for update using (owner_id = auth.uid())
    with check (owner_id = auth.uid());

drop policy if exists sessions_delete_owner on public.sessions;
create policy sessions_delete_owner on public.sessions
    for delete using (owner_id = auth.uid());

-- ---- nodes: read if you can access the parent session; write = owner only --
drop policy if exists nodes_select on public.nodes;
create policy nodes_select on public.nodes
    for select using (public.can_access_session(session_id));

drop policy if exists nodes_insert_owner on public.nodes;
create policy nodes_insert_owner on public.nodes
    for insert with check (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = auth.uid()
        )
    );

drop policy if exists nodes_update_owner on public.nodes;
create policy nodes_update_owner on public.nodes
    for update using (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = auth.uid()
        )
    );

drop policy if exists nodes_delete_owner on public.nodes;
create policy nodes_delete_owner on public.nodes
    for delete using (
        exists (
            select 1 from public.sessions s
            where s.id = session_id and s.owner_id = auth.uid()
        )
    );

-- ============================================================================
-- End of 0001_init.sql
-- ============================================================================
