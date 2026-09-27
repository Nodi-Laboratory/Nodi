#!/bin/sh
# 백엔드 컨테이너 진입점 — 데모 계정 시드 후 uvicorn을 띄운다.
#
# 시드를 이미지 빌드가 아니라 **기동 시점**에 하는 이유: DB가 준비되고
# 마이그레이션이 끝난 뒤여야 한다(compose의 depends_on이 보장). --if-empty라
# 재기동마다 돌아도 사용자가 이미 있으면 아무것도 안 한다(멱등).
#
# **명시적으로 SEED_DEMO=true일 때만** 돈다(기본 끔). 알려진 비밀번호의 데모
# 계정(demo/demo1234)이 실수로 서버에 생기지 않게 옵트인으로 둔다 — 로컬 체험용
# `.env.example`이 true를 적어 두므로 `cp .env.example .env`만 하면 켜진다.
set -e

if [ "${SEED_DEMO:-false}" = "true" ]; then
    echo "[entrypoint] 데모 계정 시드 (SEED_DEMO=true)"
    # 시드 실패는 기동을 막는다. 조용히 넘어가면 "로그인이 안 된다"로만
    # 드러나서 원인(시드)을 찾기 어렵다.
    python -m app.cli seed-demo --if-empty
fi

# exec: uvicorn이 PID 1이 되어 docker stop의 SIGTERM을 직접 받는다
# (셸이 끼면 신호가 전달되지 않아 10초 뒤 SIGKILL로 죽고 lifespan 정리가 안 돈다).
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' "$@"
