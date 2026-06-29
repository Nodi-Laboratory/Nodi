-- ============================================================================
-- nodi — migration 0022 (07 page design — RAG/navigator/embedding settings seed)
-- Source of truth: planning/07-페이지-설계/architecture.md §1.6, decisions D66.
--
-- DRAFT — NOT APPLIED HERE. Apply via Supabase MCP apply_migration (leader),
-- after review. Fully NON-DESTRUCTIVE: seed INSERTs only, no DDL, no UPDATE.
--
-- Why: the admin console (SettingsTab) renders a widget for a key only when a
-- row exists in app_settings (GET /admin/settings lists table rows). 0008
-- seeded only 12 keys; the newly-exposed RAG/navigator/embedding tuning keys
-- have no row yet, so they would not appear. This seeds them at their config.py
-- defaults so they show up and become live-tunable through the D62 overlay.
--
-- `on conflict (key) do nothing` preserves any value an admin already set
-- (idempotent). The DEAD key `file_suggestion_max_distance` (D63) is NOT seeded.
-- ============================================================================

insert into public.app_settings (key, value) values
    -- File-suggestion gate (D63 — these are the REAL keys the runtime reads).
    ('file_suggestion_enabled',              'true'::jsonb),
    ('file_suggestion_suggest_max_distance', '0.38'::jsonb),
    ('file_suggestion_suggest_margin',       '0.05'::jsonb),
    ('file_suggestion_suggest_query_chars',  '450'::jsonb),
    ('file_suggestion_top_n',                '1'::jsonb),
    ('file_suggestion_search_k',             '20'::jsonb),
    ('file_suggestion_min_query_chars',      '10'::jsonb),
    -- RAG injection.
    ('rag_top_k',                            '5'::jsonb),
    -- Navigator global on/off + shared-tag gate (navigator_c also in 0008;
    -- re-listed harmlessly — on conflict do nothing).
    ('navigator_enabled',                    'true'::jsonb),
    ('navigator_c',                          '1'::jsonb),
    -- Embedding / upload (chunk_* are new-only; embedding_* are danger keys —
    -- the worker integrity-guards embedding_dimension against vector(768)).
    ('chunk_size_chars',                     '1200'::jsonb),
    ('chunk_overlap_chars',                  '150'::jsonb),
    ('embedding_dimension',                  '768'::jsonb),
    ('embedding_model',                      '"gemini-embedding-001"'::jsonb),
    ('ocr_model',                            '"gemini-2.5-flash"'::jsonb),
    ('file_max_bytes',                       '26214400'::jsonb)
on conflict (key) do nothing;

-- End of 0022_app_settings_rag_seed.sql
