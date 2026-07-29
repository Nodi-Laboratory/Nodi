#!/usr/bin/env bash
# 매일 정해진 시각에 데이터 스냅샷을 만든다 (D119)
#
# supervisor가 [program:backup]으로 돌린다. 직접 칠 일은 없다 — 지금 당장
# 하나 만들고 싶으면 CLI를 부르면 된다:
#
#   cd ~/app/Nodi/backend && ./.venv/bin/python -m app.cli backup
#
# ## 왜 cron이 아닌가
#
# 이 VM에는 cron이 설치돼 있지 않고(systemd도 없다), 설치해 봐야 워크로드
# 재생성 때 사라진다. 이미 supervisor가 모든 프로세스를 관리하므로 스케줄러도
# 거기 얹는 편이 관리 지점이 하나로 유지된다 — `nodictl status`에 같이 뜨고,
# 로그도 ~/app/log 아래 같은 자리에 쌓인다.
#
# ## 백업이 무엇을 담는가
#
# 대화·문서 메타·계정·설정. **학생 대화 원문이 들어 있다** — 이 파일을 밖으로
# 옮기면 그 내용도 함께 나간다. 원본 파일 바이트와 Qdrant 벡터는 담기지 않아
# documents는 복원되지 않는다(기록용). 자세한 건
# backend/app/services/admin_backup.py 모듈 docstring.

cd "$(dirname "$0")"
. ./config.sh

HOUR="${BACKUP_HOUR:-3}"     # 로컬 시각(KST) 기준 정각. 수업 없는 시간대.
KEEP="${BACKUP_KEEP:-14}"    # 하루 1회 × 14 = 2주치

PY="$REPO_DIR/backend/.venv/bin/python"

log "백업 스케줄러 — 매일 ${HOUR}시, 최신 ${KEEP}개 유지 (TZ=$(date +%Z))"

while true; do
    now=$(date +%s)
    next=$(date -d "today $HOUR:00:00" +%s)
    [ "$next" -le "$now" ] && next=$(date -d "tomorrow $HOUR:00:00" +%s)
    wait_for=$((next - now))
    log "다음 백업: $(date -d "@$next" '+%F %T %Z') ($((wait_for / 60))분 후)"
    sleep "$wait_for"

    # 실패해도 루프를 끝내지 않는다. 여기서 죽으면 supervisor가 재시작하고
    # 다시 최대 24시간을 자므로, 하루치 백업이 통째로 날아간다.
    # `-m app.cli`는 backend/를 cwd로 해야 패키지를 찾는다.
    if (cd "$REPO_DIR/backend" && "$PY" -m app.cli backup --keep "$KEEP"); then
        ok "백업 완료"
    else
        warn "백업 실패 — 24시간 뒤 다시 시도한다"
    fi
done
