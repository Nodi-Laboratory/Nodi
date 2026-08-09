"""진단용 표의 보존 정리 (2026-08-09).

`jobs`·`crosslink_runs`·`ai_logs`는 한 번 쓰고 다시 안 지우던 표다 — 실측
2026-08-09(개발 기계 나흘): crosslink_runs 2,748행 · jobs 2,808행. 교실 서른
명이 한 학기를 쓰면 자릿수가 달라진다.
"""

from __future__ import annotations

from app.services.worker import retention


class _Svc:
    """`prune_older_than`만 흉내 내는 대역. 무엇을 어떻게 불렀는지 기록한다."""

    def __init__(self, *, fail: set[str] | None = None) -> None:
        self.calls: list[tuple[str, int, int, tuple[str, ...] | None]] = []
        self._fail = fail or set()

    async def prune_older_than(
        self,
        table: str,
        days: int,
        *,
        limit: int = 2000,
        statuses: tuple[str, ...] | None = None,
    ) -> int:
        if table in self._fail:
            raise RuntimeError("DB가 삐끗했다")
        self.calls.append((table, days, limit, statuses))
        return 3


async def test_세_표를_모두_훑는다():
    svc = _Svc()
    out = await retention.sweep(svc)
    assert set(out) == set(retention.KEEP_DAYS)
    assert {c[0] for c in svc.calls} == set(retention.KEEP_DAYS)


async def test_잡은_끝난_것만_지운다():
    """큐에 남아 기다리는 일을 지우면 **그 파일은 영영 색인되지 않는다.**"""
    svc = _Svc()
    await retention.sweep(svc)
    by_table = {c[0]: c for c in svc.calls}
    assert by_table["jobs"][3] == retention.DONE_ONLY
    # 나머지는 상태를 안 가린다 — 전부 끝난 일의 기록이다.
    assert by_table["crosslink_runs"][3] is None
    assert by_table["ai_logs"][3] is None


async def test_회당_상한이_있다():
    """한 번에 수십만 행을 지우면 그동안 표가 잠긴다."""
    svc = _Svc()
    await retention.sweep(svc)
    assert all(c[2] == retention.BATCH for c in svc.calls)
    assert retention.BATCH <= 5000


async def test_한_표가_실패해도_나머지는_돈다():
    """보존은 **부수적인 일**이다 — 여기서 예외가 나가면 워커 폴이 죽고 파일
    색인·교차 연결이 함께 멈춘다."""
    svc = _Svc(fail={"jobs"})
    out = await retention.sweep(svc)
    assert out["jobs"] == -1
    assert out["ai_logs"] == 3


async def test_학습_데이터는_손대지_않는다():
    """세션·카드·노드는 학생의 것이라 시간으로 지우지 않는다."""
    금지 = {"sessions", "canvas_items", "nodes", "files", "item_links", "profiles"}
    assert not (set(retention.KEEP_DAYS) & 금지)


async def test_보존_기간이_관리자_화면보다_짧지_않다():
    """관리자 콘솔이 "왜 안 이어졌나"를 되짚는 창(D172)보다 짧으면, 보러
    들어갔을 때 이미 지워져 있다."""
    assert retention.KEEP_DAYS["crosslink_runs"] >= 30
    assert retention.KEEP_DAYS["ai_logs"] >= 30
