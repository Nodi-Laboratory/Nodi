-- ============================================================================
-- nodi — migration 0033 (D81 — 레거시 테이블·컬럼·RPC 전면 삭제)
--
-- 설계: docs/superpowers/specs/2026-07-15-legacy-purge-design.md §1(DB).
-- 확인된 레거시(생산자 0 또는 소비자 0)만 삭제한다. 개발 환경 — 데이터 손실 허용.
--
-- ⚠️ 적용 순서(스펙 §3 필수): Task A/B 코드가 dev에 회수된 **후에만** 원격 적용한다.
--   현행(회수 전) 코드가 여기서 삭제하는 컬럼(FILE_SELECT의 uploader_id/session_id/
--   position, file_chunks.meta 등)을 SELECT 중이라, 역순 적용 시 실행 중 서버가
--   즉시 깨진다. 이 파일은 작성만 하고 원격 적용은 Manager가 수행한다.
--
-- 삭제 대상(전수):
--   1) 태그 스택 — tags·node_tags·file_tags 테이블 + RPC/함수
--      (upsert_node_tags·upsert_file_tags·get_file_tags·tag_cooccurrence·
--       nodi_norm_tag). 생산자 0(채팅 태그 구설계 + D80 파일 태깅 제거).
--   2) delete_file_cascade 재정의 — 고아 태그 정리부(D29) 제거(파일 행+청크+
--      링크 cascade는 보존). 태그 테이블 소멸로 기존 정의가 참조 오류가 된다.
--   3) ReAct 트레이스 — ai_sessions·ai_steps 테이블 + admin_token_usage RPC
--      (네비게이터 ReAct 제거로 생산자 0, admin_token_usage는 ai_steps 전용 집계).
--   4) get_chunk_context 재정의 — file_chunks.meta 파생 page 컬럼 제거
--      (meta 컬럼 드랍의 필수 후속 — 기존 sql 본문이 fc.meta를 읽는다).
--   5) files 죽은 컬럼 — uploader_id(전 행 owner_id 동일·RLS 미사용)·
--      session_id·position_x·position_y(D58/D59 file_graph_nodes로 대체, 0행) +
--      idx_files_uploader(0025)·idx_files_session(0011).
--   6) file_chunks.embedding·file_chunks.meta — 0028 Qdrant 이전(벡터 0행)·
--      meta 쓰기 코드 0.
--   7) art_assets.embedding — 0028 Qdrant 이전. 코드 grep 결과 Supabase측
--      독자·기록자 0 확인(검색은 Qdrant art_assets 컬렉션, generate_art.py는
--      embedding 컬럼 제외 upsert).
--   8) app_settings 죽은 시드 — 네비게이터·라벨 생성 키(런타임 참조 0).
--
-- 적용 순서: 0001..0032 이후.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. delete_file_cascade 재정의 — 태그 정리부(D29) 제거 버전으로 교체.
--    파일 행 삭제 → FK cascade(file_chunks / file_node_links)는 그대로 보존한다.
--    스토리지 객체 삭제·Qdrant 벡터 정리는 앱(service_role)이 담당(files.py).
--    ※ 태그 함수·테이블을 드랍하기 전에 먼저 교체해 참조 오류 창을 없앤다.
-- ---------------------------------------------------------------------------
create or replace function public.delete_file_cascade(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner uuid;
begin
    select owner_id into v_owner from public.files where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if v_owner <> auth.uid() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    -- 파일 삭제 → file_chunks / file_node_links 를 FK cascade 로 제거.
    delete from public.files where id = p_file_id;
end;
$$;

revoke execute on function public.delete_file_cascade(uuid) from public, anon;
grant  execute on function public.delete_file_cascade(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. 태그 RPC/함수 드랍. tag_cooccurrence 는 language sql(테이블 의존 추적)이라
--    테이블 드랍 전에 반드시 먼저 제거해야 한다. 나머지는 plpgsql(본문 미추적)
--    이지만 명시적으로 정리한다.
-- ---------------------------------------------------------------------------
drop function if exists public.tag_cooccurrence(text, uuid);
drop function if exists public.upsert_node_tags(uuid, uuid, text[]);
drop function if exists public.upsert_file_tags(uuid, text[]);
drop function if exists public.get_file_tags(uuid);
drop function if exists public.nodi_norm_tag(text);

-- ---------------------------------------------------------------------------
-- 3. 태그 테이블 드랍. node_tags·file_tags 가 tags(id) 를 FK 참조하므로 자식
--    먼저 → tags 순. cascade 로 정책·인덱스·제약을 함께 제거한다.
-- ---------------------------------------------------------------------------
drop table if exists public.node_tags cascade;
drop table if exists public.file_tags cascade;
drop table if exists public.tags      cascade;

-- ---------------------------------------------------------------------------
-- 4. ReAct 트레이스 — admin_token_usage(ai_steps 전용 집계) 후 테이블 드랍.
--    ai_steps.ai_session_id 가 ai_sessions(id) 를 FK 참조 → 자식 먼저.
--    cascade 로 정책(*_select_own/insert_own/*_select_admin)·인덱스 함께 제거.
-- ---------------------------------------------------------------------------
drop function if exists public.admin_token_usage();
drop table if exists public.ai_steps    cascade;
drop table if exists public.ai_sessions cascade;

-- ---------------------------------------------------------------------------
-- 5. get_chunk_context 재정의 — file_chunks.meta 파생 page 컬럼 제거.
--    반환 테이블 시그니처(page 제거)가 바뀌므로 create or replace 불가 → 드랍 후
--    재생성. 가시성(소유/클래스 자료)·이웃 청크 로직은 그대로 보존한다(D41).
-- ---------------------------------------------------------------------------
drop function if exists public.get_chunk_context(uuid, int);

create function public.get_chunk_context(
    p_chunk_id  uuid,
    p_neighbors int default 1
)
returns table (
    file_id    uuid,
    name       text,
    seq        int,
    chunk_text text,
    prev_text  text,
    next_text  text
)
language sql
stable
security definer
set search_path = public
as $$
    with target as (
        select fc.id, fc.file_id, fc.seq, fc.chunk_text
          from public.file_chunks fc
          join public.files f on f.id = fc.file_id
         where fc.id = p_chunk_id
           and (
                f.owner_id = auth.uid()
             or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
           )
    )
    select t.file_id,
           split_part(
               f.storage_path, '/',
               array_length(string_to_array(f.storage_path, '/'), 1)
           ) as name,
           t.seq,
           t.chunk_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq - p_neighbors) as prev_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq + p_neighbors) as next_text
      from target t
      join public.files f on f.id = t.file_id;
$$;

revoke execute on function public.get_chunk_context(uuid, int) from public, anon;
grant  execute on function public.get_chunk_context(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. files 죽은 컬럼 + 인덱스 드랍. 컬럼 드랍이 종속 인덱스를 자동 제거하지만
--    멱등·명시성을 위해 인덱스를 먼저 드랍한다.
-- ---------------------------------------------------------------------------
drop index if exists public.idx_files_uploader;   -- 0025
drop index if exists public.idx_files_session;     -- 0011

alter table public.files drop column if exists uploader_id;
alter table public.files drop column if exists session_id;
alter table public.files drop column if exists position_x;
alter table public.files drop column if exists position_y;

-- ---------------------------------------------------------------------------
-- 7. file_chunks 벡터/메타 컬럼 드랍(0028 Qdrant 이전 완료 — 인덱스·검색 RPC는
--    0028에서 이미 제거, get_chunk_context 는 위 5에서 meta 참조 해제).
-- ---------------------------------------------------------------------------
alter table public.file_chunks drop column if exists embedding;
alter table public.file_chunks drop column if exists meta;

-- ---------------------------------------------------------------------------
-- 8. art_assets 벡터 컬럼 드랍(Supabase측 독자·기록자 0 — 검색은 Qdrant).
-- ---------------------------------------------------------------------------
alter table public.art_assets drop column if exists embedding;

-- ---------------------------------------------------------------------------
-- 9. app_settings 죽은 시드 정리 — 네비게이터·라벨 생성 키(런타임 참조 0).
--    존재하는 것만 삭제(멱등). 0008 시드는 navigator_* / label_model 을 넣는다.
-- ---------------------------------------------------------------------------
delete from public.app_settings
 where key in (
    'navigator_enabled',
    'navigator_c',
    'navigator_k',
    'navigator_period',
    'navigator_question_count',
    'label_model',
    'navigator_model'
 );

-- ============================================================================
-- End of 0033_drop_legacy.sql
-- ============================================================================
