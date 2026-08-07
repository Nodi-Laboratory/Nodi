-- D207 카드 밀어내기 노브
--
-- 카드를 끌면 배경의 카드들이 비켜 준다. 그 손맛을 정하는 값 셋을 관리자가
-- 만질 수 있어야 한다(사용자 지시 2026-08-07: "밀려남의 강도, 밀려남의 속도,
-- 서로 다른 두 카드 사이의 최소 거리와 같은 설정값들을 관리자페이지에서
-- 관리가 가능하도록").
--
-- ## 멱등이다
--
-- 없는 행만 넣는다. 관리자가 이미 값을 정해 뒀으면 건드리지 않는다.
--
-- 부팅 때 카탈로그를 보고 빠진 행을 채우는 길도 있지만(D113), 그건 다음
-- 재시작에나 돈다. 배포 직후부터 콘솔에 뜨게 하려면 여기서 넣어야 한다.

BEGIN;

INSERT INTO public.app_settings (key, value)
VALUES ('card_min_gap',       '48'::jsonb),
       ('card_push_strength', '100'::jsonb),
       ('card_push_speed_ms', '160'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
