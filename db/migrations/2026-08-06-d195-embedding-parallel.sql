-- D195 임베딩 팬아웃 재편 — 잡은 굵게, 요청은 잘게 동시에
--
-- ## 왜 마이그레이션이 필요한가
--
-- 튜너블은 **admin 오버레이가 config 기본값을 이긴다**(D62). `03_app_settings.sql`은
-- 빈 볼륨일 때 한 번만 돌므로, 이미 돌고 있는 DB에는 옛 값이 그대로 남는다 —
-- 코드 기본값만 고치면 배포 서버에서는 아무 일도 일어나지 않는다.
--
-- ## 무엇이 바뀌었나
--
-- 예전에는 잡 하나 = 임베딩 요청 하나였다(64청크). 파일을 빨리 끝내는 방법이
-- "잡을 잘게 나누기"뿐이었는데, 잡은 폴 주기(5초)와 워커 동시성(3)에 묶여 있다 —
-- 청크 5,000개짜리 교과서면 79잡 = 최소 27폴 = 큐에서만 135초다.
--
-- 이제 잡 하나가 자기 청크를 100개(Upstage 요청 상한) 단위로 쪼개
-- `embedding_request_concurrency`개씩 **동시에** 보낸다. 그래서 잡은 굵어지고
-- (300 = 요청 3건) 요청은 잘게 병렬로 나간다. 같은 교과서가 17잡 = 6폴이 된다.
--
-- 동시 요청 수 = 워커 동시성(3) × embedding_request_concurrency(4) = 최대 12.
-- Upstage 429가 잦으면 concurrency를 낮춘다(잡 크기는 그대로 둬도 된다).
--
-- ## 멱등이다
--
-- **관리자가 손으로 고친 값은 건드리지 않는다** — 옛 기본값(64) 그대로인 행만
-- 옮긴다. 행이 없으면 새로 넣는다(노브가 콘솔에 뜨려면 행이 있어야 한다).

BEGIN;

UPDATE public.app_settings
   SET value = '300'
 WHERE key = 'embedding_batch_size'
   AND value = '64';

INSERT INTO public.app_settings (key, value)
VALUES ('embedding_batch_size', '300'::jsonb),
       ('embedding_request_concurrency', '4'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 세션 파일 예산의 **상한**을 컨텍스트 윈도에 묶는다(D195).
-- solar-pro3 컨텍스트는 131,072토큰이고, 한국어 교과서 문어체는 2.31자/토큰이다
-- (2026-08-06 usage.prompt_tokens 실측: 구어체 3.10 · 영어 3.98 — 문어체가 최악).
-- 옛 clamp 300,000자는 최악 입력에서 130K 토큰 ≈ 윈도 전부라, 노브를 끝까지
-- 올리면 파일만으로 컨텍스트가 찼다. 기본값 150,000자(≈65K 토큰, 윈도의 절반)는
-- 그대로 두고 상한만 180,000으로 내린다.
UPDATE public.app_settings
   SET value = '180000'
 WHERE key = 'session_context_max_chars'
   AND (value)::numeric > 180000;

COMMIT;
