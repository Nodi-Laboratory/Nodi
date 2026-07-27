-- 03_seed — 로컬 개발 시드 (D104, 구 supabase/seed.sql 대체)
--
-- **계정과 비밀번호는 이전과 동일하다** — teacher/student/admin@nodi.local,
-- 비밀번호 전부 `nodi-local-dev`. Supabase를 걷어냈다고 팀이 쓰던 계정이
-- 바뀌면 안 된다.
--
-- 비밀번호 해시는 bcrypt(pgcrypto의 crypt + gen_salt('bf')). 백엔드도 bcrypt로
-- 검증하므로 어느 쪽에서 만들어도 호환된다.
--
-- profiles 행은 on_auth_user_created 트리거가 자동 생성한다(02_triggers) —
-- 여기서는 role·onboarded만 덮어쓴다.

begin;

-- ---------------------------------------------------------------------------
-- 1. 계정
-- ---------------------------------------------------------------------------
-- 고정 UUID — 재시드해도 학급 참조가 흔들리지 않는다.
insert into public.users (id, email, password_hash, raw_user_meta_data)
values
    ('11111111-1111-1111-1111-111111111111', 'teacher@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     '{"full_name":"김선생","role":"teacher"}'::jsonb),
    ('22222222-2222-2222-2222-222222222222', 'student@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     '{"full_name":"이학생","role":"student"}'::jsonb),
    ('33333333-3333-3333-3333-333333333333', 'admin@nodi.local',
     crypt('nodi-local-dev', gen_salt('bf')),
     '{"full_name":"관리자"}'::jsonb)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. 역할 · 온보딩
-- ---------------------------------------------------------------------------
-- teacher/student는 트리거가 메타에서 읽어 이미 맞다. admin은 화이트리스트에
-- 없어(자체 가입으로 얻을 수 없는 역할, D99) 여기서 승격한다.
update public.profiles set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';

-- onboarded=false면 학생이 로그인 후 온보딩으로 돌아간다 — 시드 계정은 완료 상태로.
update public.profiles set onboarded = true
    where id in ('11111111-1111-1111-1111-111111111111',
                 '22222222-2222-2222-2222-222222222222',
                 '33333333-3333-3333-3333-333333333333');

-- ---------------------------------------------------------------------------
-- 3. 학급 + 구성원
-- ---------------------------------------------------------------------------
-- 학급이 있어야 class_material RAG·교과서 경로를 로컬에서 밟을 수 있다
-- (personal 세션만으로는 그 경로가 안 열린다).
insert into public.classes (id, name, join_code, teacher_id)
values ('44444444-4444-4444-4444-444444444444', '로컬 테스트 학급', 'LOCAL1',
        '11111111-1111-1111-1111-111111111111')
on conflict (id) do nothing;

insert into public.class_members (class_id, user_id, role_in_class)
values
    ('44444444-4444-4444-4444-444444444444',
     '11111111-1111-1111-1111-111111111111', 'teacher'),
    ('44444444-4444-4444-4444-444444444444',
     '22222222-2222-2222-2222-222222222222', 'student')
on conflict (class_id, user_id) do nothing;

commit;

-- app_settings(튜너블)은 01_schema.sql의 테이블 정의와 함께 이미 시드돼 있다.
