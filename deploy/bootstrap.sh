#!/usr/bin/env bash
# 새 인스턴스에서 Nodi를 처음부터 세운다 (D116)
#
#   ~/app/Nodi/deploy/bootstrap.sh
#
# **몇 번을 돌려도 안전하다**(멱등). 이미 있는 건 건너뛰고 없는 것만 만든다.
# 워크로드가 재생성돼 ~/app이 통째로 날아갔을 때 이 스크립트 하나로 돌아온다
# — ~/data(NFS PVC)만 살아 있으면 데이터도 그대로다.
#
# 하는 일:
#   1. 런타임 설치      Postgres 17 · Node · uv · Qdrant · cloudflared
#   2. 디렉터리 생성    영속(~/data/nodi) · 휘발(~/app)
#   3. DB 클러스터      없으면 initdb → 스키마(db/0*.sql) 적용
#   4. 비밀값 연결      ~/data/nodi/env/backend.env → backend/.env 심볼릭 링크
#   5. supervisor       설정 생성 후 기동
#   6. 배포             deploy.sh 호출 (빌드 → 서비스 기동)

cd "$(dirname "$0")"
. ./config.sh

log "Nodi bootstrap — 데이터=$NODI_DATA  앱=$NODI_APP"

# ---------------------------------------------------------------------------
# 1. 디렉터리
# ---------------------------------------------------------------------------
log "디렉터리"
mkdir -p "$PGDATA" "$QDRANT_STORAGE" "$NODI_STORAGE" "$NODI_BACKUPS" \
         "$NODI_ENV_DIR" "$BIN_DIR" "$LOG_DIR" "$RUN_DIR"
chmod 700 "$PGDATA" "$NODI_ENV_DIR"
ok "준비됨"

# ---------------------------------------------------------------------------
# 2. 런타임 — 전부 "없으면 설치"
# ---------------------------------------------------------------------------
log "Postgres $PG_VERSION"
if [ ! -x "$PG_BIN/postgres" ]; then
    # Ubuntu 22.04는 PG14까지만 들어 있어서 PGDG 저장소가 필요하다.
    curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | sudo -n gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
    . /etc/os-release
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" \
        | sudo -n tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    sudo -n apt-get update -qq
    sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        "postgresql-$PG_VERSION" "postgresql-client-$PG_VERSION"
    # systemd가 없어 패키지의 기본 클러스터는 기동에 실패한다 — 정상이다.
    # 우리는 아래에서 우리 클러스터를 직접 만든다.
fi
ok "$("$PG_BIN/postgres" --version)"

log "Node $NODE_VERSION"
if [ ! -x "$NODE_BIN/node" ]; then
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/node.tar.xz" \
        "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
    tar xf "$tmp/node.tar.xz" -C "$tmp"
    rm -rf "$BIN_DIR/node-v${NODE_VERSION%%.*}"
    mv "$tmp/node-v$NODE_VERSION-linux-x64" "$BIN_DIR/node-v${NODE_VERSION%%.*}"
    rm -rf "$tmp"
fi
ok "node $(node --version) · npm $(npm --version)"

log "uv"
[ -x "$UV_BIN/uv" ] || curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null
ok "$(uv --version)"

log "Qdrant $QDRANT_VERSION"
if [ ! -x "$BIN_DIR/qdrant" ]; then
    # musl 정적 빌드를 쓴다. 이 VM의 glibc 2.35가 공식 gnu 빌드가 요구하는
    # 2.38보다 낮아 gnu 빌드는 `GLIBC_2.38 not found`로 실행조차 안 된다.
    curl -fsSL -o "$BIN_DIR/q.tar.gz" \
        "https://github.com/qdrant/qdrant/releases/download/v$QDRANT_VERSION/qdrant-x86_64-unknown-linux-musl.tar.gz"
    tar xf "$BIN_DIR/q.tar.gz" -C "$BIN_DIR" && rm "$BIN_DIR/q.tar.gz"
fi
ok "$("$BIN_DIR/qdrant" --version)"

log "cloudflared"
if [ ! -x "$BIN_DIR/cloudflared" ]; then
    curl -fsSL -o "$BIN_DIR/cloudflared" \
        https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
    chmod +x "$BIN_DIR/cloudflared"
fi
ok "$("$BIN_DIR/cloudflared" --version)"

# ---------------------------------------------------------------------------
# 3. DB 클러스터 — 없을 때만. 있으면 절대 건드리지 않는다
# ---------------------------------------------------------------------------
if [ -f "$PGDATA/PG_VERSION" ]; then
    log "Postgres 클러스터: 이미 있음 — 손대지 않는다"
else
    log "Postgres 클러스터 생성 (NFS 위)"
    # local은 trust, host는 scram. 어차피 127.0.0.1에만 바인딩한다.
    "$PG_BIN/initdb" -D "$PGDATA" -U postgres \
        --auth-local=trust --auth-host=scram-sha-256 -E UTF8 >/dev/null
    ok "initdb 완료"
fi

# ---------------------------------------------------------------------------
# 4. 비밀값 — 영속 볼륨에 두고 앱에는 링크로 보여 준다
# ---------------------------------------------------------------------------
log "환경 변수"
if [ ! -f "$BACKEND_ENV" ]; then
    cat > "$BACKEND_ENV" <<EOF
# Nodi 백엔드 운영 환경 변수 — **이 파일이 정본이다** (git 밖, 영속 볼륨).
# repo의 backend/.env 는 이 파일을 가리키는 심볼릭 링크다.
#
# UPSTAGE_API_KEY 를 채우지 않으면 채팅이 동작하지 않는다.
# JWT_SECRET·DB 비밀번호는 bootstrap이 난수로 생성했다 — 바꾸지 말 것.

