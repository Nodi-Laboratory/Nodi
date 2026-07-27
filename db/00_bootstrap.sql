-- 00_bootstrap — Supabase 없이 도는 Postgres 기반 (D104)
--
-- 이 파일은 스키마(01_schema.sql)보다 **먼저** 실행된다. 스키마의 정책·함수가
-- 여기서 만드는 auth.uid() 와 public.users 에 의존하기 때문이다.
--
-- 설계 요지(D104-1/2): RLS는 Supabase 기능이 아니라 **Postgres 기능**이다.
-- Supabase Auth가 제공하던 것은 `auth.uid()` 함수 하나뿐이었으므로, 그것만
-- 우리 것으로 갈아끼우면 **RLS 정책 32개와 DB 함수 19개가 한 글자도 바뀌지
-- 않고 그대로 산다.** 권한 규칙을 앱 코드로 옮기면서 생길 구멍을 원천 차단한다.

-- ---------------------------------------------------------------------------
-- 확장
-- ---------------------------------------------------------------------------
-- gen_random_uuid() (pg13+ 내장이지만 명시), citext(대소문자 무시 이메일)
create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- 1. auth.uid() — 현재 요청 사용자
-- ---------------------------------------------------------------------------
-- Supabase는 JWT 클레임에서 읽었다. 우리는 **트랜잭션 로컬 설정**에서 읽는다.
-- 백엔드가 요청마다 `SET LOCAL app.user_id = '<uuid>'` 를 넣는다.
--
-- SET LOCAL은 트랜잭션 스코프라 커밋/롤백 시 자동으로 사라진다 — 커넥션 풀에서
-- 다음 요청이 앞 사용자의 값을 물려받는 사고가 구조적으로 불가능하다.
--
-- 미설정(워커·마이그레이션)이면 NULL을 돌려준다. 정책들은 NULL과의 비교가
-- 전부 거짓이 되므로 "아무것도 못 봄"으로 안전하게 닫힌다.
create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

comment on function auth.uid() is
  'D104: 현재 요청 사용자 UUID. 백엔드가 SET LOCAL app.user_id로 주입한다.';

-- ---------------------------------------------------------------------------
-- 2. public.users — 자체 인증 사용자 (구 auth.users 대체)
-- ---------------------------------------------------------------------------
-- Supabase GoTrue가 들고 있던 계정 정보를 우리 테이블로 가져온다. 앱이 직접
-- 다루는 값만 둔다(비밀번호 해시·이메일). 프로필 정보는 기존대로 profiles에.
--
-- RLS를 켜되 정책을 두지 않는다 — 이 테이블은 **인증 경로에서만** 접근하며
-- 그 경로는 BYPASSRLS인 nodi_worker 역할을 쓴다. 사용자 요청(nodi_app)은
-- 비밀번호 해시를 어떤 경우에도 읽을 수 없다.
create table if not exists public.users (
    id            uuid primary key default gen_random_uuid(),
    email         citext not null unique,
    password_hash text not null,
    -- 가입 시 클라이언트가 보낸 메타(이름·역할 희망값). 신뢰하지 않는다 —
    -- 역할 화이트리스트는 handle_new_user가 강제한다(D99).
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

alter table public.users enable row level security;

comment on table public.users is
  'D104: 자체 인증 계정. 비밀번호 해시는 nodi_worker(BYPASSRLS)만 접근한다.';

-- ---------------------------------------------------------------------------
-- 3. 애플리케이션 역할
-- ---------------------------------------------------------------------------
-- 현재 UserClient/ServiceClient 구분을 DB 역할로 재현한다.
--   nodi_app    — RLS 적용. 사용자 요청 경로.
--   nodi_worker — BYPASSRLS. 백그라운드 워커·인증(구 service_role).
--
-- 비밀번호는 부트스트랩 시 환경변수로 덮어쓴다(docker-compose initdb).
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'nodi_app') then
        create role nodi_app login password 'nodi_app_dev';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'nodi_worker') then
        create role nodi_worker login bypassrls password 'nodi_worker_dev';
    end if;
end
$$;

grant usage on schema public, auth to nodi_app, nodi_worker;

-- 이후 생성되는 객체에도 자동 부여(01_schema.sql이 뒤에 돈다).
alter default privileges in schema public
    grant select, insert, update, delete on tables to nodi_app, nodi_worker;
alter default privileges in schema public
    grant usage, select on sequences to nodi_app, nodi_worker;
alter default privileges in schema public
    grant execute on functions to nodi_app, nodi_worker;
alter default privileges in schema auth
    grant execute on functions to nodi_app, nodi_worker;

-- public.users는 위 ALTER DEFAULT PRIVILEGES **이전에** 생성됐으므로 자동
-- 부여 대상이 아니다(default privileges는 이후 객체에만 적용). 명시적으로 준다.
--
-- **nodi_app에는 주지 않는다.** 비밀번호 해시가 든 테이블이라 사용자 요청
-- 경로에서는 아예 읽히지 않아야 한다 — RLS 정책 이전에 GRANT 단계에서 막는다
-- (정책을 잘못 쓰더라도 뚫리지 않는 이중 방어).
grant select, insert, update, delete on public.users to nodi_worker;

-- auth.uid()는 정책·함수가 모든 역할에서 호출한다.
grant execute on function auth.uid() to nodi_app, nodi_worker;
