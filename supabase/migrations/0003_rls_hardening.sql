-- ============================================================================
-- nodi — migration 0003 (RLS hardening; code-review security fixes)
-- Builds on 0001_init.sql. Idempotent (drop-and-create / if exists).
--
-- Fixes:
--   B1  profiles.role self-escalation     -> column-level UPDATE grants
--   S1  class_members self-insert         -> removed; join via RPC only
--   R2  class session visibility          -> owner + class TEACHER only
--   R1  class session insert membership    -> with-check requires membership
--   R4  class creation requires teacher    -> with-check requires role='teacher'
--
-- NOTE: is_class_member() is still used inside policies and MUST keep its
-- anon/authenticated EXECUTE grants — do NOT revoke them (would break RLS).
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001 (and 0002).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- B1 — profiles: block role (and other sensitive column) self-modification.
--      RLS profiles_update_own still restricts WHICH row (own); column grants
--      restrict WHICH columns (display_name / avatar_url only).
-- ---------------------------------------------------------------------------
revoke update on public.profiles from authenticated;
grant  update (display_name, avatar_url) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- S1 — class_members: remove direct self-insert. Joining a class must go
--      through the join_class_by_code RPC (SECURITY DEFINER), which can
--      validate the join_code before enrolling. select / delete_self stay.
-- ---------------------------------------------------------------------------
drop policy if exists class_members_insert_self on public.class_members;

-- ---------------------------------------------------------------------------
-- R2 — helper: is the current user a TEACHER of the given class?
--      (class_members.role_in_class = 'teacher' OR classes.teacher_id = self)
-- ---------------------------------------------------------------------------
create or replace function public.is_class_teacher(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = auth.uid()
          and cm.role_in_class = 'teacher'
    )
    or exists (
        select 1 from public.classes c
        where c.id = p_class_id
          and c.teacher_id = auth.uid()
    );
$$;

-- Lock down EXECUTE: only authenticated callers. (is_class_member is left as-is.)
revoke execute on function public.is_class_teacher(uuid) from public, anon;
grant  execute on function public.is_class_teacher(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- R2 — can_access_session: class branch now requires TEACHER (students do not
--      see each other's sessions). Owner always retains access.
--      nodes_select uses this function, so it inherits the change.
-- ---------------------------------------------------------------------------
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
             or (s.space_kind = 'class' and public.is_class_teacher(s.space_ref))
          )
    );
$$;

-- ---------------------------------------------------------------------------
-- R2 — sessions_select: same isolation (owner + class teacher).
-- ---------------------------------------------------------------------------
drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions
    for select using (
        owner_id = auth.uid()
        or (space_kind = 'class' and public.is_class_teacher(space_ref))
    );

-- ---------------------------------------------------------------------------
-- R1 — sessions_insert: a class-scoped session requires the owner to actually
--      be a member of that class (personal sessions unrestricted beyond owner).
-- ---------------------------------------------------------------------------
drop policy if exists sessions_insert_owner on public.sessions;
create policy sessions_insert_owner on public.sessions
    for insert with check (
        owner_id = auth.uid()
        and (
            space_kind = 'personal'
            or public.is_class_member(space_ref)
        )
    );

-- ---------------------------------------------------------------------------
-- R4 — classes_insert: creator must be a teacher (app role) and the named
--      teacher_id. Prevents students from creating classes.
-- ---------------------------------------------------------------------------
drop policy if exists classes_insert_teacher on public.classes;
create policy classes_insert_teacher on public.classes
    for insert with check (
        teacher_id = auth.uid()
        and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'teacher'
        )
    );

-- ============================================================================
-- End of 0003_rls_hardening.sql
-- ============================================================================
