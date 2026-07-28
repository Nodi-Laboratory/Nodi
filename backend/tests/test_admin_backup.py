"""D114 — 백업 · 복원 · 초기화.

고정하는 계약 넷:
  1. **백업이 읽는 컬럼은 실제로 존재해야 한다** — 컬럼 이름을 눈으로 적다
     `class_members.joined_at`(실재하지 않음)을 넣어 백업 전체가 502로 죽었다.
     스키마 파일과 대조해 그 실수를 되풀이하지 않는다.
  2. **백업 이름으로 디렉터리를 벗어날 수 없다** — 이름이 URL로 들어온다.
  3. **복원 불가한 것을 복원 가능한 척하지 않는다** — documents는 원본 바이트와
     벡터가 스냅샷에 없다.
  4. **초기화는 계정을 건드리지 않는다** — 계정을 지우면 그 사람의 모든 것이
     CASCADE로 사라지고 되돌릴 수 없다.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services import admin_backup

REPO_DB = Path(__file__).resolve().parents[2] / "db" / "01_schema.sql"


def _schema_columns() -> dict[str, set[str]]:
    """db/01_schema.sql의 CREATE TABLE에서 테이블→컬럼 집합을 뽑는다.

    DB에 붙지 않고도 "이 컬럼이 있나"를 확인할 수 있는 유일한 진실 소스다
    (백엔드 테스트는 전부 mock이라 커넥션이 없다).
    """
    sql = REPO_DB.read_text(encoding="utf-8")
    out: dict[str, set[str]] = {}
    for m in re.finditer(
        r"CREATE TABLE public\.(\w+)\s*\((.*?)\n\);", sql, re.DOTALL
    ):
        table, body = m.group(1), m.group(2)
        cols: set[str] = set()
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith(("CONSTRAINT", "PRIMARY", "UNIQUE", "--")):
                continue
            name = line.split()[0]
            if name.isidentifier():
                cols.add(name)
        out[table] = cols
    return out


def test_백업이_읽는_컬럼이_스키마에_모두_있다():
    schema = _schema_columns()
    missing: list[str] = []
    for scope, tables in admin_backup._SCOPE_TABLES.items():
        for table, select, order in tables:
            assert table in schema, f"{scope}: 없는 테이블 {table}"
            known = schema[table]
            for col in select.split(","):
                if col not in known:
                    missing.append(f"{table}.{col}")
            order_col = order.split(".")[0]
            if order_col not in known:
                missing.append(f"{table}.{order_col} (order)")
    assert not missing, f"스키마에 없는 컬럼: {missing}"


@pytest.mark.parametrize(
    "bad",
    [
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "/etc/passwd",
        "sub/dir.json",
        "no-extension",
        "nodi.json.exe",
        "",
    ],
)
def test_백업_이름으로_디렉터리를_벗어날_수_없다(bad):
    with pytest.raises(HTTPException) as exc:
        admin_backup._path(bad)
    assert exc.value.status_code == 400


def test_정상적인_이름은_통과한다():
    p = admin_backup._path("nodi-20260728-120000.json")
    assert p.name == "nodi-20260728-120000.json"
    assert p.parent.name == "backups"


def test_문서는_복원_대상이_아니다():
    """스냅샷에 원본 바이트·벡터가 없다 — 행만 되살리면 껍데기가 남는다."""
    assert "documents" in admin_backup.ALL_SCOPES
    assert "documents" not in admin_backup.RESTORABLE_SCOPES
    assert "documents" in admin_backup.PURGEABLE_SCOPES


def test_계정은_초기화_대상이_아니다():
    assert "people" in admin_backup.ALL_SCOPES
    assert "people" not in admin_backup.PURGEABLE_SCOPES


async def test_알_수_없는_스코프로는_지울_수_없다():
    """오타 난 스코프가 '아무것도 안 지움'이 아니라 오류가 되어야 한다 —
    조용히 통과하면 지운 줄 알고 넘어간다."""
    with pytest.raises(HTTPException) as exc:
        await admin_backup.purge(object(), object(), scopes=["people", "오타"])
    assert exc.value.status_code == 400


pytestmark = pytest.mark.asyncio
