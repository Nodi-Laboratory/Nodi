-- 0041 — 자체 회원가입: 가입 시 역할 지정 (D99)
--
-- 배경: Google OAuth를 제거하고 이메일/비밀번호 자체 가입으로 전환한다(D99).
-- OAuth 시절에는 가입 경로가 하나뿐이라 role이 항상 기본값 'student'였고,
-- 교사 계정은 admin이 승격시켜야 했다. 자체 가입에서는 가입 폼에서 역할을
-- 고르므로 그 값을 프로필에 반영해야 한다.
--
-- **권한 상승 차단(중요)**: raw_user_meta_data는 클라이언트가 signUp 시 자유롭게
-- 채워 보내는 값이다. 그대로 신뢰하면 누구나 role='admin'으로 가입할 수 있다.
-- 화이트리스트를 강제해 'student'|'teacher'만 허용하고, 그 외(admin 포함·오타·
-- 미지정)는 전부 'student'로 떨어뜨린다. admin은 여전히 admin_set_user_role로만
-- 부여된다.
--
-- 이 마이그레이션은 handle_new_user를 교체할 뿐 기존 프로필 행은 건드리지 않는다.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    requested text := new.raw_user_meta_data ->> 'role';
begin
    insert into public.profiles (id, email, display_name, avatar_url, role)
    values (
        new.id,
        new.email,
        coalesce(
            new.raw_user_meta_data ->> 'full_name',
            new.raw_user_meta_data ->> 'name',
            split_part(new.email, '@', 1)
        ),
        new.raw_user_meta_data ->> 'avatar_url',
        -- 화이트리스트: 자체 가입으로 얻을 수 있는 역할은 이 둘뿐이다.
        case when requested in ('student', 'teacher') then requested
             else 'student' end
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

-- 트리거는 0001에서 이미 붙어 있다(on_auth_user_created). 함수만 교체하면 된다.
