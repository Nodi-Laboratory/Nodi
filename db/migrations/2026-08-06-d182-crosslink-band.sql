-- D182 배지의 거리 띠 재측정 + 판정 모델 분리
--
-- ## 왜 값만 바꾸는 마이그레이션이 필요한가
--
-- 튜너블은 **admin 오버레이가 config 기본값을 이긴다**(D62). `03_app_settings.sql`은
-- 빈 볼륨일 때 한 번만 돌므로, 이미 돌고 있는 DB에는 옛 값(0.45/0.72)이 그대로
-- 남는다 — 코드 기본값을 고쳐도 **아무 일도 일어나지 않는다.**
--
-- ## 왜 이 값인가
--
-- 실물 embedding-passage로 세 갈래를 재 봤다 (2026-08-06):
--
--     중복(같은 주제를 다르게 쓴 것)  0.223 ~ 0.347
--     연결(주제는 다른데 이어지는 것)  0.500 ~ 0.618   ← 배지가 떠야 하는 구간
--     남남(아무 상관 없는 것)          0.693 ~ 0.765
--
-- 옛 천장 0.72는 남남을 통과시켰다("광합성 ↔ 시의 운율" 0.693,
-- "판 구조론 ↔ 현재완료" 0.719). 새 값은 구간 사이 빈 곳의 가운데다.
--
-- ## 멱등이다
--
-- **관리자가 손으로 고친 값은 건드리지 않는다** — 옛 기본값 그대로인 행만
-- 옮긴다. 튜닝해 둔 것을 마이그레이션이 되돌리면 그건 사고다.

BEGIN;

UPDATE public.app_settings
   SET value = '0.42'
 WHERE key = 'crosslink_min_distance'
   AND value = '0.45';

UPDATE public.app_settings
   SET value = '0.66'
 WHERE key = 'crosslink_max_distance'
   AND value = '0.72';

-- ⚠️ `value`는 **jsonb**다. 문자열 값은 JSON 문자열이어야 한다 —
-- 'solar-pro2'로 쓰면 `invalid input syntax for type json`으로 배포가 멎는다
-- (실측 2026-08-06). 지금까지 노브가 전부 숫자·불리언이라 처음 드러났다.
INSERT INTO public.app_settings (key, value)
VALUES ('crosslink_model', '"solar-pro2"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
