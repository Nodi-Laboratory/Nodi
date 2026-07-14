-- ============================================================================
-- nodi — migration 0029 (TASK 2 / D73 — 학급 자료 자동 RAG 스코프 튜너블 시드)
-- 스펙: docs/superpowers/specs/2026-07-14-teacher-material-rag-gaps-design.md
--
-- DRAFT — 여기서 원격 적용하지 않는다(파일만 추가, 배포 시 적용). 미적용
-- 상태에서도 런타임은 config.py 기본값으로 동작한다(D62 오버레이 폴백).
-- 완전 비파괴: 시드 INSERT만, DDL·UPDATE 없음.
--
-- Why: admin 콘솔(SettingsTab)은 app_settings에 행이 있는 키만 위젯으로
-- 노출한다. D73 신규 노브 2종을 config 기본값으로 시드해 admin에서 라이브
-- 튜닝 가능하게 한다. on conflict do nothing — 이미 설정된 값 보존(멱등).
-- ============================================================================

insert into public.app_settings (key, value) values
    -- 학급 자료 자동 주입 경로 킬 스위치.
    ('class_material_rag_enabled',      'true'::jsonb),
    -- 자동 스코프(비링크) 청크 거리 게이트 (distance = 1 - score, clamp 0.1~0.9).
    ('class_material_rag_max_distance', '0.50'::jsonb)
on conflict (key) do nothing;

-- End of 0029_app_settings_class_rag_seed.sql
