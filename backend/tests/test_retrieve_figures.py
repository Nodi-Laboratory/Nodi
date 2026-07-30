"""TASK 4 — 교과서 도판 검색 + signed URL 서빙 + RAG·교사 목록 textbook 합류 (D87).

외부 의존(qdrant/upstage/app_settings/service_client.storage_sign)은 전부
monkeypatch — 학급 스코프 검색·RLS 재조회·캡션 선택 규칙을 단위로 검증한다.

D111: 검색 구현이 `routers/retrieve.py`에서 `services/figure_search.py`로 옮겼다.
프론트가 SSE 전에 부르던 `POST /retrieve`는 사라졌고, 도판은 서버가 찾아
chat done 이벤트로 보낸다. 검증 대상은 라우터가 아니라 그 서비스 함수다.
"""

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.routers import files as F
from app.routers import teacher as T
from app.services import figure_search as R
from app.services import figures as FIG
from app.services import qdrant_store, rag


class _FakeUser:
    id = "u1"
    email = "u@test"


class _FakeClient:
    """테이블별 응답 핸들러를 주입하는 UserClient 대역."""

    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []  # (table, params) 기록

    async def select(self, table, params):
        self.calls.append((table, params))
        handler = self.responses.get(table)
        if callable(handler):
            return handler(params)
        return handler or []

    async def rpc(self, fn, args):
        return True


FIG_ROW = {
    "id": "fig1",
    "file_id": "tb1",
    "page": 7,
    "candidates": ["광합성 그림"],
    "selected_index": 0,
    "caption": "",
    "alt": "",
    "image_path": "u1/tb1/figures/p7_e2.png",
}


# --- display_caption 규칙 (판정 선택 → caption → alt) ------------------------


def test_display_caption_selected_candidate():
    row = {
        "candidates": ["A", "B", "C"],
        "selected_index": 1,
        "caption": "위치캡션",
        "alt": "대체",
    }
    assert FIG.display_caption(row) == "B"


def test_display_caption_falls_back_to_caption_when_no_selection():
    row = {"candidates": ["A"], "selected_index": -1, "caption": "위치캡션", "alt": "대체"}
    assert FIG.display_caption(row) == "위치캡션"
    row2 = {"candidates": [], "selected_index": None, "caption": "위치캡션", "alt": "대체"}
    assert FIG.display_caption(row2) == "위치캡션"


def test_display_caption_falls_back_to_alt_when_no_caption():
    row = {"candidates": [], "selected_index": -1, "caption": "", "alt": "대체"}
    assert FIG.display_caption(row) == "대체"


def test_figure_item_shape():
    item = FIG.figure_item(FIG_ROW, "https://signed", 0.87)
    assert item == {
        "figure_id": "fig1",
        "file_id": "tb1",
        "page": 7,
        "caption": "광합성 그림",
        "url": "https://signed",
        "score": 0.87,
    }
    # score None → 키 생략
    assert "score" not in FIG.figure_item(FIG_ROW, "https://signed")


# --- sign_figure_url (service-role 발급/강등) --------------------------------


@pytest.mark.asyncio
async def test_sign_figure_url_none_without_service(monkeypatch):
    monkeypatch.setattr(FIG, "get_service_client", lambda: None)
    assert await FIG.sign_figure_url(FIG_ROW) is None


@pytest.mark.asyncio
async def test_sign_figure_url_calls_storage_sign(monkeypatch):
    captured = {}

    class FakeService:
        async def storage_sign(self, bucket, path, expires_in):
            captured.update(bucket=bucket, path=path, expires_in=expires_in)
            return "https://signed"

    monkeypatch.setattr(FIG, "get_service_client", lambda: FakeService())
    url = await FIG.sign_figure_url(FIG_ROW)
    assert url == "https://signed"
    assert captured["bucket"] == get_settings().storage_bucket
    assert captured["path"] == "u1/tb1/figures/p7_e2.png"
    assert captured["expires_in"] == get_settings().figure_signed_url_ttl_seconds


@pytest.mark.asyncio
async def test_sign_figure_url_none_on_failure(monkeypatch):
    class FakeService:
        async def storage_sign(self, bucket, path, expires_in):
            raise RuntimeError("sign boom")

    monkeypatch.setattr(FIG, "get_service_client", lambda: FakeService())
    assert await FIG.sign_figure_url(FIG_ROW) is None


# --- rag 스코프 파생 (class_material에 textbook 합류 + textbook 전용) -----------


