-- ============================================================================
-- nodi — migration 0029 (교과서 RAG 어드민 튜너블 시드)
-- Source of truth: docs/superpowers/specs/2026-07-13-textbook-rag-design.md
--
-- DRAFT — NOT APPLIED HERE. Apply via Supabase MCP apply_migration (leader),
-- after review. Fully NON-DESTRUCTIVE: seed INSERTs only, no DDL, no UPDATE.
--
-- Why: admin 콘솔(SettingsTab)은 app_settings 테이블에 행이 존재하는 키만
-- 위젯으로 렌더한다(GET /admin/settings). 교과서 RAG 3개 키는 rag.py에서
-- D62 app_settings 오버레이로 읽히지만 시드 행이 없어 콘솔에 노출되지 않는다.
-- config.py 기본값으로 시드하여 admin이 실시간으로 튜닝 가능하게 한다.
--
-- `on conflict (key) do nothing` preserves any value an admin already set
-- (idempotent). 0022 패턴 동일.
-- ============================================================================

insert into public.app_settings (key, value) values
    -- 교과서 RAG 활성화 여부 — false 이면 textbook 컬렉션 검색을 완전 건너뜀.
    ('textbook_rag_enabled',      'true'::jsonb),
    -- 교과서 RAG 검색 시 반환할 최대 청크 수.
    ('textbook_rag_top_k',        '4'::jsonb),
    -- 교과서 RAG 코사인 거리 필터 — 이 값보다 먼 청크는 결과에서 제외됨.
    ('textbook_rag_max_distance', '0.45'::jsonb)
on conflict (key) do nothing;

-- End of 0029_app_settings_textbook_seed.sql
