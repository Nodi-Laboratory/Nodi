-- 거리 게이트 7개를 "임베딩 제공자의 기본값을 따른다"(null)로 — 시드 기본값 그대로인 행만
--
-- ## 왜 필요한가
--
-- 거리 게이트는 임베딩 모델의 거리 분포에 묶여 있다(Upstage 0.60 ↔ Gemini 0.36 …
-- config.GEMINI_GATE_DEFAULTS의 실측표). 그런데 튜너블은 **admin 오버레이 행이
-- config 기본값을 이긴다**(D62). 옛 `03_app_settings.sql`이 Upstage 숫자를 행으로
-- 박아 둔 DB를 EMBEDDING_PROVIDER=gemini로 돌리면, 코드 기본값이 제공자에 맞아도
-- **행이 Upstage 게이트(0.60)를 계속 강제해** 인사말·무관 질의까지 전부 통과한다.
--
-- 새 DB는 03_app_settings.sql이 이미 `null`을 깐다. 이 파일은 **이미 돌고 있는
-- DB**의 행을 같은 상태로 맞춘다. null = 런타임이 config 기본값을 쓴다
-- (`app_settings.as_float`는 null이면 기본값, 콘솔은 유효 기본값을 보여 준다).
--
-- ## Upstage 서버의 동작은 안 바뀐다
--
-- Upstage일 때 config 기본값이 정확히 이 행들의 옛 값(0.60/0.45/0.42/0.66)이다.
-- 값이 null이 되어도 게이트는 같다.
--
-- ## 멱등이다 — 그리고 관리자가 손으로 고친 값은 건드리지 않는다
--
-- WHERE가 "시드 기본값 그대로인 행"만 고른다(d182 마이그레이션과 같은 규약).
-- 한 번 null이 되면 조건에 안 맞아 다시 돌아도 변화가 없다. 튜닝해 둔 값(0.65 등)은
-- 그대로 남는다. 조건 없는 UPDATE/DELETE가 아니다(test_migrations_safety).

BEGIN;

UPDATE public.app_settings SET value = 'null'::jsonb
 WHERE key IN ('class_material_rag_max_distance', 'figure_retrieve_max_distance',
               'lecture_retrieve_max_distance')
   AND value = '0.60'::jsonb;

UPDATE public.app_settings SET value = 'null'::jsonb
 WHERE key IN ('lecture_atom_max_distance', 'atom_rag_max_distance')
   AND value = '0.45'::jsonb;

UPDATE public.app_settings SET value = 'null'::jsonb
 WHERE key = 'crosslink_min_distance'
   AND value = '0.42'::jsonb;

UPDATE public.app_settings SET value = 'null'::jsonb
 WHERE key = 'crosslink_max_distance'
   AND value = '0.66'::jsonb;

COMMIT;
