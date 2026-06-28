-- ============================================================================
-- nodi — migration 0011 (UX refinements; D12..D21 / architecture §10)
-- Additive columns only (no RLS/policy changes):
--   profiles.onboarded      — one-time onboarding flag (D18)
--   files.session_id        — file shown as a node in a session graph (D13)
--   files.position_x/y      — file-node coordinates (D13)
-- nodes.position_x/y already exist (0001) and are reused for D20 coord persist.
--
-- Plus mark_onboarded() RPC: 0003 only granted UPDATE(display_name, avatar_url)
-- on profiles to `authenticated`, so users cannot set `onboarded` via PATCH.
-- A small SECURITY DEFINER RPC flips their own flag without touching grants.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0010.
-- ============================================================================

alter table public.profiles
    add column if not exists onboarded boolean not null default false;

alter table public.files
    add column if not exists session_id uuid references public.sessions (id)
        on delete set null;
alter table public.files
    add column if not exists position_x double precision;
alter table public.files
    add column if not exists position_y double precision;

create index if not exists idx_files_session on public.files (session_id);

-- ---------------------------------------------------------------------------
-- mark_onboarded — set the caller's own profiles.onboarded = true
-- ---------------------------------------------------------------------------
create or replace function public.mark_onboarded()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
       set onboarded = true, updated_at = now()
     where id = auth.uid();
    return found;
end;
$$;

revoke execute on function public.mark_onboarded() from public, anon;
grant  execute on function public.mark_onboarded() to authenticated;

-- ============================================================================
-- End of 0011_ux.sql
-- ============================================================================
