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
# 백업 위치는 우리가 정하는 게 아니라 앱이 정한다 — admin_backup._dir()이
# `storage_root/backups`를 쓴다. 예전에 여기 $NODI_DATA/backups로 적혀 있었는데
# 그 폴더는 아무도 쓰지 않는 빈 디렉터리였다(실물은 storage/backups).
NODI_BACKUPS="$NODI_STORAGE/backups"      # D114 백업 JSON
NODI_ENV_DIR="$NODI_DATA/env"             # 비밀값. git에 절대 안 들어간다
BACKEND_ENV="$NODI_ENV_DIR/backend.env"
CLOUDFLARED_ENV="$NODI_ENV_DIR/cloudflared.env"
MODEL_ARCHIVE="$NODI_DATA/models"         # 판정 모델 가중치 아카이브 (D118)

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
JUDGE_PORT="${JUDGE_PORT:-8080}"

# --- 손글씨 OCR 모델 서버 (D176·D177) ---------------------------------------
# VARCO-VISION-2.0-1.7B-OCR. GPU 0은 llama.cpp가 쓰므로 GPU 1에 고정한다.
#
# **저장소 밖에 있다** — 가중치와 서버 코드가 이 기계에만 있고 우리는 띄우는
# 일만 맡는다. 그래서 디렉터리가 없는 인스턴스에서는 항목을 켜지 않는다.
OCR_DIR="${OCR_DIR:-$NODI_HOME/varco_ocr_server}"
OCR_PORT="${OCR_PORT:-8083}"
OCR_GPU="${OCR_GPU:-1}"

# --- 교과서 도판 비전 판정 (D118) -------------------------------------------
# 이 서버에는 A100 80GB가 두 장 있다. 도판 캡션 판정(figure_judge.py)은
# OpenAI 호환 비전 엔드포인트면 무엇이든 되는데, 외부 API를 쓸 이유가 없어
# llama.cpp로 EXAONE 4.5를 직접 띄운다.
#
# **모델은 휘발 파일시스템에 두고 아카이브는 영속 볼륨에 둔다.** 22GB를 NFS에서
# mmap하면 기동이 느려서 실행 경로는 오버레이($MODEL_DIR)를 쓰고, 워크로드가
# 재생성돼 사라지면 bootstrap이 $MODEL_ARCHIVE에서 복사해 되살린다.
# 아카이브가 없으면 재다운로드에 수십 분이 든다 — 그래서 복사본을 둔다.
LLAMA_BIN="${LLAMA_BIN:-$NODI_HOME/llama.cpp/build/bin}"
MODEL_DIR="${MODEL_DIR:-$NODI_HOME/models/exaone45}"
JUDGE_WEIGHTS="EXAONE-4.5-33B-Q4_K_M.gguf"
JUDGE_MMPROJ="mmproj-EXAONE-4.5-33B-BF16.gguf"   # 비전 투영 — 이게 없으면 텍스트 전용
# 키 파일은 가중치 옆이 아니라 비밀값 폴더에 둔다 — $MODEL_DIR은 휘발이라
# 워크로드 재생성 때 키만 새로 생기고 backend.env는 옛 키를 들고 있게 된다(401).
JUDGE_KEY_FILE="$NODI_ENV_DIR/judge_api_key.txt"
# --alias 값. 백엔드의 JUDGE_MODEL과 **반드시 같아야** 한다.
JUDGE_MODEL_ALIAS="${JUDGE_MODEL_ALIAS:-exaone-4.5-33b}"

# --- 프론트 빌드 값 ---------------------------------------------------------
# 둘 다 **빌드 시점에 번들·라우트 매니페스트에 박힌다.** 런타임 환경변수로는
# 안 바뀌므로 값을 고치면 반드시 다시 빌드해야 한다.
#
# NEXT_PUBLIC_API_BASE_URL을 빠뜨리면 `API_BASE`가 **빈 문자열**이 된다
# (_core.ts의 `?? ""`). 그러면 브라우저가 /api 없이 `/auth/login`을 쳐서
# 404가 나고 로그인이 통째로 죽는다 — 서버 API는 멀쩡하므로 curl 검증만으로는
# 절대 드러나지 않는다. 실제로 이걸로 한 번 당했다.
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-/api}"
# 백엔드는 같은 호스트의 127.0.0.1:8000이라 기본값이 맞다.
export BACKEND_ORIGIN="${BACKEND_ORIGIN:-http://127.0.0.1:$BACKEND_PORT}"

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
