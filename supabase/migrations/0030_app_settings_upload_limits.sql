-- ============================================================================
-- nodi — migration 0030 (D77 — kind별 업로드 상한 시드 + 기본 상향)
-- 스펙: docs/superpowers/specs/2026-07-15-class-material-large-upload-design.md
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 미적용 상태에서도 런타임은
-- config.py 기본값으로 동작한다(D62 오버레이 폴백). 비파괴: 신규 키 시드 +
-- admin이 손대지 않은 시드값일 때만 조건부 갱신.
-- ============================================================================

insert into public.app_settings (key, value) values
    -- 학급 자료(class_material) 전용 상한. 524288000 = 500MB.
    ('class_material_max_bytes', '524288000'::jsonb)
on conflict (key) do nothing;

-- 학생·개인 업로드 기본 25→50MB: 0022 시드값 그대로일 때만 갱신(커스텀 보존).
update public.app_settings
   set value = '52428800'::jsonb
 where key = 'file_max_bytes' and value = '26214400'::jsonb;

-- End of 0030_app_settings_upload_limits.sql
