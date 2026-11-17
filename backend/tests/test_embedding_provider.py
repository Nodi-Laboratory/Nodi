"""임베딩 제공자 스위치(2026-11-17) — 라우팅 · 제공자별 거리 게이트 · 시드 벡터 대조.

"모두 gemini로" 전환의 안전장치다. 제공자는 **키 유무가 아니라 설정**
(`EMBEDDING_PROVIDER`)이 정한다 — 색인과 질의의 제공자가 갈리면 오류 없이 검색만
빈손이 되기 때문이다. 지키는 것:

  · 기본은 upstage — 이미 Upstage 벡터가 든 대회 서버가 안 바뀐다.
  · `upstage.embed_*`(호출부 8곳이 임포트하는 이름)가 설정으로 갈린다.
  · 거리 게이트는 제공자마다 다르고(Upstage 0.60 ↔ Gemini 0.36), **Upstage 값은 그대로다.**
    env·DB 오버레이로 명시한 값은 제공자 기본값을 이긴다.
  · 시드는 런타임 제공자와 맞는 벡터 파일만 올린다(다른 공간의 벡터를 섞지 않는다).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.config import GEMINI_GATE_DEFAULTS, Settings, gate_defaults
from app.services import admin_console, embedding, upstage

REPO = Path(__file__).resolve().parents[2]
GATE_KEYS = tuple(GEMINI_GATE_DEFAULTS)


# ── 라우팅 ──────────────────────────────────────────────────────────
@pytest.fixture
def routes(monkeypatch):
    """두 구현을 기록용 대역으로 바꾼다 — 호출이 어느 쪽으로 갔는지 본다."""
    calls: list[tuple] = []

    async def gemini(texts, *, kind="passage", concurrency=None):
        calls.append(("gemini", kind, list(texts), concurrency))
        return [[1.0] for _ in texts]

    async def up(texts, *, kind="passage", concurrency=None):
        calls.append(("upstage", kind, list(texts), concurrency))
        return [[2.0] for _ in texts]

    monkeypatch.setattr(upstage.gemini_embed, "embed_texts", gemini)
    monkeypatch.setattr(upstage, "_upstage_embed_texts", up)
    return calls


def test_기본_제공자는_upstage다():
    # 대회 운영 서버(Upstage 벡터 · Gemini 키 없음)가 기본값으로 그대로 돈다.
    assert Settings(_env_file=None).embedding_provider == "upstage"


async def test_upstage면_upstage로_간다(monkeypatch, routes):
    monkeypatch.setattr(upstage.settings, "embedding_provider", "upstage")
    await upstage.embed_query("질문")
    await upstage.embed_passages(["문서"])
    assert [(p, k) for p, k, *_ in routes] == [("upstage", "query"), ("upstage", "passage")]


async def test_gemini면_gemini로_가고_kind와_동시성이_따라간다(monkeypatch, routes):
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    await upstage.embed_query("질문")
    await upstage.embed_passages(["a", "b"])
    await upstage.embed_texts(["c"], kind="passage", concurrency=2)
    assert routes == [
        ("gemini", "query", ["질문"], None),
        ("gemini", "passage", ["a", "b"], None),
        ("gemini", "passage", ["c"], 2),
    ]


async def test_설정값은_대소문자_공백을_무시한다(monkeypatch, routes):
    monkeypatch.setattr(upstage.settings, "embedding_provider", " Gemini ")
    await upstage.embed_query("q")
    assert routes[0][0] == "gemini"


async def test_알_수_없는_제공자는_upstage로_돌리지_않고_실패한다(monkeypatch, routes):
    """오타 하나로 색인은 Gemini, 질의는 Upstage가 되면 검색이 조용히 빈손이 된다."""
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemin")
    with pytest.raises(RuntimeError, match="EMBEDDING_PROVIDER='gemin'"):
        await upstage.embed_query("q")
    assert routes == []


async def test_embedding_모듈의_task_type도_같은_길을_탄다(monkeypatch, routes):
    """embedding.embed_texts(task_type=…)가 제공자 스위치를 지나 kind로 간다."""
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    await embedding.embed_texts(["q"], task_type="RETRIEVAL_QUERY")
    await embedding.embed_texts(["d"], task_type="RETRIEVAL_DOCUMENT")
    assert [(p, k) for p, k, *_ in routes] == [("gemini", "query"), ("gemini", "passage")]


def test_문서_파싱은_제공자와_무관하게_upstage에_남는다():
    # Gemini에 구조화 요소·좌표·도판 크롭에 대응하는 API가 없다(사용자 결정 2026-11-17).
    assert callable(upstage.parse_document) and callable(upstage.parse_document_full)


# ── 제공자별 거리 게이트 ─────────────────────────────────────────────
UPSTAGE_GATES = {
    "class_material_rag_max_distance": 0.60,
    "figure_retrieve_max_distance": 0.60,
    "lecture_retrieve_max_distance": 0.60,
    "lecture_atom_max_distance": 0.45,
    "atom_rag_max_distance": 0.45,
    "crosslink_min_distance": 0.42,
    "crosslink_max_distance": 0.66,
}


def test_upstage_게이트는_옛_값_그대로다():
    """Upstage의 동작을 바꾸지 않는다 — 실측으로 정한 숫자의 회귀 방지."""
    s = Settings(_env_file=None)
    assert {k: getattr(s, k) for k in GATE_KEYS} == UPSTAGE_GATES
    assert gate_defaults("upstage") == UPSTAGE_GATES


def test_gemini면_명시하지_않은_게이트가_gemini_기본값이다():
    s = Settings(_env_file=None, embedding_provider="gemini")
    assert {k: getattr(s, k) for k in GATE_KEYS} == GEMINI_GATE_DEFAULTS
    assert gate_defaults("gemini") == GEMINI_GATE_DEFAULTS


def test_env로_명시한_게이트는_제공자_기본값을_이긴다(monkeypatch):
    monkeypatch.setenv("EMBEDDING_PROVIDER", "gemini")
    monkeypatch.setenv("CLASS_MATERIAL_RAG_MAX_DISTANCE", "0.5")
    s = Settings(_env_file=None)
    assert s.embedding_provider == "gemini"
    assert s.class_material_rag_max_distance == 0.5  # 명시한 값
    assert s.figure_retrieve_max_distance == GEMINI_GATE_DEFAULTS["figure_retrieve_max_distance"]


def test_gemini_게이트의_상호_관계():
    g = GEMINI_GATE_DEFAULTS
    # 원자(질문↔질문)는 직접(질문↔본문)보다 엄격하다 — Upstage의 0.45 < 0.60과 같은 관계.
    assert g["lecture_atom_max_distance"] < g["lecture_retrieve_max_distance"]
    assert g["atom_rag_max_distance"] < g["class_material_rag_max_distance"]
    # 연결 띠는 바닥 < 천장이고, 직접 게이트보다 위에 걸쳐 있다(융합은 직접 매칭보다 멀다).
    assert 0 < g["crosslink_min_distance"] < g["crosslink_max_distance"] < 0.9
    # 슬라이더 범위(admin_knobs) 안이다 — 밖이면 콘솔이 값을 못 보여 준다.
    for k, val in g.items():
        spec = next(sp for sp in admin_console._SPECS if sp["key"] == k)
        assert spec["min"] <= val <= spec["max"], k


def test_gemini_게이트는_upstage_숫자와_달라야_한다():
    # 같은 숫자를 쓰면 이 메커니즘이 아무 일도 안 한다(0.60은 Gemini에서 전부 통과시킨다).
    for k, val in GEMINI_GATE_DEFAULTS.items():
        assert val != UPSTAGE_GATES[k], k


# ── DB 시드 · 콘솔 ──────────────────────────────────────────────────
def test_씨앗_SQL은_게이트_7개를_null로_깐다():
    """숫자를 박으면 Gemini로 띄운 새 DB가 Upstage 게이트를 물려받는다(D62: 행이 이긴다)."""
    sql = (REPO / "db" / "03_app_settings.sql").read_text(encoding="utf-8")
    for key in GATE_KEYS:
        m = re.search(rf"\('{key}',\s*'([^']*)'\)", sql)
        assert m, f"{key} 행이 씨앗에 없다 — 콘솔에 'DB 행 없음'으로 뜬다"
        assert m.group(1) == "null", f"{key}: 숫자를 박지 말고 null(제공자 기본값을 따른다)"


def test_마이그레이션은_시드_기본값_그대로인_행만_null로_옮긴다():
    sql = (REPO / "db" / "migrations" / "2026-11-17-embedding-provider-gates.sql").read_text(
        encoding="utf-8"
    )
    body = re.sub(r"--[^\n]*", " ", sql)
    updates = [s for s in body.split(";") if re.match(r"\s*update\b", s, re.I)]
    assert len(updates) == 4
    for s in updates:
        assert re.search(r"\bwhere\b", s, re.I) and re.search(r"\bvalue\s*=\s*'", s, re.I)
    # 7개 키가 전부 어느 UPDATE엔가 있다.
    for key in GATE_KEYS:
        assert f"'{key}'" in body, key


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows

    async def select(self, table, params):
        return self._rows


async def test_콘솔은_null_행을_기본값_따름으로_보여_준다():
    rows = [{"key": "class_material_rag_max_distance", "value": None,
             "updated_at": None, "updated_by": None}]
    view = await admin_console.settings_view(_FakeClient(rows))
    item = next(i for i in view["items"] if i["key"] == "class_material_rag_max_distance")
    assert item["value"] == item["default"]  # 유효값은 현재 제공자의 기본값
    assert item["modified"] is False
    assert item["missing_row"] is False  # 행은 있다 — 'DB 행 없음' 배지가 뜨면 안 된다


async def test_콘솔은_관리자가_넣은_값을_그대로_보여_준다():
    rows = [{"key": "class_material_rag_max_distance", "value": 0.42,
             "updated_at": "t", "updated_by": "u"}]
    view = await admin_console.settings_view(_FakeClient(rows))
    item = next(i for i in view["items"] if i["key"] == "class_material_rag_max_distance")
    assert item["value"] == 0.42 and item["modified"] is True


def test_overlay의_null은_코드_기본값으로_읽힌다():
    from app.services import app_settings

    overlay = {"class_material_rag_max_distance": None}
    assert app_settings.as_float(overlay, "class_material_rag_max_distance", 0.36, 0.1, 0.9) == 0.36


# ── 시드 벡터 ↔ 런타임 제공자 ─────────────────────────────────────────
@pytest.fixture
def seed(monkeypatch):
    from app import seed_demo
    from app.seed_demo import vectors as vec

    return seed_demo, vec


def test_시드는_런타임_제공자의_벡터만_고른다(monkeypatch, seed):
    sd, vec = seed
    for provider in ("upstage", "gemini"):
        monkeypatch.setattr(upstage.settings, "embedding_provider", provider)
        points = sd._vectors_for_runtime()
        assert points == vec.vector_set(provider)["points"]
        assert len(points) == 97


def _write_set(tmp_path, monkeypatch, vec, provider, header):
    import gzip
    import json

    path = tmp_path / f"{provider}.json.gz"
    data = {"provider": provider, "model": "m", "dim": vec.DIM, "points": {"x": {}}} | header
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(data, fh)
    monkeypatch.setitem(vec.VECTORS_FILES, provider, path)


def test_파일이_없으면_경고하고_건너뛴다(monkeypatch, seed, tmp_path, capsys):
    sd, vec = seed
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    monkeypatch.setitem(vec.VECTORS_FILES, "gemini", tmp_path / "없음.json.gz")
    assert sd._vectors_for_runtime() is None
    assert "벡터 파일이 없다" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("header", "what"),
    [
        ({"provider": "upstage"}, "제공자"),    # 이름은 gemini 파일인데 머리가 다르다
        ({"model": "gemini-embedding-2"}, "모델"),  # 런타임 모델과 다른 공간
        ({"dim": 3072}, "차원"),
    ],
)
def test_머리가_런타임과_다르면_건너뛴다(monkeypatch, seed, tmp_path, capsys, header, what):
    sd, vec = seed
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    monkeypatch.setattr(upstage.settings, "gemini_embedding_model", "gemini-embedding-001")
    _write_set(tmp_path, monkeypatch, vec, "gemini", {"model": "gemini-embedding-001", **header})
    assert sd._vectors_for_runtime() is None
    out = capsys.readouterr().out
    assert "경고" in out and what in out


def test_알_수_없는_제공자_설정이면_벡터를_올리지_않는다(monkeypatch, seed, capsys):
    sd, _ = seed
    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemin")
    assert sd._vectors_for_runtime() is None
    assert "EMBEDDING_PROVIDER" in capsys.readouterr().out


async def test_불일치면_Qdrant에_아무것도_올리지_않는다(monkeypatch, seed, tmp_path):
    sd, vec = seed
    from app.services import qdrant_store

    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    monkeypatch.setitem(vec.VECTORS_FILES, "gemini", tmp_path / "없음.json.gz")
    touched: list[str] = []

    async def boom(*a, **k):
        touched.append("qdrant")

    monkeypatch.setattr(qdrant_store, "ensure_collections", boom)
    monkeypatch.setattr(qdrant_store, "upsert", boom)
    assert await sd._upsert_vectors() == 0
    assert touched == []


async def test_일치하면_그_제공자의_벡터만_올린다(monkeypatch, seed):
    sd, vec = seed
    from app.services import qdrant_store

    monkeypatch.setattr(upstage.settings, "embedding_provider", "gemini")
    uploaded: dict[str, list[list[float]]] = {}

    async def ensure():
        return None

    async def upsert(col, points):
        uploaded.setdefault(col, []).extend(p["vector"] for p in points)

    monkeypatch.setattr(qdrant_store, "ensure_collections", ensure)
    monkeypatch.setattr(qdrant_store, "upsert", upsert)
    assert await sd._upsert_vectors() == 97
    # Gemini 파일의 벡터다(Upstage 파일과 다르다) — 첫 청크 벡터로 대조한다.
    first = next(s for s in vec.specs() if s.collection == "file_chunks")
    g = vec.decode(vec.vector_set("gemini")["points"][first.point_id]["v"])
    u = vec.decode(vec.vector_set("upstage")["points"][first.point_id]["v"])
    assert g != u
    assert g in uploaded["file_chunks"] and u not in uploaded["file_chunks"]


def test_manifest는_제공자마다_검색_결과가_다르다(seed):
    _, vec = seed
    up, ge = vec.load_manifest("upstage"), vec.load_manifest("gemini")
    assert up["links"] != ge["links"]
    assert up["turns"].keys() == ge["turns"].keys()
    # 알 수 없는 제공자는 Upstage 칸으로 읽는다(DB에 남는 표시용 거리일 뿐).
    assert vec.load_manifest("nope")["links"] == up["links"]
