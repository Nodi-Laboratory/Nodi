-- 쓰지 않는 RPC를 걷어낸다 (2026-08-10 전면 점검).
--
-- `teacher_classes()`는 교사 콘솔의 **드롭다운**이 쓰던 함수다. 콘솔이
-- `teacher_class_overview()` 하나로 정리되면서 부르는 곳이 없어졌고, 그
-- 창구(`GET /api/teacher/classes`)도 같은 날 지웠다.
--
-- 그냥 두면 되지 않나 — **`SECURITY DEFINER`라서** 그렇지 않다. 정의자 권한으로
-- 도는 함수는 호출 경로가 없어도 **권한이 있는 채로 남는다.** 나중에 누군가
-- 이름만 보고 되살려 쓰면, 지금 사라진 그 창구가 무슨 규칙으로 스코프를
-- 지켰는지 아무도 기억하지 못한다. 쓰지 않는 권한은 지운다.
--
-- 멱등이다 — 두 번 돌려도 같다.

DROP FUNCTION IF EXISTS public.teacher_classes();
