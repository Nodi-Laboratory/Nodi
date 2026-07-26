-- 로컬 개발용 시드 (D98)
--
-- `supabase start` / `supabase db reset` 시 마이그레이션 0001~0040 적용 후 실행된다.
-- **로컬 전용이다** — 원격 프로젝트에는 절대 적용하지 않는다.
--
-- 로컬 인증은 이메일/비밀번호를 쓴다(Google OAuth 아님). 로컬에 OAuth 클라이언트를
-- 붙이려면 별도 리다이렉트 등록이 필요한데, 2단계에서 구글 로그인을 자체
-- 리다이렉션으로 다시 구현할 예정이라 Supabase OAuth에 로컬을 더 묶지 않는다.
-- config.toml의 auth.email.enable_confirmations = false 라 가입 즉시 로그인된다.
--
-- 계정 3종 (비밀번호 전부 `nodi-local-dev`):
--   teacher@nodi.local  교사
--   student@nodi.local  학생 (아래 학급에 가입된 상태)
--   admin@nodi.local    관리자
--
-- profiles 행은 handle_new_user 트리거가 auth.users 삽입 시 자동 생성한다
-- (0001_init.sql §8) — 여기서는 role·onboarded만 덮어쓴다.

begin;

-- ---------------------------------------------------------------------------
-- 1. 인증 사용자
-- ---------------------------------------------------------------------------
-- id를 고정 UUID로 박아 두면 재시드해도 학급·세션 참조가 흔들리지 않는다.
insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
)
values
    ('00000000-0000-0000-0000-000000000000',
     '11111111-1111-1111-1111-111111111111',
     'authenticated', 'authenticated', 'teacher@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}',
     '{"full_name":"김선생"}',
     '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000',
     '22222222-2222-2222-2222-222222222222',
     'authenticated', 'authenticated', 'student@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}',
     '{"full_name":"이학생"}',
     '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000',
     '33333333-3333-3333-3333-333333333333',
     'authenticated', 'authenticated', 'admin@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}',
     '{"full_name":"관리자"}',
     '', '', '', '')
on conflict (id) do nothing;

-- GoTrue는 로그인 시 auth.identities를 조회한다 — 없으면 이메일 로그인이 실패한다.
insert into auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
)
select
    u.id::text, u.id,
    jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
    'email', now(), now(), now()
from auth.users u
where u.email in ('teacher@nodi.local', 'student@nodi.local', 'admin@nodi.local')
on conflict (provider, provider_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. 역할 · 온보딩 상태
-- ---------------------------------------------------------------------------
-- 트리거가 만든 프로필의 기본값은 role='student', onboarded=false 다.
-- onboarded=false면 OAuth 콜백이 /login으로 되돌리므로(e49d84d) 시드 계정은
-- 전부 온보딩 완료 상태로 둔다 — 바로 앱에 들어갈 수 있게.
update public.profiles set role = 'teacher', onboarded = true
    where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set role = 'student', onboarded = true
    where id = '22222222-2222-2222-2222-222222222222';
update public.profiles set role = 'admin',   onboarded = true
    where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- 3. 학급 + 구성원
-- ---------------------------------------------------------------------------
-- 학급이 있어야 class_material RAG·교과서 업로드 경로를 로컬에서 밟을 수 있다
-- (personal 세션만으로는 그 경로가 안 열린다).
insert into public.classes (id, name, join_code, teacher_id)
values (
    '44444444-4444-4444-4444-444444444444',
    '로컬 테스트 학급',
    'LOCAL1',
    '11111111-1111-1111-1111-111111111111'
)
on conflict (id) do nothing;

insert into public.class_members (class_id, user_id, role_in_class)
values
    ('44444444-4444-4444-4444-444444444444',
     '11111111-1111-1111-1111-111111111111', 'teacher'),
    ('44444444-4444-4444-4444-444444444444',
     '22222222-2222-2222-2222-222222222222', 'student')
on conflict (class_id, user_id) do nothing;

commit;

-- app_settings(튜너블)은 마이그레이션 0022·0029·0030이 시드하므로 여기서 다루지 않는다.
