#!/usr/bin/env bash
# Nodi 배포 — 최신 main을 받아 빌드하고 서비스를 갈아 끼운다 (D116)
#
#   ~/app/Nodi/deploy/deploy.sh              # 평소 배포 (git pull 포함)
#   ~/app/Nodi/deploy/deploy.sh --skip-pull  # 지금 체크아웃된 코드로만
#
# GitHub Actions(self-hosted runner)가 main push마다 이걸 부른다. 사람이 손으로
# 쳐도 결과가 같아야 하므로 **멱등**하게 짰다 — 몇 번을 돌려도 안전하다.
#
# 순서:
#   1. git      origin/main으로 맞춘다 (--skip-pull이면 생략)
#   2. 백엔드   uv sync (uv.lock 고정)
#   3. 마이그레이션  db/migrations/*.sql 적용 — 전부 멱등하게 작성돼 있다
#   4. 프론트   npm ci + next build
#   5. 재시작   backend → frontend 순
#   6. 검증     /health가 200을 줄 때까지 기다린다. 안 오면 실패로 끝낸다

cd "$(dirname "$0")"
. ./config.sh

SKIP_PULL=0
[ "${1:-}" = "--skip-pull" ] && SKIP_PULL=1

started_at=$(date +%s)

# ---------------------------------------------------------------------------
# 1. 코드
#
# 이 서버에는 **git 자격증명이 없다.** 조직 정책으로 deploy key가 막혀 있어서
# (`Deploy keys are disabled for this repository`) VM이 직접 fetch하지 못한다.
# 대신 GitHub Actions의 self-hosted 러너가 체크아웃한 코드를 $REPO_DIR로
# 밀어 넣고 이 스크립트를 --skip-pull로 부른다. 서버에 토큰을 심지 않아도
# 되므로 오히려 이쪽이 낫다.
#
# 나중에 조직에서 deploy key를 허용하면 --skip-pull 없이 아래 경로가 살아난다.
# ---------------------------------------------------------------------------
if [ "$SKIP_PULL" -eq 1 ]; then
    log "git: 건너뜀 (코드는 이미 배달됨)"
elif git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    log "git: origin/main으로 맞춘다"
    git -C "$REPO_DIR" fetch --prune origin main \
        || die "fetch 실패 — 이 서버엔 자격증명이 없다. --skip-pull로 부를 것"
    # reset --hard 다 — 서버의 코드는 항상 main과 같아야 한다. 서버에서 직접
    # 고친 내용이 있으면 여기서 사라진다(그게 의도다. 수정은 저장소에서 한다).
    git -C "$REPO_DIR" reset --hard origin/main
else
    die "$REPO_DIR 가 git 저장소가 아니다 — --skip-pull로 부를 것"
fi

# 버전 표시는 있으면 좋고 없어도 그만이다(러너가 밀어 넣은 코드엔 .git이 없을
# 수 있다). 배포를 여기서 멈출 이유는 아니다.
rev=$(git -C "$REPO_DIR" log --oneline -1 2>/dev/null \
      || cat "$REPO_DIR/.deployed-rev" 2>/dev/null || echo "(리비전 미상)")
ok "$rev"

# backend/.env 링크는 매번 확인한다 — reset --hard로 지워질 수 있다.
[ -L "$REPO_DIR/backend/.env" ] || ln -sfn "$BACKEND_ENV" "$REPO_DIR/backend/.env"

# ---------------------------------------------------------------------------
# 2. 백엔드 의존성
# ---------------------------------------------------------------------------
log "백엔드 의존성 (uv sync --frozen)"
( cd "$REPO_DIR/backend" && uv sync --frozen --no-dev -q )
ok "완료"

