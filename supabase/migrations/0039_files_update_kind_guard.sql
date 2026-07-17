-- ============================================================================
-- nodi — migration 0039 (files update kind 승급 가드; TASK 4 리뷰 후속, D86~D88)
-- 계획: docs/superpowers/plans/2026-07-16-textbook-figures-plan.md
--
-- DRAFT — 원격 적용 금지(사용자 승인 게이트, 0037/0038 관례). 미적용 상태에서도
-- 런타임은 정상 동작하나(FastAPI 계층이 kind를 서버에서 지정), 데이터 계층
-- 방어선(defense-in-depth)은 이 파일 적용 후에야 선다. Apply AFTER 0001..0038.
-- 멱등: drop policy if exists → create(0038 §6 insert 가드와 동형).
--
-- 배경(왜 update에도 가드가 필요한가):
--   files_update_own(0009 원본, 0024가 initplan으로 with check를 owner_id=
--   (select auth.uid())로 재설정)은 **owner만** 검사한다. 0038 §6은 insert만
--   막았고 update는 비대칭으로 남았다 — 학생이 자기 user_upload 행을 PostgREST
--   PATCH로 kind='textbook'/'class_material'로 flip할 수 있다. 최악은 split 처리
--   전 flip으로 학생 콘텐츠가 학급 RAG(files_select_class·file_chunks_select_class,
--   0038 §5)·figure(textbook_figures_select, 0038 §4)로 서빙되는 레이스.
--   → insert 가드(0038 §6)와 대칭으로 with check에 kind 승급 차단을 추가한다.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- files_update_own — using은 기존 의미(owner만) 유지, with check에 kind 승급
--   가드 추가. 교사는 여전히 자기 class_material·textbook을 수정 가능
--   (is_class_teacher(space_ref)), 학생의 kind 승급만 차단.
--   with check는 갱신 후(NEW) 행에 평가되므로 flip 결과 kind가 정확히 걸린다.
--   drop/재생성은 0038 §6과 동일하게 for update·무 to절 → roles=public 유지.
--   (select auth.uid()) initplan 패턴(0024)·is_class_teacher(space_ref) 행 인자
--   as-is 계승 — 0038 §6·§4 문안과 동형.
-- ---------------------------------------------------------------------------
drop policy if exists files_update_own on public.files;
create policy files_update_own on public.files
    for update
    using ( owner_id = (select auth.uid()) )
    with check (
        owner_id = (select auth.uid())
        and (
            kind not in ('class_material', 'textbook')
            or public.is_class_teacher(space_ref)
        )
    );

-- ============================================================================
-- End of 0039_files_update_kind_guard.sql
-- ============================================================================