@pytest.mark.asyncio
async def test_class_material_file_ids_includes_textbook():
    captured = {}

    class C:
        async def select(self, table, params):
            captured.update(params)
            return [{"id": "f1"}]

    ids = await rag.class_material_file_ids(C(), "c1")
    assert ids == ["f1"]
    assert captured["kind"] == "in.(class_material,textbook)"
    assert captured["status"] == "in.(indexed,partial)"


@pytest.mark.asyncio
async def test_textbook_file_ids_no_status_filter():
    captured = {}

    class C:
        async def select(self, table, params):
            captured.update(params)
            return [{"id": "tb1"}, {"id": "tb2"}]

    ids = await rag.textbook_file_ids(C(), "c1")
    assert ids == ["tb1", "tb2"]
    assert captured["kind"] == "eq.textbook"
    assert captured["space_kind"] == "eq.class"
    assert captured["space_ref"] == "eq.c1"
    assert "status" not in captured  # figure 가용성은 텍스트 status와 독립(D88)


# --- _search_figures 레그 ---------------------------------------------------


def _patch_figures_infra(
    monkeypatch,
    *,
    space_kind="class",
    space_ref="c1",
    file_ids=("tb1",),
    hits=None,
    rows=None,
    overlay=None,
    sign="https://signed",
    capture=None,
):
    async def fake_textbook_ids(client, ref):
        return list(file_ids)

    async def fake_overlay():
        return overlay or {}

    async def fake_search(collection, vector, k, file_ids=None, score_threshold=None):
        if capture is not None:
            capture.update(
                collection=collection,
                k=k,
                file_ids=file_ids,
                score_threshold=score_threshold,
            )
        return list(hits or [])

    async def fake_sign(row):
        return sign

    async def fake_embed_query(text):
        # 실 임베딩 호출(UPSTAGE_API_KEY 필요)을 막는다 — 검색은 fake_search가
        # 가로채므로 벡터 내용은 무관하다. 미mock 시 search 앞에서 RuntimeError로
        # 빠져 함수의 try/except가 삼키고, 도판 반환·score_threshold 전달 검증이
        # 무력화된다(빈 목록으로 통과하거나 capture 미기록).
        return [0.0]

    monkeypatch.setattr(R.rag, "textbook_file_ids", fake_textbook_ids)
    monkeypatch.setattr(R.app_settings, "get_overlay", fake_overlay)
    monkeypatch.setattr(R.upstage, "embed_query", fake_embed_query)
    monkeypatch.setattr(R.qdrant_store, "search", fake_search)
    monkeypatch.setattr(R.figures, "sign_figure_url", fake_sign)
    return _FakeClient({"textbook_figures": lambda p: list(rows or [])})


@pytest.mark.asyncio
async def test_search_figures_class_hit_returns_item(monkeypatch):
    client = _patch_figures_infra(
        monkeypatch, hits=[{"id": "fig1", "score": 0.9}], rows=[FIG_ROW]
    )
    out = await R.search_class_figures(client, "c1", "광합성")
    assert len(out) == 1
    assert out[0]["figure_id"] == "fig1"
    assert out[0]["caption"] == "광합성 그림"  # candidates[selected_index]
    assert out[0]["url"] == "https://signed"
    assert out[0]["page"] == 7
    assert out[0]["score"] == 0.9


@pytest.mark.asyncio
async def test_search_figures_personal_returns_empty(monkeypatch):
    """개인 공간은 space_ref가 없다 — 조회 전에 빈 목록으로 끝난다."""
    client = _patch_figures_infra(
        monkeypatch, hits=[{"id": "fig1", "score": 0.9}], rows=[FIG_ROW]
    )
    assert await R.search_class_figures(client, None, "광합성") == []


@pytest.mark.asyncio
async def test_search_figures_no_textbook_files_returns_empty(monkeypatch):
    client = _patch_figures_infra(
        monkeypatch, file_ids=(), hits=[{"id": "fig1", "score": 0.9}], rows=[FIG_ROW]
    )
    out = await R.search_class_figures(client, "c1", "광합성")
    assert out == []


@pytest.mark.asyncio
async def test_search_figures_rls_dropped_hit(monkeypatch):
    # 히트는 있으나 RLS 재조회에서 행 안 보임(타 학급) → 조용히 탈락 → []
    client = _patch_figures_infra(
        monkeypatch, hits=[{"id": "fig1", "score": 0.9}], rows=[]
    )
    out = await R.search_class_figures(client, "c1", "광합성")
    assert out == []


