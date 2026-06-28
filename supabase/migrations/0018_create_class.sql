-- ============================================================================
-- nodi — migration 0018 (teacher class creation; D33)
--
-- PURPOSE
--   Let a TEACHER create their own class from the teacher console. There was no
--   class-creation path before (classes were seeded manually). Adds:
--     * nodi_gen_join_code() — random 6-char code, confusable chars excluded
--       (no I/L/O/0/1), matching the existing join-by-code flow (0002).
--     * create_class(p_name) SECURITY DEFINER RPC — app-role 'teacher' only;
--       inserts the class (teacher_id = caller, unique join_code w/ retry) and
--       enrolls the caller as a 'teacher' class_member; returns the class row.
--
-- APPLY ORDER: run AFTER 0001..0017. Additive (no destructive change).
-- RLS: classes already has classes_insert_teacher (teacher_id = auth.uid());
--   creation goes through this SECURITY DEFINER RPC, so no new policy is needed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. nodi_gen_join_code() — 6 chars from a confusable-free alphabet.
-- ---------------------------------------------------------------------------
create or replace function public.nodi_gen_join_code()
returns text
language sql
volatile
set search_path = public
as $$
    select string_agg(
        substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
               1 + floor(random() * 31)::int, 1),
        ''
    )
    from generate_series(1, 6);
$$;

-- ---------------------------------------------------------------------------
-- 2. create_class(p_name) — teacher-only class creation.
-- ---------------------------------------------------------------------------
create or replace function public.create_class(p_name text)
returns public.classes
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid   uuid := auth.uid();
    v_role  text;
    v_name  text := nullif(btrim(p_name), '');
    v_code  text;
    v_row   public.classes;
    v_tries int := 0;
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;
    -- App-role gate: only a 'teacher' may create classes.
    select role into v_role from public.profiles where id = v_uid;
    if v_role <> 'teacher' then
        raise exception 'teacher role required' using errcode = 'insufficient_privilege';
    end if;
    if v_name is null then
        raise exception 'class name required' using errcode = 'check_violation';
    end if;

    -- Insert with a unique join_code (retry a few times on the rare collision).
    loop
        v_tries := v_tries + 1;
        v_code := public.nodi_gen_join_code();
        begin
            insert into public.classes (name, join_code, teacher_id)
            values (v_name, v_code, v_uid)
            returning * into v_row;
            exit;  -- success
        exception when unique_violation then
            if v_tries >= 8 then
                raise exception 'could not allocate a unique join code'
                    using errcode = 'unique_violation';
            end if;
        end;
    end loop;

    -- Enroll the creating teacher as a class member (role_in_class = 'teacher').
    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_row.id, v_uid, 'teacher')
    on conflict (class_id, user_id) do nothing;

    return v_row;
end;
$$;

revoke execute on function public.create_class(text) from public, anon;
grant  execute on function public.create_class(text) to authenticated;

-- ============================================================================
-- End of 0018_create_class.sql
-- ============================================================================
