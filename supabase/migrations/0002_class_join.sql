-- ============================================================================
-- nodi — migration 0002 (Stage 0): class-join RPC
-- 학급 가입은 "비멤버가 join_code로 학급을 찾아 본인을 class_members에 추가"해야 하는데
-- classes의 RLS는 (교사|멤버)만 select 가능하므로 일반 RLS로는 코드 조회가 불가하다.
-- → SECURITY DEFINER 함수로 코드 조회 + 본인(auth.uid()) 멤버십 insert를 캡슐화한다.
-- 가입/온보딩과 프로필 설정의 "학급 추가"가 공용으로 호출(D9: class-join 서비스).
-- 이 함수는 RLS 정책 내부에서 쓰이지 않으므로 anon/PUBLIC EXECUTE를 회수해도 안전.
-- ============================================================================

create or replace function public.join_class_by_code(p_code text)
returns public.class_members
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class_id uuid;
    v_row      public.class_members;
begin
    if auth.uid() is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    select id into v_class_id
    from public.classes
    where join_code = p_code;

    if v_class_id is null then
        raise exception 'invalid_join_code' using errcode = 'P0002';
    end if;

    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_class_id, auth.uid(), 'student')
    on conflict (class_id, user_id) do nothing;

    select * into v_row
    from public.class_members
    where class_id = v_class_id and user_id = auth.uid();

    return v_row;
end;
$$;

-- 직접 RPC 노출 최소화: anon/PUBLIC 회수, 로그인 사용자만 호출 가능.
revoke execute on function public.join_class_by_code(text) from public;
revoke execute on function public.join_class_by_code(text) from anon;
grant  execute on function public.join_class_by_code(text) to authenticated;
