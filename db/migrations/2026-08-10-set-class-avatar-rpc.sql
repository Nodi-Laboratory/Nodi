-- 학급 사진 저장 창구 (2026-08-10 전면 점검에서 찾은 결함).
--
-- ## 무엇이 틀려 있었나
--
-- `classes`의 UPDATE 정책은 **만든 사람만**이다(`teacher_id = auth.uid()`).
-- 그런데 나머지 전부는 "이 학급의 선생님"을 `is_class_teacher()`로 판정한다 —
-- 만든 사람 **또는** 교사로 들어온 구성원. 그래서 부담임에게는:
--
--   · 교사 콘솔이 그 학급을 보여 주고
--   · "학급 사진 바꾸기" 버튼을 주고
--   · 파일은 저장소에 올라가고
--   · **행은 안 바뀌고**(RLS가 조용히 0행 갱신)
--   · 창구는 200을 돌려준다
--
-- 실측 2026-08-10: 200을 받았는데 사진은 그대로였다. 아무 데도 오류가 없다.
--
-- ## 왜 정책을 넓히지 않고 RPC를 두나
--
-- `classes` UPDATE를 통째로 넓히면 부담임이 학급 이름·참여 코드까지 바꿀 수
-- 있게 된다. 그건 사진과 다른 크기의 결정이다. 여기서 필요한 권한은 **딱
-- 하나** — 사진 경로 적기 — 이므로 그것만 여는 함수를 둔다. 판정은 여전히
-- DB가 한다(D104: 권한은 앱 코드로 옮기지 않는다).
--
-- 돌려주는 값은 "바꿨나"다. 앱은 false를 403으로 옮긴다 — **조용한 실패를
-- 성공으로 보고하지 않기 위해서**가 이 함수의 절반이다.
--
-- 멱등이다(CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.set_class_avatar(p_class_id uuid, p_path text)
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_updated int;
BEGIN
    -- 이 학급의 선생님인가 — 나머지 전부와 같은 규칙.
    IF NOT public.is_class_teacher(p_class_id) THEN
        RETURN false;
    END IF;

    UPDATE public.classes SET avatar_path = p_path WHERE id = p_class_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.set_class_avatar(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_class_avatar(uuid, text) TO nodi_app;
