-- ============================================================================
-- nodi — migration 0012 (class materials + teacher panel; Stage 4b)
-- Adds:
--   * cross-visibility RLS so class members (students + teachers) can READ
--     class_material files / chunks (owner = the uploading teacher);
--   * search_file_chunks() updated so students can RAG-search class materials;
--   * teacher_classes() / class_students() RPCs (students' profiles are not
--     otherwise visible to teachers via RLS).
--
-- ADDITIVE only: existing owner policies stay (Postgres OR-combines policies);
-- search_file_chunks is create-or-replace. Reuses is_class_member /
-- is_class_teacher (0001 / 0003).
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0011.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Class-material cross visibility (read) for class members
-- ---------------------------------------------------------------------------
drop policy if exists files_select_class on public.files;
create policy files_select_class on public.files
    for select using (
        kind = 'class_material' and public.is_class_member(space_ref)
    );

drop policy if exists file_chunks_select_class on public.file_chunks;
create policy file_chunks_select_class on public.file_chunks
    for select using (
        exists (
            select 1 from public.files f
            where f.id = file_id
              and f.kind = 'class_material'
              and public.is_class_member(f.space_ref)
        )
    );

-- ---------------------------------------------------------------------------
-- 2. search_file_chunks — include class materials of classes the caller is in
--    (replaces the owner-only filter from 0010).
-- ---------------------------------------------------------------------------
create or replace function public.search_file_chunks(
    p_query_embedding vector(768),
    p_file_ids        uuid[],
    p_k               int default 5
)
returns table (
    file_id    uuid,
    chunk_id   uuid,
    seq        int,
    chunk_text text,
    distance   double precision
)
language sql
stable
security definer
set search_path = public
as $$
    select fc.file_id,
           fc.id,
           fc.seq,
           fc.chunk_text,
           (fc.embedding <=> p_query_embedding)::double precision as distance
      from public.file_chunks fc
      join public.files f on f.id = fc.file_id
     where fc.file_id = any (p_file_ids)
       and (
            f.owner_id = auth.uid()
         or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
       )
       and fc.status = 'embedded'
       and fc.embedding is not null
     order by fc.embedding <=> p_query_embedding
     limit greatest(1, p_k);
$$;

revoke execute on function public.search_file_chunks(vector, uuid[], int)
    from public, anon;
grant  execute on function public.search_file_chunks(vector, uuid[], int)
    to authenticated;

-- ---------------------------------------------------------------------------
-- 3. teacher_classes() — classes the caller teaches, with student counts
-- ---------------------------------------------------------------------------
create or replace function public.teacher_classes()
returns table (
    id            uuid,
    name          text,
    join_code     text,
    created_at    timestamptz,
    student_count bigint
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
                where m.class_id = c.id and m.role_in_class = 'student'
           )::bigint as student_count
      from public.classes c
     where public.is_class_teacher(c.id)
     order by c.created_at desc;
$$;

revoke execute on function public.teacher_classes() from public, anon;
grant  execute on function public.teacher_classes() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. class_students(p_class_id) — students of a class the caller teaches.
--    is_class_teacher() in the WHERE acts as the guard (no rows otherwise).
-- ---------------------------------------------------------------------------
create or replace function public.class_students(p_class_id uuid)
returns table (
    user_id       uuid,
    email         text,
    display_name  text,
    avatar_url    text,
    role_in_class text,
    joined_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select cm.user_id,
           p.email,
           p.display_name,
           p.avatar_url,
           cm.role_in_class,
           cm.created_at
      from public.class_members cm
      join public.profiles p on p.id = cm.user_id
     where cm.class_id = p_class_id
       and cm.role_in_class = 'student'
       and public.is_class_teacher(p_class_id)
     order by p.display_name nulls last, cm.created_at;
$$;

revoke execute on function public.class_students(uuid) from public, anon;
grant  execute on function public.class_students(uuid) to authenticated;

-- ============================================================================
-- End of 0012_class_materials.sql
-- ============================================================================