DATABASE_URL=postgresql://nodi_app:__APP_PW__@127.0.0.1:$PG_PORT/nodi
DATABASE_WORKER_URL=postgresql://nodi_worker:__WORKER_PW__@127.0.0.1:$PG_PORT/nodi
JWT_SECRET=__JWT__
QDRANT_URL=http://127.0.0.1:$QDRANT_PORT
STORAGE_ROOT=$NODI_STORAGE
ENVIRONMENT=production

UPSTAGE_API_KEY=

# 교과서 도판 비전 판정. 비우면 라벨 없는 도판만 처리되지 않는다(업로드는 됨).
JUDGE_API_KEY=
JUDGE_BASE_URL=
EOF
    # 개발 기본값(nodi_app_dev 등)을 운영에 그대로 쓰지 않는다.
    for k in __APP_PW__ __WORKER_PW__ __JWT__; do
        sed -i "s|$k|$(openssl rand -hex 24)|" "$BACKEND_ENV"
    done
    chmod 600 "$BACKEND_ENV"
    ok "backend.env 생성 — 비밀값은 난수로 채웠다"
    warn "UPSTAGE_API_KEY가 비어 있다: $BACKEND_ENV 를 채운 뒤 다시 배포할 것"
else
    ok "backend.env 이미 있음 — 덮어쓰지 않는다"
fi

[ -f "$CLOUDFLARED_ENV" ] || {
    echo "# Cloudflare Tunnel 토큰. 대시보드에서 만든 값을 붙인다." > "$CLOUDFLARED_ENV"
    echo "CF_TUNNEL_TOKEN=" >> "$CLOUDFLARED_ENV"
    chmod 600 "$CLOUDFLARED_ENV"
}

# repo의 backend/.env 는 링크. 코드가 날아가도 비밀값은 영속 볼륨에 남는다.
ln -sfn "$BACKEND_ENV" "$REPO_DIR/backend/.env"
ok "backend/.env → $BACKEND_ENV"

# ---------------------------------------------------------------------------
# 5. supervisor 설정 생성 + 기동
# ---------------------------------------------------------------------------
log "supervisor 설정"
sed -e "s|__RUN_DIR__|$RUN_DIR|g"                 -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__BIN_DIR__|$BIN_DIR|g"                 -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g"               -e "s|__PG_BIN__|$PG_BIN|g" \
    -e "s|__PGDATA__|$PGDATA|g"                   -e "s|__PG_PORT__|$PG_PORT|g" \
    -e "s|__NODI_DATA__|$NODI_DATA|g"             -e "s|__QDRANT_STORAGE__|$QDRANT_STORAGE|g" \
    -e "s|__QDRANT_PORT__|$QDRANT_PORT|g"         -e "s|__BACKEND_PORT__|$BACKEND_PORT|g" \
    -e "s|__FRONTEND_PORT__|$FRONTEND_PORT|g"     -e "s|__CLOUDFLARED_ENV__|$CLOUDFLARED_ENV|g" \
    "$REPO_DIR/deploy/supervisord.conf.tpl" > "$SUPERVISOR_CONF"
ok "$SUPERVISOR_CONF"

if [ -S "$RUN_DIR/supervisor.sock" ] && $SUPERVISORCTL pid >/dev/null 2>&1; then
    log "supervisord 실행 중 — 설정만 다시 읽는다"
    $SUPERVISORCTL reread >/dev/null && $SUPERVISORCTL update >/dev/null
else
    log "supervisord 기동"
    command -v supervisord >/dev/null || sudo -n apt-get install -y -qq supervisor
    supervisord -c "$SUPERVISOR_CONF"
    sleep 3
fi
ok "supervisor 준비됨"

# ---------------------------------------------------------------------------
# 6. DB 초기 스키마 — DB가 없을 때만
# ---------------------------------------------------------------------------
log "Postgres 기동 대기"
$SUPERVISORCTL start nodi:postgres >/dev/null 2>&1 || true
for i in $(seq 30); do
    "$PG_BIN/pg_isready" -q && break
    sleep 1
done
"$PG_BIN/pg_isready" -q || die "Postgres가 뜨지 않았다 — $LOG_DIR/postgres.err.log 확인"
ok "Postgres 응답"

if psql -lqt | cut -d'|' -f1 | grep -qw nodi; then
    ok "nodi DB 이미 있음 — 스키마를 다시 적용하지 않는다"
else
    log "nodi DB 생성 + 스키마 적용"
    createdb nodi
    for f in "$REPO_DIR"/db/0*.sql; do
        psql -q -d nodi -v ON_ERROR_STOP=1 -f "$f" >/dev/null \
            || die "스키마 적용 실패: $(basename "$f")"
        ok "$(basename "$f")"
    done
    # 역할 비밀번호를 backend.env의 난수와 맞춘다(개발 기본값 제거).
    app_pw=$(grep -oP '(?<=nodi_app:)[^@]+' "$BACKEND_ENV" | head -1)
    wrk_pw=$(grep -oP '(?<=nodi_worker:)[^@]+' "$BACKEND_ENV" | head -1)
    psql -q -d nodi -c "alter role nodi_app password '$app_pw';" \
                    -c "alter role nodi_worker password '$wrk_pw';"
    ok "DB 역할 비밀번호를 운영 값으로 교체"
fi

# ---------------------------------------------------------------------------
# 7. 나머지는 deploy.sh가 한다 (빌드 → 서비스 기동 → 검증)
# ---------------------------------------------------------------------------
log "배포로 넘긴다"
exec "$REPO_DIR/deploy/deploy.sh" --skip-pull
