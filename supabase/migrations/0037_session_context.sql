-- ============================================================================
-- nodi — migration 0037 (D83·D84 — 학생 파일 세션 컨텍스트 주입, TASK 3)
-- 스펙: docs/superpowers/specs/2026-07-15-student-session-context-design.md
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 미적용 상태에서도 런타임은
-- config.py 기본값으로 동작한다(D62 오버레이 폴백). session_id는 0011에서
-- 도입됐다가 0033(D81)에서 소비 0으로 드랍된 이력 — 이번엔 세션 전문 주입
-- (D83)의 소비 경로가 함께 생긴다.
-- ============================================================================

-- 1) 파일-세션 연결(D83). 세션 삭제 시 파일은 남기되 연결만 끊는다(set null).
alter table public.files
    add column if not exists session_id uuid
        references public.sessions (id) on delete set null;

create index if not exists idx_files_session
    on public.files (session_id) where session_id is not null;

-- 2) 세션 컨텍스트 예산 원장(D84) — user_upload 통과 시 워커가 문자 수 기록.
alter table public.files
    add column if not exists context_chars integer;

-- 3) 청크 상태 'stored' 허용(D83) — user_upload는 임베딩 없이 저장만.
--    ('pending'은 영구 대기로 오독되고 'embedded'는 거짓이므로 신규 값.)
alter table public.file_chunks
    drop constraint if exists file_chunks_status_check;
alter table public.file_chunks
    add constraint file_chunks_status_check
    check (status in ('pending', 'embedded', 'failed', 'stored'));

-- 4) 예산 튜너블 시드(D84·D62) — admin 콘솔 노출.
insert into public.app_settings (key, value) values
    ('session_context_max_chars', '150000'::jsonb)
on conflict (key) do nothing;

-- End of 0037_session_context.sql
