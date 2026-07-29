"""운영 CLI (D104-4).

가입 폼으로는 `admin`을 얻을 수 없다(D99 권한 상승 차단) — 첫 관리자를 만들
수단이 필요하다. 그 외 계정 관리도 여기서 한다.

사용:
    uv run python -m app.cli create-user <이메일> <비밀번호> [--role teacher] [--name 김선생]
    uv run python -m app.cli grant-admin <이메일>
    uv run python -m app.cli set-password <이메일> <비밀번호>
    uv run python -m app.cli list-users
    uv run python -m app.cli backup [--scopes conversations,people] [--keep 14]
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from .db.client import UserClient
from .db.pool import close_pools, worker_conn
from .services import accounts, admin_backup


async def _create_user(args: argparse.Namespace) -> int:
    user = await accounts.create_account(
        email=args.email.strip().lower(),
        password=args.password,
        display_name=args.name,
        role=args.role,
    )
    # role=admin은 트리거가 student로 떨어뜨린다 — 명시적으로 승격한다.
    if args.role == "admin":
        await accounts.set_role(user["email"], "admin")
    async with worker_conn() as conn:
        row = await conn.fetchrow(
            "select role from public.profiles where id = $1", user["id"]
        )
    print(f"생성됨: {user['email']}  역할={row['role']}")
    return 0


async def _grant_admin(args: argparse.Namespace) -> int:
    try:
        row = await accounts.set_role(args.email.strip().lower(), "admin")
    except LookupError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1
    print(f"승격됨: {row['email']} -> {row['role']}")
    return 0


async def _set_password(args: argparse.Namespace) -> int:
    try:
        row = await accounts.set_password(args.email.strip().lower(), args.password)
    except (LookupError, ValueError) as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1
    print(f"비밀번호 변경됨: {row['email']}")
    print("  (이미 발급된 토큰은 만료 전까지 그대로 통한다 — 서비스 docstring 참고)")
    return 0


async def _backup(args: argparse.Namespace) -> int:
    """스냅샷 생성 + 오래된 것 정리 (D119).

    자동 백업(deploy/backup-loop.sh)이 이 명령을 부른다.

    관리자 권한으로 읽는다 — 워커 커넥션(BYPASSRLS)으로 우회하지 않는다.
    "권한은 DB가 강제한다"(D104)를 자동화라고 예외로 두면, 그때부터 백업
    경로가 정책을 검증하지 않는 유일한 읽기 경로가 된다.
    """
    async with worker_conn() as conn:
        admin_id = await conn.fetchval(
            "select id from public.profiles where role = 'admin'"
            " order by created_at limit 1"
        )
    if admin_id is None:
        print("오류: 관리자 계정이 없다 — create-user --role admin 으로 먼저 만든다",
              file=sys.stderr)
        return 1

    scopes = [s.strip() for s in args.scopes.split(",") if s.strip()]
    meta = await admin_backup.create_backup(
        UserClient(str(admin_id)), scopes=scopes, note=args.note, actor="cli",
    )
    size_mb = meta.get("size_bytes", 0) / 1024 / 1024
    print(f"백업 생성: {meta['name']}  ({size_mb:.1f}MB)")
    for table, n in sorted(meta["counts"].items()):
        print(f"  {table:<14} {n}행")

    removed = admin_backup.prune_backups(args.keep)
    if removed:
        print(f"오래된 백업 {len(removed)}개 정리 (최신 {args.keep}개 유지)")
    return 0


async def _list_users(_: argparse.Namespace) -> int:
    async with worker_conn() as conn:
        rows = await conn.fetch(
            """
            select u.email, p.role, coalesce(p.display_name,'-') as name,
                   p.onboarded
            from public.users u join public.profiles p on p.id = u.id
            order by p.role, u.email
            """
        )
    if not rows:
        print("계정 없음")
        return 0
    for r in rows:
        print(
            f"{r['email']:<30} {r['role']:<8} {r['name']:<12}"
            f" onboarded={r['onboarded']}"
        )
    return 0


def build_parser() -> argparse.ArgumentParser:
    """파서 구성 — main()과 분리해 실행 없이 인자만 검증할 수 있게 한다."""
    parser = argparse.ArgumentParser(prog="app.cli", description="Nodi 운영 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create-user", help="계정 생성")
    p.add_argument("email")
    p.add_argument("password")
    p.add_argument("--role", default="student",
                   choices=["student", "teacher", "admin"])
    p.add_argument("--name", default=None)
    p.set_defaults(fn=_create_user)

    p = sub.add_parser("grant-admin", help="기존 계정을 관리자로 승격")
    p.add_argument("email")
    p.set_defaults(fn=_grant_admin)

    p = sub.add_parser("set-password", help="비밀번호 재설정")
    p.add_argument("email")
    p.add_argument("password")
    p.set_defaults(fn=_set_password)

    p = sub.add_parser("list-users", help="계정 목록")
    p.set_defaults(fn=_list_users)

    p = sub.add_parser("backup", help="데이터 스냅샷 생성 + 오래된 것 정리")
    p.add_argument("--scopes", default=",".join(admin_backup.ALL_SCOPES),
                   help="쉼표 구분 (기본: 전부)")
    p.add_argument("--keep", type=int, default=14,
                   help="남길 스냅샷 개수 (기본 14 — 하루 1회면 2주)")
    p.add_argument("--note", default="자동 백업")
    p.set_defaults(fn=_backup)

    return parser


def main() -> int:
    args = build_parser().parse_args()

    async def run() -> int:
        try:
            return await args.fn(args)
        finally:
            await close_pools()

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
