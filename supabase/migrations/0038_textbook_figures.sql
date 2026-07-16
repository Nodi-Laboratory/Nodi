-- ============================================================================
-- nodi — migration 0038 (textbook figures; TASK 4, D86~D88)
-- 계획: docs/superpowers/plans/2026-07-16-textbook-figures-plan.md
--
-- DRAFT — 원격 적용은 배포 시(파일만 추가). 이 마이그레이션은 스키마·정책·시드만
-- 추가하며 런타임 동작을 바꾸지 않는다(이 task만 배포돼도 안전). 미적용 상태에서도
-- 런타임은 config.py 기본값으로 동작한다(D62 오버레이 폴백).
-- 멱등: 모든 문에 if not exists / drop ... if exists.
--
-- 0009/0012/0013/0020/0024/0037의 관례(자동명 check 제약, 정책명,
-- (select auth.uid()) initplan 패턴)를 따른다. Apply AFTER 0001..0037.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) files.kind에 'textbook' 추가.
--    0009는 인라인 무명 check(kind in (...))라 Postgres가 단일 컬럼 규칙으로
--    자동명 files_kind_check를 붙였다 — 0037이 file_chunks 상태 check를
--    file_chunks_status_check 자동명으로 drop/재생성해 이 규칙을 실증한다.
--    무명 → 명명 제약으로 재생성해 이후 관리 가능하게.
-- ---------------------------------------------------------------------------
alter table public.files drop constraint if exists files_kind_check;
alter table public.files
    add constraint files_kind_check
    check (kind in ('user_upload', 'class_material', 'textbook'));

-- ---------------------------------------------------------------------------
-- 2) jobs.kind에 'figure_batch' 추가(같은 단일 컬럼 자동명 규칙 → jobs_kind_check).
--    figure 임베딩 팬아웃 잡의 kind.
-- ---------------------------------------------------------------------------
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs
    add constraint jobs_kind_check
    check (kind in ('embedding_split', 'embedding_batch', 'figure_batch'));

-- ---------------------------------------------------------------------------
-- 3) textbook_figures — 교과서 figure 메타·판정·임베딩 상태.
--    본문(이미지)은 Storage, 임베딩 벡터는 Qdrant(textbook_figures 컬렉션);
--    이 테이블은 식별자·메타·판정·상태만 보관(file_chunks와 동일한 신뢰 경계).
-- ---------------------------------------------------------------------------
create table if not exists public.textbook_figures (
    id             uuid primary key default gen_random_uuid(),
    file_id        uuid not null references public.files (id) on delete cascade,
    seq            integer not null,             -- figure_batch batch_range 팬아웃 기준(0-base)
    page           integer,                      -- 전역 페이지(D78 조각 오프셋 보정 후)
    element_id     integer,
    bbox           jsonb,                        -- [x0,y0,x1,y1] 정규화 좌표
    caption        text not null default '',     -- 위치기반 매칭 캡션
    alt            text not null default '',
    description    text not null default '',     -- enhanced figure-description(영어)
    figure_type    text not null default '',
    heading        text not null default '',
    candidates     jsonb not null default '[]'::jsonb,  -- 판정 후보 top-K
    selected_index integer,                      -- 판정 결과(-1=해당없음, null=미판정)
    judge_reason   text,
    match_kind     text not null default '',     -- caption|paragraph|alt-only|judge|judge-none|judge-error
    embed_text     text not null default '',
    image_path     text not null,                -- Storage 키 {owner}/{file_id}/figures/pN_eM.ext
    status         text not null default 'pending'
                     check (status in ('pending', 'embedded', 'failed')),
    created_at     timestamptz not null default now(),
    unique (file_id, seq)
);

create index if not exists idx_textbook_figures_file
    on public.textbook_figures (file_id, seq);

-- ---------------------------------------------------------------------------
-- 4) RLS — select 정책만. 쓰기 정책 부재 = service_role 전용(워커만 RLS 우회
--    삽입/갱신). 정책 부재가 곧 최종사용자 쓰기 거부다. select: 파일 소유자
--    또는 그 교과서를 올린 학급의 구성원. (select auth.uid()) initplan(0024).
--    is_class_member(f.space_ref)는 행 인자라 initplan 대상 아님 — as-is.
-- ---------------------------------------------------------------------------
alter table public.textbook_figures enable row level security;

