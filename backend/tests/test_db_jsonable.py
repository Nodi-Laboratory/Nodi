"""D104 회귀 — asyncpg 반환값이 JSON 호환 원시값으로 정규화되는가.

**이 정규화가 빠지면 앱이 조용히 망가진다.** PostgREST는 JSON을 돌려줘서
uuid·timestamptz가 전부 문자열이었고, 코드베이스 전체가 그 전제로 쓰였다.
asyncpg는 `uuid.UUID`·`datetime` 객체를 주는데 파이썬에서

    UUID("…") == "…"   →  항상 False

실제로 이 한 줄이 채팅을 통째로 막았다 — chat.py의
`session["owner_id"] != user.id`가 UUID vs str 비교라 항상 참이 되어 모든 질문이
403으로 거부됐다. 타입만 다를 뿐 값은 같아서 로그만 봐서는 원인이 안 보인다.
"""

from datetime import UTC, date, datetime
from decimal import Decimal
from uuid import UUID

from app.db.client import _jsonable

UID = "cb6da555-d3b1-4456-a9ca-849bcbf072b5"


def test_uuid_becomes_comparable_string():
    """핵심: 정규화 후 문자열과 == 비교가 성립해야 한다."""
    out = _jsonable(UUID(UID))
    assert out == UID
    assert isinstance(out, str)


def test_datetime_becomes_iso_string():
    dt = datetime(2026, 7, 27, 11, 22, 41, tzinfo=UTC)
    assert _jsonable(dt) == dt.isoformat()
    assert isinstance(_jsonable(dt), str)


def test_date_becomes_iso_string():
    assert _jsonable(date(2026, 7, 27)) == "2026-07-27"


def test_decimal_becomes_float():
    assert _jsonable(Decimal("0.60")) == 0.60
    assert isinstance(_jsonable(Decimal("0.60")), float)


def test_plain_values_pass_through():
    for v in ("문자열", 42, 3.14, True, None):
        assert _jsonable(v) == v


def test_nested_list_and_dict():
    """jsonb 컬럼(attachments 등) 안에 UUID가 섞여도 재귀 변환된다."""
    src = {"canvas": {"figures": [{"figure_id": UUID(UID), "page": 3}]}}
    out = _jsonable(src)
    assert out["canvas"]["figures"][0]["figure_id"] == UID


def test_uuid_array_column():
    """connections uuid[] — 리스트 안 UUID도 문자열이 되어야 한다."""
    out = _jsonable([UUID(UID), UUID(UID)])
    assert out == [UID, UID]


def test_row_normalization_end_to_end():
    """_rows가 레코드 전체를 정규화하는지 (asyncpg.Record 대역)."""
    from app.db.client import _rows

    class _FakeRecord:
        def __init__(self, d):
            self._d = d

        def items(self):
            return self._d.items()

    rows = _rows([
        _FakeRecord({
            "id": UUID(UID),
            "created_at": datetime(2026, 7, 27, tzinfo=UTC),
            "title": "세션",
        })
    ])
    assert rows[0]["id"] == UID
    assert rows[0]["created_at"] == "2026-07-27T00:00:00+00:00"
    assert rows[0]["title"] == "세션"
