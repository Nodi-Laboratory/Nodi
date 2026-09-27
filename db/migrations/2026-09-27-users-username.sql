-- 아이디 로그인 (공개판, 2026-09-27)
--
-- 이메일 외에 **아이디**로도 로그인할 수 있게 한다. 데모 계정(`demo`)처럼
-- 이메일이 어울리지 않는 계정을 위해서다. 기존 계정은 아이디가 없어도 된다
-- (NULL 허용 — 이메일 로그인은 그대로).
--
-- citext라 대소문자를 가리지 않는다. 형식(영문 소문자·숫자·_·-, 3~32자)은
-- 가입 경로(me.py SignupBody)가 검증한다. `@`가 들어갈 수 없어서 로그인 창구가
-- "`@`가 있으면 이메일, 없으면 아이디"로 가를 수 있다.
--
-- 멱등이다 — 여러 번 돌려도 같다.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username citext;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON public.users (username);
