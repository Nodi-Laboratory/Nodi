"""D113 — 운영 콘솔 서비스: 튜너블 스펙 · AI 흐름 · RAG 테스트.

고정하는 계약 넷:
  1. **행이 없는 튜너블도 보인다** — app_settings에 행이 없으면 콘솔에서 아예
     조정할 수 없는데(D62), 그 상태를 숨기지 않고 missing_row로 드러낸다.
  2. **흐름 그림은 레지스트리에서 나온다** — 스킬 이름을 손으로 적어 두면
     코드가 바뀔 때 그림만 옛말이 된다.
  3. **범위가 비면 임베딩을 부르지 않는다** — 검색할 파일이 없는데 질의를
     임베딩하면 돈만 쓰고 결과는 같다.
  4. **게이트는 필터가 아니라 표시다** — 잘린 청크를 거리와 함께 보여줘야
     게이트 값을 어디로 옮길지 판단할 수 있다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.routers.admin import _LOG_SELECT
from app.services import admin_console
from app.services.turn_log import TurnLog

pytestmark = pytest.mark.asyncio


# ── 0) 로그가 기록한 것은 전부 읽혀야 한다 ────────────────────────────
def test_턴로그가_쓰는_컬럼은_모두_조회된다():
    """D113에서 실제로 겪은 회귀.

    ai_logs에 tokens·route·model·duration_ms를 추가했는데 조회 select 문자열을
    같이 늘리지 않아, **DB에는 있는데 콘솔에는 안 보이는** 상태가 됐다. 기록하는
    쪽(TurnLog.to_row)이 진실이므로 거기서 컬럼을 뽑아 대조한다.
    """
    written = set(TurnLog("u", "s", "q").to_row())
    selected = set(_LOG_SELECT.split(","))
    missing = written - selected
    assert not missing, f"기록은 하는데 조회하지 않는 컬럼: {sorted(missing)}"


class _FakeClient:
    """app_settings 행만 돌려주는 최소 대역."""

    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows

    async def select(self, table: str, params: dict[str, Any]):
        assert table == "app_settings"
        return self._rows


# ── 1) 튜너블 스펙 ────────────────────────────────────────────────────
async def test_행이_없는_튜너블도_기본값과_함께_보인다():
    view = await admin_console.settings_view(_FakeClient([]))
    by_key = {i["key"]: i for i in view["items"]}
    item = by_key["rag_top_k"]
    assert item["missing_row"] is True
    assert item["value"] == item["default"]  # 행이 없으면 코드 기본값이 현재값
    assert item["modified"] is False
    assert item["spec"]["widget"] == "number"


async def test_기본값과_다르면_변경됨으로_표시된다():
    rows = [{"key": "rag_top_k", "value": 12, "updated_at": "t", "updated_by": "u"}]
    view = await admin_console.settings_view(_FakeClient(rows))
    item = next(i for i in view["items"] if i["key"] == "rag_top_k")
    assert item["value"] == 12
    assert item["modified"] is True
    assert item["missing_row"] is False


async def test_스펙_없는_키도_JSON_위젯으로_나온다():
    """코드가 모르는 키를 조용히 숨기면 관리자가 그 값을 고칠 방법이 없다."""
    rows = [{"key": "미등록키", "value": 1, "updated_at": None, "updated_by": None}]
    view = await admin_console.settings_view(_FakeClient(rows))
    item = next(i for i in view["items"] if i["key"] == "미등록키")
    assert item["spec"]["widget"] == "json"
    assert item["spec"]["group"] == "기타"


def test_모든_스펙_키에_코드_기본값이_있다():
    """스펙에만 있고 config.py엔 없는 키가 생기면 '기본값 복귀'가 404가 된다."""
    for spec in admin_console._SPECS:
        assert admin_console.default_for(spec["key"]) is not None, spec["key"]


def test_모든_그룹이_정렬_목록에_있다():
    """빠진 그룹은 **안 보이지 않고 맨 뒤로 간다** — 그래서 눈으로 안 잡힌다.

    화면은 `_GROUP_ORDER`의 색인으로 정렬하고 없는 이름은 999로 민다(기타와
    같은 자리). 새 노브 묶음을 넣고 여기 이름을 안 더하면 관리자가 그 묶음을
    "기타" 아래 낯선 자리에서 찾게 된다.
    """
    for spec in admin_console._SPECS:
        assert spec["group"] in admin_console._GROUP_ORDER, spec["key"]


# ── 2) AI 흐름 ────────────────────────────────────────────────────────
def test_흐름은_활성_경로를_반영한다():
    on = admin_console.flow_spec(react_on=True, react_steps=3, skills=[])
    off = admin_console.flow_spec(react_on=False, react_steps=3, skills=[])
    assert on["active_route"] == "react"
    assert off["active_route"] == "legacy"
    # 두 경로가 **모두** 그려져야 한다 — 꺼진 쪽을 지우면 롤백 경로가 뭔지
    # 화면만 봐서는 알 수 없다.
    routes = {n["route"] for n in on["nodes"]}
    assert {"react", "legacy", "both"} <= routes


def test_흐름의_스킬_목록은_인자로_받은_것을_쓴다():
    """레지스트리에서 온 이름이 그대로 실려야 그림이 코드를 따라간다."""
    flow = admin_console.flow_spec(
        react_on=True,
        react_steps=5,
        skills=[{"name": "search_class_material", "description": "d"}],
    )
    node = next(n for n in flow["nodes"] if n["id"] == "skills")
    assert node["skills"] == ["search_class_material"]
    assert "5" in node["detail"]  # 상한이 화면 문구에 그대로 반영된다


def test_흐름의_모든_간선이_실재하는_노드를_가리킨다():
    flow = admin_console.flow_spec(react_on=True, react_steps=3, skills=[])
    ids = {n["id"] for n in flow["nodes"]}
    for e in flow["edges"]:
        assert e["from"] in ids, e
        assert e["to"] in ids, e


# ── 3) RAG 테스트 ─────────────────────────────────────────────────────
class _ScopelessClient:
    async def select(self, table: str, params: dict[str, Any]):
        return []  # app_settings·files 어느 쪽이든 비어 있다


async def test_범위가_비면_임베딩을_부르지_않는다(monkeypatch):
    called = {"n": 0}

    async def boom(*a, **k):
        called["n"] += 1
        return [[0.0]]

    monkeypatch.setattr(admin_console.embedding, "embed_texts", boom)
    out = await admin_console.rag_test(
        _ScopelessClient(), query="광합성", class_id="c1"
    )
    assert called["n"] == 0
    assert out["hits"] == []
    assert out["notes"]  # 왜 비었는지 말해 준다


async def test_게이트에_걸린_청크도_거리와_함께_보인다(monkeypatch):
    chunks = [
        {"file_id": "f1", "chunk_id": "k1", "seq": 0, "chunk_text": "온토픽", "distance": 0.48},
        {"file_id": "f1", "chunk_id": "k2", "seq": 1, "chunk_text": "무관", "distance": 0.86},
    ]

    async def fake_ids(client, class_id):
        return ["f1"]

    async def fake_embed(texts, task_type=None):
        return [[0.1] * 1024]

    async def fake_search(client, ids, query, k):
        return chunks

    async def fake_names(client, ids):
        return {"f1": "자료.txt"}

    monkeypatch.setattr(admin_console.rag, "class_material_file_ids", fake_ids)
    monkeypatch.setattr(admin_console.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(admin_console.rag, "search", fake_search)
    monkeypatch.setattr(admin_console.rag, "file_names", fake_names)

    out = await admin_console.rag_test(
        _ScopelessClient(),
        query="광합성",
        class_id="c1",
        max_distance=0.6,
        include_figures=False,
    )
    assert out["passed"] == 1
    assert out["blocked"] == 1
    # **차단된 것도 목록에 남는다** — 필터로 지우면 게이트를 조정할 근거가 없다.
    assert [h["passed"] for h in out["hits"]] == [True, False]
    assert out["hits"][1]["distance"] == 0.86
    # 실제 주입 블록에는 통과분만.
    assert "온토픽" in out["block"]
    assert "무관" not in out["block"]


async def test_score는_거리의_보수다(monkeypatch):
    """거리 규약(distance = 1 - score)을 화면에서도 뒤집어 볼 수 있어야 한다."""
    async def fake_ids(client, class_id):
        return ["f1"]

    async def fake_embed(texts, task_type=None):
        return [[0.1]]

    async def fake_search(client, ids, query, k):
        return [{"file_id": "f1", "chunk_id": "k", "seq": 0,
                 "chunk_text": "t", "distance": 0.25}]

    async def fake_names(client, ids):
        return {"f1": "a.txt"}

    monkeypatch.setattr(admin_console.rag, "class_material_file_ids", fake_ids)
    monkeypatch.setattr(admin_console.embedding, "embed_texts", fake_embed)
    monkeypatch.setattr(admin_console.rag, "search", fake_search)
    monkeypatch.setattr(admin_console.rag, "file_names", fake_names)

    out = await admin_console.rag_test(
        _ScopelessClient(), query="q", class_id="c1", include_figures=False
    )
    assert out["hits"][0]["score"] == 0.75


# ── 5) 환경 진단은 관리자만 본다 (D116) ──────────────────────────────
def test_환경_진단은_관리자_인증을_요구한다():
    """공개 노출 사고의 회귀 방지.

    콘솔이 `/health/config`를 직접 부르던 시절, 프론트·백엔드를 같은 출처로
    배포하자 그 경로가 **인증 없이** 인터넷에 열렸다. 비밀값은 없지만
    secret_is_default·jwt_algorithm·내부 경로가 정찰 정보다.

    이제 콘솔은 `/api/admin/env`를 쓴다. 이 라우트에서 admin 의존성이
    빠지면 같은 사고가 조용히 재발하므로 여기서 못을 박는다.
    """
    from app.auth.deps import require_admin
    from app.routers.admin import router

    # router에 prefix="/admin"이 붙어 있어 등록 경로는 "/admin/env"다.
    route = next(r for r in router.routes if getattr(r, "path", None) == "/admin/env")
    guards = {d.call for d in route.dependant.dependencies}
    assert require_admin in guards, "admin/env에 require_admin이 없다"


@pytest.mark.asyncio
async def test_환경_진단은_health와_같은_내용이다():
    """둘이 갈라지면 서버에서 친 진단과 콘솔 화면이 달라진다.

    관리자용 엔드포인트를 따로 만들면서 페이로드를 복사해 두면, 한쪽만
    고쳐졌을 때 원인을 찾는 데 시간이 든다 — 같은 함수를 쓰는지 확인한다.
    """
    from app.routers import admin, health

    # `config_report`는 async가 됐다 (킬 스위치가 오버레이를 타면서).
    assert admin.health.config_report is health.config_report

    report = await health.config_report()
    for key in ("ready", "blocking", "environment", "database", "auth", "judge"):
        assert key in report
