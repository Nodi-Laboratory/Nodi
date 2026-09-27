"""세션 쿠키(httpOnly) — Secure 판정 · 로그아웃 · 쿠키로 인증 (공개판 2026-09-27).

DB 없이 도는 부분만 본다: Secure 플래그 규칙, 로그아웃이 쿠키를 지우는지,
그리고 `get_current_user`가 헤더 없이 쿠키만으로 통과하는지.
"""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.auth import deps
from app.auth.tokens import create_access_token
from app.routers import me


@pytest.mark.parametrize(
    ("explicit", "env", "expected"),
    [
        (None, "production", True),   # 운영은 HTTPS 전용 — 자동으로 켠다
        (None, "development", False),  # compose 로컬·호스트 개발은 http
        (False, "production", False),  # 명시값이 이긴다
        (True, "development", True),
    ],
)
def test_cookie_secure_rule(monkeypatch, explicit, env, expected):
    monkeypatch.setattr(me.settings, "cookie_secure", explicit)
    monkeypatch.setattr(me.settings, "environment", env)
    assert me._cookie_secure() is expected


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(me.router, prefix="/api")

    @app.get("/whoami")
    async def whoami(user: deps.CurrentUser = Depends(deps.get_current_user)):
        return {"id": user.id}

    return app


def test_logout_deletes_httponly_cookie(monkeypatch):
    monkeypatch.setattr(me.settings, "cookie_secure", None)
    monkeypatch.setattr(me.settings, "environment", "development")
    res = TestClient(_app()).post("/api/auth/logout")
    assert res.status_code == 204
    set_cookie = res.headers["set-cookie"].lower()
    assert set_cookie.startswith(f"{deps.SESSION_COOKIE}=")
    assert "max-age=0" in set_cookie
    assert "httponly" in set_cookie


def test_cookie_alone_authenticates():
    client = TestClient(_app())
    client.cookies.set(deps.SESSION_COOKIE, create_access_token("u-1", "a@b.test"))
    assert client.get("/whoami").json() == {"id": "u-1"}


def test_no_cookie_no_header_is_401():
    assert TestClient(_app()).get("/whoami").status_code == 401


def test_header_wins_over_cookie():
    client = TestClient(_app())
    client.cookies.set(deps.SESSION_COOKIE, create_access_token("from-cookie"))
    res = client.get(
        "/whoami",
        headers={"Authorization": f"Bearer {create_access_token('from-header')}"},
    )
    assert res.json() == {"id": "from-header"}