@pytest.mark.asyncio
async def test_search_figures_unsigned_dropped(monkeypatch):
    # signed URL 실패(None) → url 없는 figure 노드 방지 → 탈락
    client = _patch_figures_infra(
        monkeypatch, hits=[{"id": "fig1", "score": 0.9}], rows=[FIG_ROW], sign=None
    )
    out = await R.search_class_figures(client, "c1", "광합성")
    assert out == []


@pytest.mark.asyncio
async def test_search_figures_score_threshold_from_overlay(monkeypatch):
    cap = {}
    client = _patch_figures_infra(
        monkeypatch,
        hits=[],
        rows=[],
        overlay={"figure_retrieve_max_distance": 0.40},
        capture=cap,
    )
    await R.search_class_figures(client, "c1", "광합성")
    assert cap["collection"] == qdrant_store.COL_TEXTBOOK_FIGURES
    # distance = 1 - score 규약 → score_threshold = 1 - max_distance
    assert cap["score_threshold"] == pytest.approx(1.0 - 0.40)
    assert cap["file_ids"] == ["tb1"]
    assert cap["k"] == get_settings().figure_retrieve_top_k


# --- 검색 실패 격리 ---------------------------------------------------------


@pytest.mark.asyncio
async def test_search_figures_swallows_internal_error(monkeypatch):
    """검색 내부 예외는 빈 목록으로 강등된다 — 도판 실패가 채팅을 막지 않는다.

    D111: 예전에는 /retrieve 라우터가 이 격리를 했다. 라우터가 사라지면서
    책임이 서비스로 내려왔으므로 계약도 여기서 고정한다.
    """

    async def boom(client, ref):
        raise RuntimeError("figure leg boom")

    monkeypatch.setattr(R.rag, "textbook_file_ids", boom)
    assert await R.search_class_figures(_FakeClient(), "c1", "질문") == []


@pytest.mark.asyncio
async def test_search_figures_empty_query_skips_work(monkeypatch):
    async def boom(client, ref):
        raise AssertionError("빈 질의에 조회가 나가면 안 된다")

    monkeypatch.setattr(R.rag, "textbook_file_ids", boom)
    assert await R.search_class_figures(_FakeClient(), "c1", "   ") == []


# --- GET /files/figures/{id} 재수화 -----------------------------------------


@pytest.mark.asyncio
async def test_get_figure_success(monkeypatch):
    client = _FakeClient({"textbook_figures": lambda p: [FIG_ROW]})
    monkeypatch.setattr(F.UserClient, "from_user", classmethod(lambda cls, u: client))

    async def fake_sign(row):
        return "https://signed"

    monkeypatch.setattr(F.figures, "sign_figure_url", fake_sign)

    out = await F.get_figure("fig1", user=_FakeUser())
    assert out == {
        "figure_id": "fig1",
        "url": "https://signed",
        "caption": "광합성 그림",
        "page": 7,
    }


@pytest.mark.asyncio
async def test_get_figure_not_found(monkeypatch):
    client = _FakeClient({"textbook_figures": lambda p: []})
    monkeypatch.setattr(F.UserClient, "from_user", classmethod(lambda cls, u: client))
    with pytest.raises(HTTPException) as ei:
        await F.get_figure("missing", user=_FakeUser())
    assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_get_figure_sign_unavailable_503(monkeypatch):
    client = _FakeClient({"textbook_figures": lambda p: [FIG_ROW]})
    monkeypatch.setattr(F.UserClient, "from_user", classmethod(lambda cls, u: client))

    async def fake_sign(row):
        return None

    monkeypatch.setattr(F.figures, "sign_figure_url", fake_sign)
    with pytest.raises(HTTPException) as ei:
        await F.get_figure("fig1", user=_FakeUser())
    assert ei.value.status_code == 503


# --- teacher.list_materials 에 textbook 합류 ---------------------------------


@pytest.mark.asyncio
async def test_teacher_list_materials_includes_textbook(monkeypatch):
    captured = {}

    class C:
        async def rpc(self, fn, args):
            return True

        async def select(self, table, params):
            captured.update(params)
            return []

    monkeypatch.setattr(T.UserClient, "from_user", classmethod(lambda cls, u: C()))
    await T.list_materials("c1", user=_FakeUser(), _=None)
    assert captured["kind"] == "in.(class_material,textbook)"
    assert "kind" in captured["select"]  # 프론트 배지용
