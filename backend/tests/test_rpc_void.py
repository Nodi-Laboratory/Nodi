"""void RPC 빈 응답 처리 회귀 테스트.

PostgREST는 `returns void` 함수(예: delete_file_cascade)에 204 No Content +
빈 본문을 돌려준다. rpc()가 이를 무조건 resp.json()으로 파싱하면
JSONDecodeError가 나 라우터에서 500이 되던 버그를 막는다 — DB 삭제는 이미
커밋된 뒤라 "행은 지워졌는데 API는 500"이 되던 문제였다.

UserClient.rpc / ServiceClient.rpc는 별개 클래스(상속 관계 아님)라 동일 패턴을
양쪽에서 검증한다. void(204/빈 본문) → None, 정상(JSON 본문) → 파싱값.
"""

import json
from types import SimpleNamespace

import pytest

from app.services import service_client as svc
from app.services import supabase_client as sc


class _FakeResponse:
    """httpx.Response 최소 대역 — status_code / content / text / json()만 흉내.

    실제 httpx처럼 빈 본문에서 json()이 JSONDecodeError를 던지도록 해
    수정 전 코드에서 버그가 재현되게 한다.
    """

    def __init__(self, status_code: int, content: bytes):
        self.status_code = status_code
        self.content = content
        self.text = content.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.content)  # b"" → JSONDecodeError (실제 httpx 동일)


class _FakeClient:
    """post() 한 번에 미리 준비한 응답을 돌려주는 async httpx 클라이언트 대역."""

    def __init__(self, response: _FakeResponse):
        self._response = response
        self.calls: list[str] = []

    async def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append(url)
        return self._response


def _user_client(monkeypatch, response: _FakeResponse):
    fake = _FakeClient(response)
    monkeypatch.setattr(sc, "get_shared_client", lambda: fake)
    monkeypatch.setattr(
        sc, "settings",
        SimpleNamespace(rest_url="http://x/rest/v1", supabase_anon_key="anon"),
    )
    return sc.UserClient("tok"), fake


def _service_client(monkeypatch, response: _FakeResponse):
    fake = _FakeClient(response)
    monkeypatch.setattr(svc, "_get_http", lambda: fake)
    monkeypatch.setattr(
        svc, "settings",
        SimpleNamespace(rest_url="http://x/rest/v1", storage_url="http://x/storage/v1"),
    )
    return svc.ServiceClient("srv-key"), fake


# --- UserClient.rpc ---------------------------------------------------------

@pytest.mark.asyncio
async def test_user_rpc_void_204_returns_none(monkeypatch):
    """delete_file_cascade류 void RPC: 204/빈 본문이면 예외 없이 None."""
    client, fake = _user_client(monkeypatch, _FakeResponse(204, b""))
    result = await client.rpc("delete_file_cascade", {"p_file_id": "f1"})
    assert result is None
    assert fake.calls == ["http://x/rest/v1/rpc/delete_file_cascade"]


@pytest.mark.asyncio
async def test_user_rpc_empty_body_200_returns_none(monkeypatch):
    """빈 본문(200이지만 content 없음)도 파싱하지 않고 None."""
    client, _ = _user_client(monkeypatch, _FakeResponse(200, b""))
    assert await client.rpc("some_void_fn", {}) is None


@pytest.mark.asyncio
async def test_user_rpc_json_body_returned(monkeypatch):
    """정상 케이스(회귀): JSON 본문을 반환하는 RPC는 파싱값을 그대로 돌려준다."""
    payload = [{"seq": 1}]
    client, _ = _user_client(
        monkeypatch, _FakeResponse(200, json.dumps(payload).encode())
    )
    assert await client.rpc("get_chunk_context", {"p_chunk_id": "c1"}) == payload


# --- ServiceClient.rpc ------------------------------------------------------

@pytest.mark.asyncio
async def test_service_rpc_void_204_returns_none(monkeypatch):
    """서비스롤 rpc도 동일 패턴 — void면 None."""
    client, _ = _service_client(monkeypatch, _FakeResponse(204, b""))
    assert await client.rpc("some_void_fn", {}) is None


@pytest.mark.asyncio
async def test_service_rpc_json_body_returned(monkeypatch):
    """정상 케이스(회귀): JSON 본문(예: text[])을 반환하는 서비스롤 RPC는 파싱값 그대로."""
    payload = ["물", "공기"]
    client, _ = _service_client(
        monkeypatch, _FakeResponse(200, json.dumps(payload).encode())
    )
    assert await client.rpc("some_json_fn", {"p_id": "f1"}) == payload
