-- ============================================================================
-- nodi — migration 0009 (file RAG embedding infra; Stage 3b-1)
-- Tables: files, file_chunks (pgvector), jobs  + Storage bucket & policies.
-- Pipeline: upload -> jobs(embedding_split) -> file_chunks(pending) +
--           jobs(embedding_batch) children -> parallel embed -> indexed.
--
-- Embedding dim = 768 (gemini-embedding-001 with output_dimensionality=768;
-- text-embedding-004 is unavailable on the current API key). Worker writes via
-- service_role (RLS bypass), so worker-write policies are NOT needed; RLS here
-- governs end-user (owner) reads. Visual RAG / search / file tagging / class
-- materials / OCR are Stage 3b-2.
--
-- Apply via Supabase MCP apply_migration (leader). Run AFTER 0001..0008.
-- pgvector ("vector") is already enabled on this project.
-- ============================================================================

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. files
-- ---------------------------------------------------------------------------
create table if not exists public.files (
    id          uuid primary key default gen_random_uuid(),
    owner_id    uuid not null references public.profiles (id) on delete cascade,
    space_kind  text not null default 'personal'
                  check (space_kind in ('personal', 'class')),
    space_ref   uuid,
    uploader_id uuid references public.profiles (id) on delete set null,
    kind        text not null default 'user_upload'
                  check (kind in ('user_upload', 'class_material')),
    storage_path text not null,
    mime        text,
    size_bytes  bigint,
    status      text not null default 'uploaded'
                  check (status in ('uploaded', 'splitting', 'embedding',
                                    'indexed', 'partial', 'failed')),
    chunk_total integer not null default 0,
    chunk_done  integer not null default 0,
    error       text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists idx_files_owner on public.files (owner_id);
create index if not exists idx_files_space on public.files (space_kind, space_ref);

-- ---------------------------------------------------------------------------
-- 2. file_chunks (pgvector embeddings)
-- ---------------------------------------------------------------------------
create table if not exists public.file_chunks (
    id         uuid primary key default gen_random_uuid(),
    file_id    uuid not null references public.files (id) on delete cascade,
    seq        integer not null,
    chunk_text text not null,
    embedding  vector(768),
    status     text not null default 'pending'
                 check (status in ('pending', 'embedded', 'failed')),
    meta       jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (file_id, seq)
);

create index if not exists idx_file_chunks_file on public.file_chunks (file_id, seq);
create index if not exists idx_file_chunks_status on public.file_chunks (status);
-- ANN index for cosine similarity search (Stage 3b-2 uses it).
create index if not exists idx_file_chunks_embedding
    on public.file_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 3. jobs (background queue — also feeds admin job monitor)
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
    id            uuid primary key default gen_random_uuid(),
    owner_id      uuid references public.profiles (id) on delete cascade,
    kind          text not null
                    check (kind in ('embedding_split', 'embedding_batch')),
    target_id     uuid,              -- file_id
    parent_job_id uuid references public.jobs (id) on delete cascade,
    batch_range   jsonb,             -- {"from_seq": int, "to_seq": int}
    status        text not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'failed')),
    error         text,
    progress      integer not null default 0,
    attempts      integer not null default 0,
    space_ref     uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists idx_jobs_status on public.jobs (status, created_at);
create index if not exists idx_jobs_owner on public.jobs (owner_id);
create index if not exists idx_jobs_target on public.jobs (target_id);

-- ---------------------------------------------------------------------------
-- 4. RLS — owner reads (workers use service_role and bypass RLS).
-- ---------------------------------------------------------------------------
alter table public.files       enable row level security;
alter table public.file_chunks enable row level security;
alter table public.jobs        enable row level security;

-- files: owner full access (class_material cross-visibility is Stage 3b-2).
drop policy if exists files_select_own on public.files;
create policy files_select_own on public.files
    for select using (owner_id = auth.uid());
drop policy if exists files_insert_own on public.files;
create policy files_insert_own on public.files
    for insert with check (owner_id = auth.uid());
drop policy if exists files_update_own on public.files;
create policy files_update_own on public.files
    for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists files_delete_own on public.files;
create policy files_delete_own on public.files
    for delete using (owner_id = auth.uid());

-- file_chunks: readable if the parent file is the caller's.
drop policy if exists file_chunks_select_own on public.file_chunks;
create policy file_chunks_select_own on public.file_chunks
    for select using (
        exists (
            select 1 from public.files f
            where f.id = file_id and f.owner_id = auth.uid()
        )
    );

-- jobs: owner reads own jobs; admins read all (job monitor).
drop policy if exists jobs_select_own on public.jobs;
create policy jobs_select_own on public.jobs
    for select using (
        owner_id = auth.uid() or public.is_admin()
    );

-- ---------------------------------------------------------------------------
-- 5. Storage bucket + policies (private bucket; owner-scoped by path prefix)
--    Path convention: {owner_id}/{file_id}/{filename}
--    Workers upload/download via service_role (RLS bypass); these policies let
--    the owner read/manage their own objects directly if needed.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('files', 'files', false)
on conflict (id) do nothing;

drop policy if exists files_objects_select_own on storage.objects;
create policy files_objects_select_own on storage.objects
    for select to authenticated
    using (
        bucket_id = 'files'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists files_objects_insert_own on storage.objects;
create policy files_objects_insert_own on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'files'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists files_objects_delete_own on storage.objects;
create policy files_objects_delete_own on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'files'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- ============================================================================
-- End of 0009_files_rag.sql
-- ============================================================================
