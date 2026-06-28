-- ============================================================================
-- nodi — migration 0013 (files insert defense-in-depth; Stage 4b review)
-- The FastAPI layer already blocks non-teachers from uploading class_material
-- (_assert_class_teacher), but files_insert_own (0009) only checked owner_id.
-- A student could PostgREST-insert a class_material row directly (no searchable
-- chunks result, since file_chunks insert is service_role-only — so no RAG/leak
-- — but it pollutes the class file list). Add a WITH CHECK guard so the data
-- layer enforces the same invariant (mirrors 0003 R1/R4 pattern).
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0012.
-- ============================================================================

drop policy if exists files_insert_own on public.files;
create policy files_insert_own on public.files
    for insert with check (
        owner_id = auth.uid()
        and (kind <> 'class_material' or public.is_class_teacher(space_ref))
    );

-- ============================================================================
-- End of 0013_files_insert_guard.sql
-- ============================================================================
