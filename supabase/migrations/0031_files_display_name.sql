-- ============================================================================
-- nodi — migration 0031 (D79 — files.name: 원본 표시명 보존)
--
-- 배경: Supabase Storage는 비ASCII 스토리지 키를 InvalidKey(400)로 거부한다
-- (2026-07-15 라이브 실측: 한글 키는 NFC/NFD 불문 전부 거부, ASCII는 공백·괄호
-- 포함 허용). 이를 피하려 스토리지 키를 ASCII로 강제하면 한글 원본 파일명이
-- 키에서 사라진다 → 사용자에게 보여줄 표시명을 별도 컬럼 `name`에 보존한다
-- (업로드 시 NFC 정규화 원본을 기록; RAG/제안 표시명이 이 컬럼을 우선 사용).
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 비파괴: 신규 nullable 컬럼 + 백필.
-- 백필 전(name NULL) 구파일은 애플리케이션이 storage_path basename으로 폴백한다.
-- ============================================================================

alter table public.files add column if not exists name text;

-- 구파일 백필: storage_path "{owner}/{file_id}/{name}"의 마지막 세그먼트.
update public.files
   set name = regexp_replace(storage_path, '^.*/', '')
 where name is null and storage_path is not null;

-- End of 0031_files_display_name.sql
