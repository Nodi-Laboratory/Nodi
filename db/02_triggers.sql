-- 02_triggers — public.users 트리거 (D104)
--
-- 가입(public.users insert) 때 handle_new_user가 profiles 행을 만든다. **함수 본문은**
-- 01_schema.sql에 있다 — D99의 역할 화이트리스트가 계속 강제된다:
-- raw_user_meta_data.role은 클라이언트가 보내는 값이라 신뢰하지 않고,
-- 'student'|'teacher'만 허용하며 그 외(admin 포함)는 student로 떨어뜨린다.

drop trigger if exists on_auth_user_created on public.users;

create trigger on_auth_user_created
    after insert on public.users
    for each row execute function public.handle_new_user();

-- updated_at 자동 갱신.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
    before update on public.users
    for each row execute function public.touch_updated_at();