drop policy if exists textbook_figures_select on public.textbook_figures;
create policy textbook_figures_select on public.textbook_figures
    for select using (
        exists (
            select 1 from public.files f
            where f.id = file_id
              and (
                   f.owner_id = (select auth.uid())
                or (f.kind = 'textbook' and public.is_class_member(f.space_ref))
              )
        )
    );

-- ---------------------------------------------------------------------------
-- 5) 교차읽기 정책 확장(0012) — textbook을 class_material과 동급으로 학급
--    구성원에게 읽기 허용. class_material 술어는 kind in (...)의 부분집합으로
--    보존되므로 기존 동작 불변(교사 자료 가시성 그대로) + textbook 추가.
-- ---------------------------------------------------------------------------
drop policy if exists files_select_class on public.files;
create policy files_select_class on public.files
    for select using (
        kind in ('class_material', 'textbook') and public.is_class_member(space_ref)
    );

drop policy if exists file_chunks_select_class on public.file_chunks;
create policy file_chunks_select_class on public.file_chunks
    for select using (
        exists (
            select 1 from public.files f
            where f.id = file_id
              and f.kind in ('class_material', 'textbook')
              and public.is_class_member(f.space_ref)
        )
    );

-- ---------------------------------------------------------------------------
-- 6) insert 가드 확장(보안 필수). 최신 정의는 0024가 ALTER POLICY로 재설정한
--    with check(owner_id=(select auth.uid()) and (kind <> 'class_material'
--    or is_class_teacher(space_ref)))다. 미확장 시 학생이 PostgREST로 textbook
--    행을 직접 삽입 가능해(교사 아님인데 교과서 파일 목록 오염) 보안 구멍이 된다.
--    → textbook도 class_material과 동일하게 교사 전용으로 강제.
--    (0024가 ALTER POLICY라 policyname/roles/cmd 불변; drop/재생성도 동일 for
--     insert·무 to절이라 roles=public 유지. initplan 패턴 계승.)
-- ---------------------------------------------------------------------------
drop policy if exists files_insert_own on public.files;
create policy files_insert_own on public.files
    for insert with check (
        owner_id = (select auth.uid())
        and (
            kind not in ('class_material', 'textbook')
            or public.is_class_teacher(space_ref)
        )
    );

-- ---------------------------------------------------------------------------
-- 7) get_chunk_context(0020) 가시성 확장 — 청크가 textbook 파일 소속이어도
--    학급 구성원이 원문 패널을 볼 수 있게. 0020 원문을 그대로 복사하고
--    kind = 'class_material' 조건만 kind in ('class_material','textbook')로 수정.
-- ---------------------------------------------------------------------------
create or replace function public.get_chunk_context(
    p_chunk_id  uuid,
    p_neighbors int default 1
)
returns table (
    file_id    uuid,
    name       text,
    seq        int,
    page       int,
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
        select fc.id, fc.file_id, fc.seq, fc.chunk_text, fc.meta
          from public.file_chunks fc
          join public.files f on f.id = fc.file_id
         where fc.id = p_chunk_id
           and (
                f.owner_id = auth.uid()
             or (f.kind in ('class_material', 'textbook')
                 and public.is_class_member(f.space_ref))
           )
    )
    select t.file_id,
           split_part(
               f.storage_path, '/',
               array_length(string_to_array(f.storage_path, '/'), 1)
           ) as name,
           t.seq,
           -- null-safe page: only cast a clean integer string, else NULL.
           case
               when t.meta->>'page' ~ '^[0-9]+$' then (t.meta->>'page')::int
               else null
           end as page,
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
-- 8) 튜너블 시드(D62 — admin 콘솔 노출 전제). config.py 기본값과 동기.
--    비파괴: 신규 키 시드만(on conflict do nothing — 커스텀 보존).
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
    ('figure_pipeline_enabled', 'true'::jsonb),
    ('figure_retrieve_max_distance', '0.60'::jsonb),
    ('figure_judge_concurrency', '4'::jsonb)
on conflict (key) do nothing;

-- ============================================================================
-- End of 0038_textbook_figures.sql
-- ============================================================================
