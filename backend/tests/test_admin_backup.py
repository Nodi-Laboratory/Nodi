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
    # `IF NOT EXISTS`와 꼬리 `WITH (fillfactor …)`(D146)도 받는다. 캔버스 표가
    # 둘 다 해당해서 **가드가 그 표들을 아예 검사하지 않고 있었다** — 백업에
    # 캔버스가 빠진 것을 이 가드가 못 잡은 이유다(D152에서 실측으로 드러났다).
    sql = REPO_DB.read_text(encoding="utf-8")
    out: dict[str, set[str]] = {}
    for m in re.finditer(
        r"CREATE TABLE (?:IF NOT EXISTS )?public\.(\w+)\s*\((.*?)\n\)"
        r"(?:\s*WITH\s*\([^)]*\))?;",
        sql,
        re.DOTALL
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


# --- D119: 자동 백업의 보존 정리 -------------------------------------------


def _seed(tmp_path: Path, names: list[str]) -> None:
    for n in names:
        (tmp_path / n).write_text('{"created_at": "2026-01-01T00:00:00"}', encoding="utf-8")


def test_보존_개수만큼만_남기고_최신을_지킨다(tmp_path, monkeypatch):
    """이름이 타임스탬프라 사전순 = 시간순이다 — 최신이 살아남아야 한다."""
    monkeypatch.setattr(admin_backup, "_dir", lambda: tmp_path)
    names = [f"nodi-2026072{d}-030000.json" for d in range(1, 6)]  # 21~25일
    _seed(tmp_path, names)

    removed = admin_backup.prune_backups(2)

    남은것 = sorted(p.name for p in tmp_path.glob("*.json"))
    assert 남은것 == ["nodi-20260724-030000.json", "nodi-20260725-030000.json"]
    assert sorted(removed) == names[:3]


def test_보존_개수보다_적으면_아무것도_안_지운다(tmp_path, monkeypatch):
    monkeypatch.setattr(admin_backup, "_dir", lambda: tmp_path)
    _seed(tmp_path, ["nodi-20260721-030000.json"])
    assert admin_backup.prune_backups(14) == []
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_보존_개수가_0이면_거부한다(tmp_path, monkeypatch):
    """전부 지우는 실수를 이 함수로 할 수 있으면 안 된다 — 자동 실행 경로다."""
    monkeypatch.setattr(admin_backup, "_dir", lambda: tmp_path)
    _seed(tmp_path, ["nodi-20260721-030000.json"])
    for bad in (0, -1):
        with pytest.raises(ValueError):
            admin_backup.prune_backups(bad)
    assert len(list(tmp_path.glob("*.json"))) == 1


pytestmark = pytest.mark.asyncio


def test_대화_백업에_캔버스가_들어_있다():
    """D152: 캔버스가 곧 대화 내용이다(D122).

    이게 빠지면 백업을 뜨고 초기화한 뒤 복원해도 세션 껍데기만 돌아온다.
    백업 파일에도 복원 결과에도 오류가 없어서 **캔버스를 열어 보기 전까지
    아무도 모른다** — 그래서 이름을 못 박아 둔다.
    """
    tables = {t for t, _, _ in admin_backup._SCOPE_TABLES["conversations"]}
    assert "canvas_items" in tables
    assert "canvas_drawings" in tables
