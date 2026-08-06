"""교사 자료 목록의 **도판 진척** (D186).

고정하는 계약:
  1. 교과서 행에는 `figure_done`/`figure_total`이 붙는다 — 없으면 화면이
     텍스트 청크만 세고, 도판이 다 끝날 때까지 **0%에 붙어 있는다.**
  2. 학급 자료(class_material)에는 안 붙는다 — 도판 파이프라인이 없다.
  3. 왕복은 **한 번**이다. 파일마다 세면 N+1이다.
  4. 조회가 실패해도 목록은 나온다 — 진척 표시는 있으면 좋은 것이지 목록을
     막을 이유가 아니다(D88이 도판 실패를 텍스트 인덱싱과 격리한 것과 같다).
"""

from __future__ import annotations

from typing import Any

import pytest

from app.routers import teacher as T

aio = pytest.mark.asyncio

BOOK = "11111111-1111-4111-8111-111111111111"
BOOK2 = "22222222-2222-4222-8222-222222222222"
MATERIAL = "33333333-3333-4333-8333-333333333333"


class FakeClient:
    def __init__(self, figures: list[dict] | None = None, boom: bool = False):
        self.figures = figures or []
        self.boom = boom
        self.selects: list[tuple[str, dict]] = []

    async def select(self, table: str, params: dict) -> list[dict[str, Any]]:
        self.selects.append((table, params))
        if table == "textbook_figures":
            if self.boom:
                raise RuntimeError("DB 죽음")
            return self.figures
        return []


def _rows() -> list[dict[str, Any]]:
    return [
        {"id": BOOK, "kind": "textbook"},
        {"id": MATERIAL, "kind": "class_material"},
    ]


def _figs(file_id: str, **counts: int) -> list[dict]:
    out = []
    for status, n in counts.items():
        out += [{"file_id": file_id, "status": status}] * n
    return out


@aio
async def test_교과서에_도판_진척이_붙는다():
    c = FakeClient(_figs(BOOK, pending=5, embedded=3, failed=2))
    rows = _rows()
    await T._attach_figure_progress(c, rows)
    book = rows[0]
    assert book["figure_total"] == 10
    # 'pending'만 남은 일이다 — failed는 더 안 는다(D88).
    assert book["figure_done"] == 5


@aio
async def test_학급자료에는_안_붙는다():
    c = FakeClient(_figs(BOOK, embedded=1))
    rows = _rows()
    await T._attach_figure_progress(c, rows)
    assert "figure_total" not in rows[1]


@aio
async def test_왕복은_한_번이다():
    """파일마다 세면 N+1이다 — 교과서가 늘수록 목록이 느려진다."""
    c = FakeClient(_figs(BOOK, embedded=2) + _figs(BOOK2, pending=3))
    rows = [
        {"id": BOOK, "kind": "textbook"},
        {"id": BOOK2, "kind": "textbook"},
        {"id": MATERIAL, "kind": "class_material"},
    ]
    await T._attach_figure_progress(c, rows)
    assert len(c.selects) == 1
    _, params = c.selects[0]
    assert BOOK in params["file_id"] and BOOK2 in params["file_id"]
    assert rows[0]["figure_done"] == 2
    assert rows[1]["figure_done"] == 0 and rows[1]["figure_total"] == 3


@aio
async def test_교과서가_없으면_묻지도_않는다():
    c = FakeClient()
    await T._attach_figure_progress(c, [{"id": MATERIAL, "kind": "class_material"}])
    assert c.selects == []


@aio
async def test_조회가_실패해도_목록은_나온다():
    c = FakeClient(boom=True)
    rows = _rows()
    await T._attach_figure_progress(c, rows)  # raise하지 않는다
    assert "figure_total" not in rows[0]


@aio
async def test_남의_파일_도판은_세지_않는다():
    """RLS가 걸러 주지만, 섞여 와도 우리 셈이 틀어지면 안 된다."""
    c = FakeClient(_figs(BOOK, embedded=1) + _figs("남의id", embedded=99))
    rows = _rows()
    await T._attach_figure_progress(c, rows)
    assert rows[0]["figure_total"] == 1
