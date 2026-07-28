"""D97 — `/health/config` 환경 자가진단 엔드포인트.

신규 팀원이 자기 `.env`에 무엇이 빠졌는지 브라우저 한 번으로 확인하는 창구다.
검증 관점 둘:

1. **비밀이 새지 않는다** — 응답 어디에도 키 값이 들어가면 안 된다. 이 엔드포인트는
   인증이 없으므로(health 라우터 전체가 no-auth) 이게 가장 중요한 계약이다.
2. **진단이 정확하다** — `blocking`·`judge.missing`이 실제 미설정 항목과 일치.

기존 `/health`는 liveness 계약이므로 응답 형태 불변을 함께 고정한다.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.routers import health as H

SECRETS = {
    "upstage_api_key": "up_SECRET_UPSTAGE",
    "judge_api_key": "SECRET_JUDGE",
    "jwt_secret": "SUPER_SECRET_SIGNING_KEY",
    "database_url": "postgresql://nodi_app:SECRET_DB_PASSWORD@localhost:5433/nodi",
    "database_worker_url": "postgresql://nodi_worker:SECRET_WORKER_PW@localhost:5433/nodi",
}
# TestClient를 context manager로 쓰지 않는다 — lifespan이 돌면 Qdrant 접속·워커
# 기동이 일어난다. 직접 .get()은 startup 없이 라우트만 태운다.


def _set(monkeypatch, **kw):
    for k, v in kw.items():
        monkeypatch.setattr(H.settings, k, v)


def test_health_shape_unchanged(monkeypatch):
    """기존 liveness 계약(키 집합) 불변 — 배포 프로브가 이 형태를 본다."""
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert set(r.json()) == {
        "status", "service", "environment",
        "db_configured", "worker_configured",
    }


def test_config_never_leaks_secret_values(monkeypatch):
    """어떤 비밀값도 응답 본문에 나타나지 않는다 (no-auth 엔드포인트)."""
    _set(monkeypatch, **SECRETS)
    monkeypatch.setattr(H.figure_judge.settings, "judge_api_key", SECRETS["judge_api_key"])
    body = TestClient(app).get("/health/config").text
    for value in SECRETS.values():
        assert value not in body


def test_config_reports_ready_when_core_set(monkeypatch):
    """채팅 한 턴의 최소 조건(database+upstage)이 갖춰지면 ready.

    D108: 대화 생성이 Upstage로 옮겨져 키가 하나로 줄었다.
    """
    _set(
        monkeypatch,
        database_url="postgresql://a:b@localhost/nodi",
        upstage_api_key="up_x",
    )
    d = TestClient(app).get("/health/config").json()
    assert d["ready"] is True
    assert d["blocking"] == []


def test_config_flags_missing_upstage(monkeypatch):
    """UPSTAGE_API_KEY 누락 — .env.example이 이 키를 빠뜨려 생기던 대표 사고.

    D108 이후 이 키 하나가 채팅과 임베딩을 **동시에** 막는다. blocking에 두 항목이
    같이 뜨는 것이 정상이고, 그래야 무엇이 죽었는지 진단에서 갈린다.
    """
    _set(
        monkeypatch,
        database_url="postgresql://a:b@localhost/nodi",
        upstage_api_key="",
    )
    d = TestClient(app).get("/health/config").json()
    assert d["ready"] is False
    assert d["blocking"] == ["chat", "upstage"]
    assert d["upstage"]["configured"] is False
    assert d["chat"]["configured"] is False


def test_config_judge_missing_lists_gaps(monkeypatch):
    """judge 블록이 빠진 키를 그대로 나열 — 업로드 503 사유와 같은 목록."""
    monkeypatch.setattr(H.figure_judge.settings, "judge_api_key", "k")
    monkeypatch.setattr(H.figure_judge.settings, "judge_base_url", "")
    monkeypatch.setattr(H.figure_judge.settings, "judge_model", "m")
    d = TestClient(app).get("/health/config").json()
    assert d["judge"]["configured"] is False
    assert d["judge"]["missing"] == ["JUDGE_BASE_URL"]


def test_config_judge_is_not_blocking(monkeypatch):
    """판정 미설정은 교과서 기능만 막는다 — 채팅은 성립하므로 ready를 깨지 않는다."""
    _set(
        monkeypatch,
        database_url="postgresql://a:b@localhost/nodi",
        upstage_api_key="up_x",
    )
    monkeypatch.setattr(H.figure_judge.settings, "judge_api_key", "")
    d = TestClient(app).get("/health/config").json()
    assert d["ready"] is True
    assert d["judge"]["configured"] is False


def test_config_reports_chat_model(monkeypatch):
    """어떤 생성 모델로 나가는지 보여준다 — 모델 교체 사고를 눈으로 잡는 창구."""
    _set(monkeypatch, upstage_api_key="up_x", upstage_chat_model="solar-pro2")
    d = TestClient(app).get("/health/config").json()
    assert d["chat"]["model"] == "solar-pro2"
    assert d["chat"]["base_url"].startswith("https://")
    # 생성과 임베딩이 같은 벤더가 됐지만 진단 블록은 분리 유지.
    assert "upstage" in d and "chat" in d


