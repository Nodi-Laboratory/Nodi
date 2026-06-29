-- ============================================================================
-- nodi — migration 0023 (07 page design — teacher console home overview RPC)
-- Source of truth: planning/07-페이지-설계/architecture.md §2.4, decisions D67.
--
-- DRAFT — NOT APPLIED HERE. Apply via Supabase MCP apply_migration (leader),
-- after review. ADDITIVE: a new SECURITY DEFINER RPC (create-or-replace), no
-- table/column change. Existing teacher_classes() (0012) is untouched.
--
-- Powers the teacher console HOME (class card grid): per-class student count,
-- class-material count, and last activity. The teacher cannot count other
-- students' sessions/files under RLS, so — like teacher_classes / class_students
-- — this is a SECURITY DEFINER function guarded by is_class_teacher(c.id).
--
-- SCHEMA-VERIFIED CASTS (recurring-bug guard): sessions.space_ref AND
-- files.space_ref are BOTH `uuid` (migrations 0001 L60, 0009 L27), and
-- classes.id is `uuid` (0001 L32). So the join is uuid = uuid — NO `::text`
-- cast (the architecture draft's `c.id::text` was wrong and would raise a type
-- mismatch). class material rows are kind='class_material' + space_kind='class'
-- (0009 L25-30); the student filter is class_members.role_in_class='student'
-- (0001 L45) — same predicates teacher_classes() / class_students() use.
-- ============================================================================

create or replace function public.teacher_class_overview()
returns table (
    id               uuid,
    name             text,
    join_code        text,
    created_at       timestamptz,
    student_count    bigint,
    material_count   bigint,
    last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select c.id,
           c.name,
           c.join_code,
           c.created_at,
           (
               select count(*)
                 from public.class_members m
                where m.class_id = c.id
                  and m.role_in_class = 'student'
           )::bigint as student_count,
           (
               select count(*)
                 from public.files f
                where f.kind = 'class_material'
                  and f.space_kind = 'class'
                  and f.space_ref = c.id
           )::bigint as material_count,
           greatest(
               (
                   select max(s.updated_at)
                     from public.sessions s
                    where s.space_kind = 'class'
                      and s.space_ref = c.id
               ),
               (
                   select max(f.created_at)
                     from public.files f
                    where f.kind = 'class_material'
                      and f.space_kind = 'class'
                      and f.space_ref = c.id
               )
           ) as last_activity_at
      from public.classes c
     where public.is_class_teacher(c.id)
     order by last_activity_at desc nulls last, c.created_at desc;
$$;

revoke execute on function public.teacher_class_overview() from public, anon;
grant  execute on function public.teacher_class_overview() to authenticated;

-- End of 0023_teacher_class_overview.sql