# ---------------------------------------------------------------------------
# 3. 마이그레이션
#
# db/migrations/ 는 **데이터가 이미 든 DB**를 최신 스키마에 맞추는 스크립트다.
# 전부 멱등하게(IF NOT EXISTS / CREATE OR REPLACE) 작성하는 것이 규약이라
# 매 배포에 전부 적용해도 안전하다. 새로 만든 DB는 01_schema.sql에 이미
# 반영돼 있어서 아무 일도 일어나지 않는다.
# ---------------------------------------------------------------------------
log "마이그레이션"
applied=0
for f in "$REPO_DIR"/db/migrations/*.sql; do
    [ -e "$f" ] || continue
    psql -q -d nodi -v ON_ERROR_STOP=1 -f "$f" >/dev/null \
        || die "마이그레이션 실패: $(basename "$f") — 배포를 중단한다"
    applied=$((applied + 1))
done
ok "$applied건 적용"

# ---------------------------------------------------------------------------
# 3-1. 걷어낸 자동 파싱의 흔적 지우기 (2026-08-10 · 2026-08-12 개정)
#
# 대회 규정상 **제품 안에서 해외 모델을 쓸 수 없다.** EBS 자동 파싱과 Whisper
# 전사를 코드에서 걷어냈고, 디스크에 남은 faster-whisper 가중치는 코드가
# 사라져도 안 지워지므로 여기서 지운다. 멱등이고, 실패해도 배포를 막지 않는다
# — 청소가 서비스를 멈출 이유는 없다.
#
# ⚠️⚠️ **여기에 있던 Qdrant 컬렉션 삭제는 걷어냈다 (2026-08-12).**
#
#   for col in lecture_clips lecture_clip_atoms; do curl -X DELETE ... ; done
#
# 옛 벡터를 한 번 치우려고 넣은 줄인데, 이 스크립트는 **매 배포마다** 돈다.
# 관리자가 강의 JSON을 올려 임베딩까지 끝내도 **다음 배포가 벡터를 통째로
# 지웠다** — 행은 `embedded`로 남고 Qdrant만 비어서, 검색은 오류 없이 0건을
# 돌려준다. 화면에는 "영상 추천이 안 뜬다"로만 보인다(사용자 보고 2026-08-12).
# 같은 사고를 낸 짝이 `db/migrations/2026-08-10-drop-whisper-lectures.sql`이고
# 거기 자세히 적어 뒀다. 옛 벡터는 그날 이후 배포에서 이미 다 지워졌다.
#
# **일회성 청소를 배포 스크립트에 두면 일회성이 아니다.**
# ---------------------------------------------------------------------------
log "옛 전사 가중치 정리"
for d in "$HOME/.cache/huggingface/hub/models--Systran--faster-whisper-"* \
         "$HOME/.cache/huggingface/hub/models--guillaumekln--faster-whisper-"*; do
    [ -e "$d" ] || continue
    rm -rf "$d" && log "  whisper 가중치 삭제: $(basename "$d")"
done
ok "정리 완료"

# ---------------------------------------------------------------------------
# 4. 프론트엔드 빌드
#
# ⚠️ NEXT_PUBLIC_* 와 BACKEND_ORIGIN은 **빌드 시점에 박힌다.** 값을 바꿨다면
# 재시작이 아니라 이 빌드를 다시 돌려야 반영된다. 값은 config.sh가 export한다.
# ---------------------------------------------------------------------------
# 빈 값으로 빌드되면 브라우저가 /api 없이 요청해 로그인이 죽는다. 서버 API는
# 멀쩡해서 헬스체크·curl로는 안 잡히므로, 빌드 전에 여기서 끊는다.
[ -n "${NEXT_PUBLIC_API_BASE_URL:-}" ] \
    || die "NEXT_PUBLIC_API_BASE_URL이 비었다 — 이대로 빌드하면 로그인이 깨진다"

log "프론트엔드 빌드 (API_BASE=$NEXT_PUBLIC_API_BASE_URL)"
( cd "$REPO_DIR/frontend" && npm ci --silent && npm run build >/dev/null )
ok "완료"

# ---------------------------------------------------------------------------
# 5. 재시작
# ---------------------------------------------------------------------------
log "서비스 재시작"
$SUPERVISORCTL start nodi:postgres nodi:qdrant >/dev/null 2>&1 || true
$SUPERVISORCTL restart nodi:backend nodi:frontend >/dev/null
ok "backend · frontend 재시작됨"

# ---------------------------------------------------------------------------
# 6. 검증 — 여기서 실패하면 배포 실패다. 조용히 넘어가지 않는다.
# ---------------------------------------------------------------------------
log "기동 확인"
for i in $(seq 60); do
    curl -fsS "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 && break
    sleep 2
done
curl -fsS "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null \
    || die "백엔드가 응답하지 않는다 — tail -50 $LOG_DIR/backend.err.log"
ok "backend /health"

for i in $(seq 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/login" && break
    sleep 2
done
curl -fsS -o /dev/null "http://127.0.0.1:$FRONTEND_PORT/login" \
    || die "프론트가 응답하지 않는다 — tail -50 $LOG_DIR/frontend.err.log"
ok "frontend /login"

# 설정이 실제로 채워졌는지. ready=false면 채팅이 안 되므로 경고로 남긴다.
ready=$(curl -fsS "http://127.0.0.1:$BACKEND_PORT/health/config" \
        | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("ready"), d.get("blocking"))' 2>/dev/null || echo "?")
case "$ready" in
    True*) ok "설정 점검 ready=true" ;;
    *)     warn "설정 미완: $ready — $BACKEND_ENV 확인" ;;
esac

# `|| true`가 필요하다. supervisorctl status는 RUNNING이 아닌 프로그램이 하나라도
# 있으면 exit 3을 준다 — cloudflared는 토큰을 넣기 전까지 일부러 STOPPED이므로
# 정상 상태에서도 3이 나온다. set -e가 여기서 스크립트를 끊어 배포가 전부
# 성공했는데도 실패로 보고됐다(실측: Actions run 30433823688).
$SUPERVISORCTL status || true
log "배포 완료 ($(( $(date +%s) - started_at ))초)"
