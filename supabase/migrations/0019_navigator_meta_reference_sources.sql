-- ============================================================================
-- nodi — migration 0019 (navigator rationale + reference provenance + settings)
--
-- PURPOSE (04 인터랙션 정밀화)
--   D40: nodes.navigator_meta — store the navigator question's rationale at
--        generation time so the click popup ("이 질문으로 얻을 수 있는 내용") needs
--        NO extra AI call. shape: {"rationale": "..."}.
--   D46: nodes.reference_sources — which branches THIS answer referenced this
--        turn. shape: [ {kind:'comparison', label, node_ids:[...], leaf_id,
--        session_id} ].
--   D37/D40/D43/D47: seed runtime settings keys for admin/user tuning.
--
-- APPLY ORDER: run AFTER 0001..0018. Non-destructive (additive columns + seed).
--   nodes RLS / realtime unaffected (column adds only with constant defaults →
--   short lock). Existing rows take the defaults ({} / []), which the frontend
--   reads as "none".
-- ============================================================================

-- 1) Navigator rationale (D40): shown in the click popup without a second model
--    call. Generated alongside the question and saved here.
alter table public.nodes
    add column if not exists navigator_meta jsonb not null default '{}'::jsonb;

-- 2) Reference provenance (D46): branches this answer pulled in this turn.
alter table public.nodes
    add column if not exists reference_sources jsonb not null default '[]'::jsonb;

-- 3) Runtime settings seed (D37/D40/D43/D47). jsonb values; keep if present.
insert into public.app_settings (key, value) values
    ('file_suggestion_enabled',         'true'::jsonb),
    ('file_suggestion_min_query_chars', '40'::jsonb),
    ('file_suggestion_max_distance',    '0.50'::jsonb),  -- D28 runtime-read seed
    ('navigator_enabled',               'true'::jsonb)
on conflict (key) do nothing;
