-- ============================================================================
-- nodi — migration 0027 (SVG art library; concept-card illustrations)
-- Table: art_assets (pgvector) + search_art_assets() RPC.
--
-- A shared, read-only catalog of Claude-generated SVG illustrations. Each row is
-- an SVG (served statically from /art/{slug}.svg) with a tag/description embedding
-- (gemini-embedding-001, 768d, L2-normalized). At chat time the frontend queries a
-- concept title and, if a close match exists, renders the SVG on the card.
--
-- Writes happen ONLY from the offline generation script (backend/scripts/
-- generate_art.py) using service_role (RLS bypass). End users get read + search.
--
-- Apply via Supabase MCP apply_migration. Run AFTER 0001..0026.
-- pgvector ("vector") is already enabled on this project.
-- ============================================================================

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. art_assets
-- ---------------------------------------------------------------------------
create table if not exists public.art_assets (
    id           uuid primary key default gen_random_uuid(),
    slug         text not null unique,
    title        text,
    description  text,
    tags         text[] not null default '{}',
    -- public path served by the frontend (e.g. /art/earth-interior.svg)
    storage_path text not null,
    embedding    vector(768),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- ANN index for cosine similarity search.
create index if not exists idx_art_assets_embedding
    on public.art_assets using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 2. RLS — public read-only catalog (writes via service_role bypass RLS).
-- ---------------------------------------------------------------------------
alter table public.art_assets enable row level security;

drop policy if exists art_assets_select_all on public.art_assets;
create policy art_assets_select_all on public.art_assets
    for select to authenticated
    using (true);

-- ---------------------------------------------------------------------------
-- 3. search_art_assets — cosine top-K over the whole catalog.
-- ---------------------------------------------------------------------------
create or replace function public.search_art_assets(
    p_query_embedding vector(768),
    p_k               int default 1
)
returns table (
    slug         text,
    title        text,
    tags         text[],
    storage_path text,
    distance     double precision
)
language sql
stable
security definer
set search_path = public
as $$
    select a.slug,
           a.title,
           a.tags,
           a.storage_path,
           (a.embedding <=> p_query_embedding)::double precision as distance
      from public.art_assets a
     where a.embedding is not null
     order by a.embedding <=> p_query_embedding
     limit greatest(1, p_k);
$$;

revoke execute on function public.search_art_assets(vector, int) from public, anon;
grant  execute on function public.search_art_assets(vector, int) to authenticated;

-- ============================================================================
-- End of 0027_art_assets.sql
-- ============================================================================
