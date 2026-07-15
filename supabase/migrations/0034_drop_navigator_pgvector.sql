-- ============================================================================
-- nodi — migration 0034 (D81 Task C — navigator 컬럼 퍼지 + pgvector 확장 드랍)
--
-- 설계: docs/superpowers/specs/2026-07-15-legacy-purge-design.md §5(Task C).
-- 확인된 레거시(생산자 0)만 삭제한다. 개발 환경 — 데이터 손실 허용.
--
-- ⚠️ 적용 순서(스펙 §3 필수): Task C 코드가 dev에 회수된 **후에만** 원격 적용한다.
--   회수 전 코드가 nodes의 navigator 3컬럼을 SELECT(NODE_SELECT) 중이라, 역순
--   적용 시 실행 중 서버가 즉시 깨진다. 이 파일은 작성만 하고 원격 적용은 Manager가
--   0032·0033과 함께 일괄 수행한다.
--
-- 삭제 대상:
--   1) nodes.is_navigator·navigator_question·navigator_meta — 네비게이터 ReAct
--      제거로 생산자 0(navigator 행 0 실측·navigator_question 전부 null·
--      navigator_meta 기본값 {}뿐). 활성 소비자는 과거 데이터 방어 필터뿐이었고
--      Task C에서 그 필터를 제거했다(데이터 손실 허용 환경 — 전제 소멸).
--   2) pgvector("vector") 확장 — 사용자 지시(2026-07-15).
--      전제(안전): 0033이 마지막 vector 컬럼 2개(file_chunks.embedding·
--      art_assets.embedding)를 드랍하고, 그 둘의 hnsw 인덱스도 컬럼 드랍과 함께
--      사라진다. vector 타입을 인자로 받던 함수(search_file_chunks·
--      search_art_assets)는 0028에서 이미 드랍됐다. 즉 0033 이후 vector 타입에
--      의존하는 잔존 객체가 0(Manager 원격 실측: 그 2개가 전부). 0034는 0033
--      **뒤에** 적용되므로 종속 객체 없이 안전하게 드랍된다(cascade 불요 —
--      의존이 남아 있으면 오류로 드러나도록 plain drop).
--
-- 적용 순서: 0001..0033 이후.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. nodes 네비게이터 컬럼 3종 드랍(생산자 0 — delete 불요, if exists 로 멱등).
-- ---------------------------------------------------------------------------
alter table public.nodes drop column if exists is_navigator;
alter table public.nodes drop column if exists navigator_question;
alter table public.nodes drop column if exists navigator_meta;

-- ---------------------------------------------------------------------------
-- 2. pgvector 확장 드랍(0033이 마지막 vector 컬럼 2개를 드랍한 뒤 — 종속 객체 0).
-- ---------------------------------------------------------------------------
drop extension if exists vector;

-- ============================================================================
-- End of 0034_drop_navigator_pgvector.sql
-- ============================================================================
