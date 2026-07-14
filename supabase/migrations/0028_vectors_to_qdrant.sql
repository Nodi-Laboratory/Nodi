-- ============================================================================
-- nodi — migration 0028 (벡터 저장소 Qdrant 이전; Upstage 4096d)
--
-- 임베딩이 Gemini 768d(pgvector) -> Upstage 4096d(Qdrant)로 이전됐다.
-- Supabase에는 더 이상 벡터를 저장/검색하지 않는다:
--   * file_chunks.embedding / art_assets.embedding 컬럼은 남긴다(비파괴 —
--     과거 768d 데이터 보존, 새 파이프라인은 미기록). vector(768)이라
--     4096d는 어차피 못 담는다 — 벡터는 Qdrant 컬렉션(file_chunks /
--     art_assets / ebs, size=4096, Cosine)에만 업서트한다.
--   * hnsw 인덱스와 검색 RPC(search_file_chunks, search_art_assets)는 제거 —
--     검색은 백엔드가 qdrant_store.search()로 수행하고, 히트한 chunk_id의
--     본문은 USER 스코프 클라이언트로 재조회해 RLS가 접근을 재검증한다
--     (services/rag.py). Qdrant 페이로드는 신뢰 경계가 아니다(본문 없음).
--
-- 적용 순서: 0001..0027 이후. RPC를 호출하지 않는 백엔드 배포와 함께 적용할
-- 것(구 백엔드가 남아 있으면 search_* RPC 호출이 실패한다). RLS 정책/청크
-- 본문 조회 경로(0009/0012 select 정책, 0020 get_chunk_context)는 그대로다.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. embedding 컬럼 — 0009/0027 기준 이미 nullable이지만 방어적으로 명시
--    (멱등·무해; 새 파이프라인이 절대 NOT NULL에 걸리지 않도록 고정).
-- ---------------------------------------------------------------------------
alter table public.file_chunks alter column embedding drop not null;
alter table public.art_assets  alter column embedding drop not null;

-- ---------------------------------------------------------------------------
-- 2. ANN(hnsw) 인덱스 제거 — 벡터 검색은 Qdrant가 담당.
-- ---------------------------------------------------------------------------
drop index if exists public.idx_file_chunks_embedding;
drop index if exists public.idx_art_assets_embedding;

-- ---------------------------------------------------------------------------
-- 3. pgvector 검색 RPC 제거 (0012/0017에서 search_file_chunks, 0027에서
--    search_art_assets 정의 — 시그니처는 최종본 기준).
-- ---------------------------------------------------------------------------
drop function if exists public.search_file_chunks(vector, uuid[], int);
drop function if exists public.search_art_assets(vector, int);

-- ============================================================================
-- End of 0028_vectors_to_qdrant.sql
-- ============================================================================
