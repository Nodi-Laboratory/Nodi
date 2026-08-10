"""진단용 표의 보존 기간 (2026-08-09).

## 왜 필요한가

`jobs`·`crosslink_runs`·`ai_logs` 셋은 **한 번 쓰고 다시 안 지우는** 표다.
지운 적이 없으므로 계정 하나가 쓸수록, 학기가 갈수록 계속 자란다 — 실측
2026-08-09(개발 기계 나흘): `crosslink_runs` 2,748행 · `jobs` 2,808행. 교실
서른 명이 한 학기를 쓰면 자릿수가 달라진다.

자라면 세 가지가 같이 나빠진다:
  · 관리자 콘솔의 목록·집계가 매번 더 많은 행을 훑는다
  · 백업(D193)이 통째로 커진다
  · 디스크

## 무엇을 남기나

이 셋은 **끝난 일의 기록**이다. 되짚어 볼 값이 있는 기간만 남긴다:

  jobs            done/failed만, 14일  — 돌고 있는 일(queued/running)은 절대 안 지운다
  crosslink_runs  30일                  — "왜 안 이어졌나"를 관리자가 본다(D172)
  ai_logs         30일                  — 턴 로그(D112·D113)

**멱등이고 조금씩 지운다.** 한 번에 수십만 행을 지우면 그동안 표가 잠긴다 —
회당 상한을 두고 다음 폴에서 마저 한다.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("nodi.worker.retention")

#: 표별 보존 일수. 값을 바꿀 때는 관리자 콘솔이 그만큼 못 본다는 뜻임을 기억한다.
KEEP_DAYS: dict[str, int] = {
    "jobs": 14,
    "crosslink_runs": 30,
    "ai_logs": 30,
}

#: 한 번에 지울 최대 행수(표당). 표를 오래 잡고 있지 않기 위한 값이다.
BATCH = 2000

#: 한 표를 몇 번까지 이어서 지울까 (2026-08-10).
#:
#: ⚠️ 예전에는 표마다 **한 번**만 지웠다. 그러면 하루에 2,000행 넘게 쌓이는
#: 순간부터 정리가 영영 못 따라잡고 표는 **조용히** 계속 는다 — 아무도 오류를
#: 보지 않으므로 몇 달 뒤 디스크로 알게 된다. 개발 기계도 이미 하루 1,000행
#: 언저리였다(2026-08-10: crosslink_runs 5,136행). 학급 여럿이 도는 학교라면
#: 쉽게 넘는다.
#:
#: 밀린 것을 한 번에 다 지우지도 않는다 — 2,000행씩 끊어 스무 번이면 하루
#: 40,000행이고, 그 사이사이 다른 일이 표를 쓸 틈이 생긴다.
MAX_PASSES = 20

#: 하루 한 번이면 충분하다 — 폴은 몇 초마다 돌지만 이 일은 그 리듬이 아니다.
INTERVAL_SECONDS = 24 * 60 * 60

#: 워커가 뜨고 **처음** 도는 시각까지의 유예.
#:
#: `interval` 트리거는 첫 실행이 한 주기 뒤라, 배포가 하루보다 잦으면 이 일이
#: 한 번도 안 돈다. 부팅 직후는 가장 바쁜 때(풀·인덱스 예열)라 조금 미룬다.
FIRST_RUN_DELAY_SECONDS = 5 * 60


#: `jobs`는 **끝난 것만** 지운다 — 큐에 남아 기다리는 일을 지우면 그 파일은
#: 영영 색인되지 않는다.
DONE_ONLY = ("done", "failed")


async def sweep(svc: Any) -> dict[str, int]:
    """한 바퀴 돌며 오래된 행을 지운다. 실패는 삼킨다.

    보존은 **부수적인 일**이다 — 여기서 예외가 나가면 워커 폴이 죽고 파일
    색인·교차 연결이 함께 멈춘다. 그건 훨씬 나쁘다.
    """
    out: dict[str, int] = {}
    for table, days in KEEP_DAYS.items():
        try:
            지운수 = 0
            # 한 번에 딱 BATCH만 지우면 하루 유입이 그보다 많은 순간부터 영영
            # 못 따라잡는다. **밀린 만큼** 이어서 지우되 상한을 둔다.
            for _ in range(MAX_PASSES):
                n = await svc.prune_older_than(
                    table,
                    days,
                    limit=BATCH,
                    statuses=DONE_ONLY if table == "jobs" else None,
                )
                지운수 += n
                # 한 배치를 다 못 채웠으면 지울 것이 떨어진 것이다.
                if n < BATCH:
                    break
            else:
                # 상한까지 갔다 = 아직 남았다. 다음 바퀴가 이어 받지만, 유입이
                # 계속 이만큼이면 사람이 알아야 한다.
                logger.warning(
                    "보존 정리가 상한(%d회 × %d행)까지 찼다: %s — 유입이 정리보다 빠르다",
                    MAX_PASSES, BATCH, table,
                )
            out[table] = 지운수
        except Exception:  # noqa: BLE001 - 보존이 워커를 멈추게 하지 않는다
            logger.warning("보존 정리 실패: %s", table, exc_info=True)
            out[table] = -1
    kept = {k: v for k, v in out.items() if v}
    if kept:
        logger.info("보존 정리: %s", kept)
    return out
