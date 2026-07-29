#!/usr/bin/env bash
# 배포 스크립트 공용 설정 (D116)
#
# bootstrap.sh · deploy.sh가 이 파일을 source한다. **경로를 바꿀 일이 있으면
# 여기 한 곳만 고친다.**
#
# 설계 원칙 하나만 기억하면 된다:
#
#   NODI_DATA(~/data/nodi)  = 영속. NFS PVC 위. 지우면 복구 못 함.
#   NODI_APP (~/app)        = 휘발. 언제 날아가도 bootstrap.sh로 5분이면 복구.
#
# 이 서버(TTA GPU 클라우드)는 오버레이 파일시스템이 워크로드 재생성 때
# 사라진다. 실제로 한 번 사라졌다 — 예전 배포본 ~/Nodi가 통째로 없어졌고
# 그때 DB도 같이 날아갔다. 그래서 **상태는 전부 NODI_DATA 아래**에 둔다.

set -euo pipefail

NODI_HOME="${NODI_HOME:-$HOME}"

# --- 영속 (NFS PVC 33T). 이 아래만 지키면 데이터는 안 잃는다 ---------------
NODI_DATA="${NODI_DATA:-$NODI_HOME/data/nodi}"
PGDATA="$NODI_DATA/pg"                    # Postgres 데이터 디렉터리
QDRANT_STORAGE="$NODI_DATA/qdrant/storage"
NODI_STORAGE="$NODI_DATA/storage"         # 업로드 원본 (STORAGE_ROOT)
NODI_BACKUPS="$NODI_DATA/backups"         # D114 백업 JSON
NODI_ENV_DIR="$NODI_DATA/env"             # 비밀값. git에 절대 안 들어간다
BACKEND_ENV="$NODI_ENV_DIR/backend.env"
CLOUDFLARED_ENV="$NODI_ENV_DIR/cloudflared.env"

# --- 휘발 (오버레이). 날아가도 되는 것만 ------------------------------------
NODI_APP="${NODI_APP:-$NODI_HOME/app}"
REPO_DIR="$NODI_APP/Nodi"                 # git clone 위치 (배포 정본)
BIN_DIR="$NODI_APP/bin"                   # qdrant · cloudflared · node
LOG_DIR="$NODI_APP/log"
RUN_DIR="$NODI_APP/run"
SUPERVISOR_CONF="$NODI_APP/supervisord.conf"

# --- 포트 -------------------------------------------------------------------
# 전부 127.0.0.1에만 바인딩한다. 외부 노출은 Cloudflare Tunnel이 담당하므로
# 인바운드로 열어야 할 포트가 하나도 없다.
PG_PORT="${PG_PORT:-5433}"
QDRANT_PORT="${QDRANT_PORT:-6333}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

# --- 런타임 버전 ------------------------------------------------------------
NODE_VERSION="${NODE_VERSION:-22.20.0}"
QDRANT_VERSION="${QDRANT_VERSION:-1.18.3}"
PG_VERSION="${PG_VERSION:-17}"
PG_BIN="/usr/lib/postgresql/$PG_VERSION/bin"

# --- PATH -------------------------------------------------------------------
NODE_BIN="$BIN_DIR/node-v${NODE_VERSION%%.*}/bin"
UV_BIN="$NODI_HOME/.local/bin"
export PATH="$NODE_BIN:$UV_BIN:$PG_BIN:$PATH"

# psql·pg_ctl이 매번 -h -p -U 를 받지 않아도 되게
export PGHOST=/tmp
export PGPORT="$PG_PORT"
export PGUSER=postgres

SUPERVISORCTL="supervisorctl -c $SUPERVISOR_CONF"

# 로그를 사람이 읽는 순서대로: 무엇을 하는지 → 결과
log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✘\033[0m %s\n' "$*" >&2; exit 1; }
