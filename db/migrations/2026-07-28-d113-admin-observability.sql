-- D113 — 운영 콘솔용 관리자 전역 읽기 + ai_logs 관측 컬럼
--
-- **이 폴더는 자동 적용되지 않는다.** db/ 최상위의 5개 파일만 빈 볼륨에서 1회
-- 실행된다(postgres 엔트리포인트는 하위 디렉터리를 건너뛴다). 여기 있는 스크립트는
-- **이미 데이터가 든 DB**를 최신 01_schema.sql과 맞출 때 손으로 적용한다:
--
--   docker exec -i nodi-postgres-1 psql -U postgres -d nodi \
--     < db/migrations/2026-07-28-d113-admin-observability.sql
--
-- 새 환경은 이 파일이 필요 없다 — 01_schema.sql에 이미 반영돼 있다.
-- 전부 멱등이라 여러 번 돌려도 안전하다.

begin;

-- ── ai_logs 관측 컬럼 ────────────────────────────────────────────────
-- token_estimate(글자수/4 어림)로는 과금·한도를 판단할 수 없었다. tokens는
-- 공급자가 준 실측 usage를 그대로 담고, 어림인 경우 calls[].estimated=true로
-- 구분한다.
alter table public.ai_logs
    add column if not exists tokens      jsonb not null default '{}'::jsonb,
    add column if not exists route       text,
    add column if not exists model       text,
    add column if not exists duration_ms integer;

-- ── 관리자 전역 읽기(읽기 전용) ──────────────────────────────────────
-- 콘솔이 "모든 문서·모든 대화"를 보여주려면 소유자·학급 밖까지 읽어야 한다.
-- 기존 sessions_select_admin / ai_logs_select_admin과 같은 형태이고, 쓰기
-- 정책은 손대지 않는다 — 권한은 계속 DB가 강제한다(D104).
do $$
begin
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'nodes'
                      and policyname = 'nodes_select_admin') then
        create policy nodes_select_admin on public.nodes
            for select using (public.is_admin());
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'files'
                      and policyname = 'files_select_admin') then
        create policy files_select_admin on public.files
            for select using (public.is_admin());
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'file_chunks'
                      and policyname = 'file_chunks_select_admin') then
        create policy file_chunks_select_admin on public.file_chunks
            for select using (public.is_admin());
    end if;

    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'textbook_figures'
                      and policyname = 'textbook_figures_select_admin') then
        create policy textbook_figures_select_admin on public.textbook_figures
            for select using (public.is_admin());
    end if;
end $$;

commit;
