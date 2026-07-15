-- ============================================================================
-- nodi — migration 0035 (D82 Task D — 파일 링크·배치 기능 삭제 + 제안 엔진 시드 정리)
--
-- 설계: docs/superpowers/specs/2026-07-15-legacy-purge-design.md §6(Task D).
-- 사용자 결정(2026-07-15): 링크 생성 UI가 없어 도달 불가한 file_node_links(RAG
-- 읽기만 활성)와 완전 휴면인 file_graph_nodes(배치)를 전부 삭제한다. 개발 환경 —
-- 데이터 손실 허용. RAG는 학급 자료 자동 스코프 단일 경로로 단순화된다.
--
-- ⚠️ 적용 순서(스펙 §3 필수): Task D 코드가 dev에 회수된 **후에만** 원격 적용한다.
--   현행 서버가 매 턴 file_node_links를 SELECT(rag.linked_file_ids) 중이고
--   배치 엔드포인트가 file_graph_nodes를 읽/쓰므로, 역순 적용 시 실행 중 서버가
--   즉시 깨진다. 이 파일은 작성만 하고 원격 적용은 Manager가 0032·0033·0034와
--   함께 코드 회수 후 일괄 수행한다.
--
-- 삭제 대상:
--   1) file_node_links(0010) — 시각적 RAG 링크. 생성 UI 소비 0(제안/링크 훅
--      컴포넌트 미소비 실측) → 사용자 도달 불가. 카드 묶임은 EXAONE cluster·
--      프론트 임베딩 그룹핑이 담당(링크 무관). 읽기 경로(rag.linked_file_ids)는
--      Task D 백엔드에서 제거됨 → 소비자 0.
--   2) file_graph_nodes(0021) — 그래프 자료 배치. 읽기·쓰기 컴포넌트 소비 0
--      (완전 휴면). Task D 백엔드에서 CRUD·라우터 제거됨 → 소비자 0.
--   3) app_settings의 file_suggestion_% 시드 행 — 제안 엔진 소멸(0019/0022 시드분).
--      config.py의 file_suggestion_* 키·rag.suggest_files가 Task D에서 제거됨.
--
-- delete_file_cascade(0033 재정의)는 `delete from files`로 FK cascade에만
-- 의존하므로 file_node_links 테이블 드랍 후에도 무변경으로 동작한다(참조 없음).
--
-- 적용 순서: 0001..0034 이후. drop table … cascade — 종속 FK/RLS/인덱스 일괄 정리.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 파일 링크·배치 테이블 드랍(종속 FK·RLS 정책·인덱스는 cascade로 함께 제거).
-- ---------------------------------------------------------------------------
drop table if exists public.file_node_links cascade;
drop table if exists public.file_graph_nodes cascade;

-- ---------------------------------------------------------------------------
-- 2. 제안 엔진 app_settings 시드 정리(제안 엔진 소멸 — 런타임 참조 0).
--    like 'file_suggestion_%' 로 0019 데드키(file_suggestion_max_distance)와
--    0022 시드 7종을 한 번에 정리(멱등).
-- ---------------------------------------------------------------------------
delete from public.app_settings where key like 'file_suggestion_%';

-- ============================================================================
-- End of 0035_drop_file_links_placements.sql
-- ============================================================================
