-- D194 질문 방향성 코치 — 노브 세 개
--
-- ## 왜 이 파일이 필요한가
--
-- `03_app_settings.sql`은 **빈 볼륨일 때 한 번만** 돈다. 이미 돌고 있는 DB에는
-- 새 노브의 행이 없고, 행이 없으면 admin 콘솔이 `missing_row`로 띄운다 —
-- 화면에는 보이는데 **조정이 안 되는** 상태다(D62). 코드 기본값으로 동작은
-- 하므로 눈으로는 멀쩡해 보이는 것이 이 결함의 성질이다.
--
-- ## 값의 뜻
--
--   question_coach_enabled    코치를 켤지 (킬 스위치)
--   question_coach_min_cards  n — 한 줄기에 n장이 쌓인 뒤 하나 더 이어지면
--                             말을 건다. 재발동은 n+3장 뒤이고, 이 파생값은
--                             콘솔이 옆에 함께 보여 준다(사용자 지시 2026-08-06).
--   question_coach_model      방향 낱말 몇 개를 고르는 일이라 가벼운 모델로 충분하다.
--
-- ## 멱등이다
--
-- `ON CONFLICT DO NOTHING` — **관리자가 이미 조정해 둔 값을 되돌리지 않는다.**
-- 두 번 돌려 확인했다.
--
-- ⚠️ `value`는 **jsonb**다. 문자열은 JSON 문자열이어야 한다 — 'solar-pro2'로
-- 쓰면 `invalid input syntax for type json`으로 배포가 멎는다(D182 실측).

BEGIN;

INSERT INTO public.app_settings (key, value)
VALUES
    ('question_coach_enabled', 'true'::jsonb),
    ('question_coach_min_cards', '3'::jsonb),
    ('question_coach_model', '"solar-pro2"'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
