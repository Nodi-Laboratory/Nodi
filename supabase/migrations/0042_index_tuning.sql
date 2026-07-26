-- 0042 — 인덱스 정리·정합 (D101)
--
-- 두 갈래다:
--   (1) 중복 인덱스 제거 — 같은 컬럼 조합이 두 벌씩 있어 쓰기 비용만 늘리고 있었다.
--   (2) 정렬 컬럼을 포함하도록 기존 인덱스를 제자리 교체 — 인덱스 **개수는 그대로**
--       이므로 쓰기 비용 증가 없이 ORDER BY의 Sort 단계를 없앤다.
--
-- 실측 근거(로컬 스택, sessions 301 / nodes 18,001 합성):
--   · 캔버스 재수화(nodes where session_id order by created_at)
--     → Bitmap Index Scan + **Sort(quicksort)**
--   · 홈 최근 세션(owner_id order by updated_at desc limit 10)
--     → Seq Scan + **top-N heapsort**
--   · 공간별 세션 목록(space_kind+space_ref order by updated_at desc)
--     → Seq Scan + **top-N heapsort**
--
-- 주의: CONCURRENTLY는 트랜잭션 안에서 못 쓰므로 쓰지 않았다. 대상 테이블이 작아
-- (원격 nodes 226행) 잠금 시간은 무시할 수준이다.

-- ---------------------------------------------------------------------------
-- 1. 완전 중복 인덱스 제거
-- ---------------------------------------------------------------------------
-- UNIQUE 제약이 이미 (file_id, seq) 인덱스를 만든다. 같은 정의가 두 벌이었다.
drop index if exists public.idx_file_chunks_file;        -- = file_chunks_file_id_seq_key
drop index if exists public.idx_textbook_figures_file;   -- = textbook_figures_file_id_seq_key

-- (session_id)는 (session_id, created_at desc)의 선행 접두사라 별도로 둘 이유가 없다.
drop index if exists public.idx_ai_logs_session;         -- ⊂ idx_ai_logs_session_created

-- ---------------------------------------------------------------------------
-- 2. 정렬 컬럼을 포함하도록 제자리 교체
-- ---------------------------------------------------------------------------
-- 어느 것이든 선행 컬럼이 그대로라 FK 커버링 인덱스 역할(0025)도 유지된다.

-- nodes: 캔버스 재수화가 세션의 전 노드를 created_at 순으로 읽는다(가장 잦은 읽기).
drop index if exists public.idx_nodes_session_id;
create index if not exists idx_nodes_session_created
    on public.nodes (session_id, created_at);

-- sessions: 홈 "최근 대화"는 소유자 기준 최신순.
drop index if exists public.idx_sessions_owner_id;
create index if not exists idx_sessions_owner_updated
    on public.sessions (owner_id, updated_at desc);

-- sessions: 공간(개인/학급) 세션 목록도 최신순.
drop index if exists public.idx_sessions_space;
create index if not exists idx_sessions_space_updated
    on public.sessions (space_kind, space_ref, updated_at desc);

-- files: 자료실 목록(공간 스코프 + 최신순). 교사 콘솔·학생 세션 파일 양쪽이 쓴다.
drop index if exists public.idx_files_space;
create index if not exists idx_files_space_created
    on public.files (space_kind, space_ref, created_at desc);
