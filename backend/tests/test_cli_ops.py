"""운영 CLI — 비밀번호 재설정 · 자동 백업 (D119).

고정하는 계약 셋:
  1. **짧은 비밀번호는 DB에 닿기 전에 거부된다** — CLI라고 가입 경로보다 약한
     규칙을 쓰면 운영 계정이 제일 약해진다.
  2. **백업은 관리자 권한으로 읽는다** — 워커(BYPASSRLS)로 우회하면 그때부터
     백업이 RLS를 검증하지 않는 유일한 읽기 경로가 된다(D104 위반).
  3. **관리자가 없으면 조용히 빈 백업을 만들지 않는다** — 자동 실행 경로라
     아무도 안 보고 있고, 나중에 "백업이 있다"고 믿게 된다.
"""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager

import pytest

from app import cli
from app.db.client import ServiceClient, UserClient
from app.services import accounts


@pytest.mark.asyncio
async def test_짧은_비밀번호는_DB에_닿기_전에_거부된다(monkeypatch):
    def 부르면_실패(*_a, **_k):
        raise AssertionError("검증 전에 DB에 접근했다")

    monkeypatch.setattr(accounts, "worker_conn", 부르면_실패)
    with pytest.raises(ValueError):
        await accounts.set_password("a@b.c", "1234567")  # 8자 미만


class _FakeConn:
    def __init__(self, admin_id):
        self._admin_id = admin_id

    async def fetchval(self, *_a, **_k):
        return self._admin_id


def _fake_worker_conn(admin_id):
    @asynccontextmanager
    async def _cm():
        yield _FakeConn(admin_id)

    return _cm


@pytest.mark.asyncio
async def test_백업은_관리자_권한으로_읽는다(monkeypatch):
    쓴클라이언트 = {}

    async def _create(client, **kwargs):
        쓴클라이언트["client"] = client
        return {"name": "nodi-x.json", "size_bytes": 1024, "counts": {"sessions": 3}}

    monkeypatch.setattr(cli, "worker_conn", _fake_worker_conn("admin-uuid"))
    monkeypatch.setattr(cli.admin_backup, "create_backup", _create)
    monkeypatch.setattr(cli.admin_backup, "prune_backups", lambda keep: [])

    rc = await cli._backup(
        argparse.Namespace(scopes="conversations,people", keep=14, note="테스트")
    )

    assert rc == 0
    client = 쓴클라이언트["client"]
    assert isinstance(client, UserClient)
    assert not isinstance(client, ServiceClient)
    assert client._user_id == "admin-uuid"


@pytest.mark.asyncio
async def test_관리자가_없으면_백업하지_않는다(monkeypatch):
    def 부르면_실패(*_a, **_k):
        raise AssertionError("관리자가 없는데 백업을 시도했다")

    monkeypatch.setattr(cli, "worker_conn", _fake_worker_conn(None))
    monkeypatch.setattr(cli.admin_backup, "create_backup", 부르면_실패)

    rc = await cli._backup(argparse.Namespace(scopes="conversations", keep=14, note=""))
    assert rc == 1


@pytest.mark.parametrize(
    "argv",
    [
        ["backup"],
        ["backup", "--keep", "7"],
        ["set-password", "a@b.c", "12345678"],
        ["create-user", "a@b.c", "12345678", "--role", "admin"],
        ["grant-admin", "a@b.c"],
        ["list-users"],
    ],
)
def test_운영_명령이_전부_등록돼_있다(argv):
    """스케줄러(deploy/backup-loop.sh)와 deploy/README.md가 이 이름으로 부른다.
    이름이나 옵션이 바뀌면 자동 백업이 매일 exit 2로 조용히 실패한다."""
    args = cli.build_parser().parse_args(argv)
    assert callable(args.fn)


def test_백업_보존_기본값이_2주다():
    """하루 1회 × 14 = 2주. 이 숫자가 줄면 복구 가능 범위가 조용히 좁아진다."""
    assert cli.build_parser().parse_args(["backup"]).keep == 14
