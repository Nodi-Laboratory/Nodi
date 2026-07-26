"""채팅 figures 영속 — attachments.canvas.figures (D87).

프론트가 /retrieve figure 추천을 채팅 턴에 되돌려주면 done 훅이
attachments.canvas에 저장한다. **signed URL은 절대 저장하지 않는다**(D87 —
만료 URL 화석화 방지, 재수화는 figure_id 재발급). D94: ebs/art 제거 —
canvas에는 figures 키만 남고, 구버전 프론트의 ebs/art 키는 extra 무시로 버려진다.

여기선 (1) RetrievedBody의 figures 파싱·url 부재, (2) _patch_canvas_unified의
figures 기록, (3) retrieved=None 회귀만 함수 단위로 검증한다.
"""

import pytest

from app.routers.chat import (
    RetrievedBody,
    RetrievedFigureItem,
    _patch_canvas_unified,
)

# ---------------------------------------------------------------------------
# RetrievedBody / figures 파싱
# ---------------------------------------------------------------------------


def test_retrieved_body_parses_figures():
    """figures 항목이 파싱되고 model_dump 라운드트립이 값을 보존한다."""
    body = RetrievedBody.model_validate(
        {
            # 구버전 프론트 호환: ebs/art 키가 와도 extra 무시로 버려진다(D94).
            "ebs": [],
            "art": [],
            "figures": [
                {
                    "figure_id": "fig-1",
                    "file_id": "file-1",
                    "page": 3,
                    "caption": "그림 1",
                    "score": 0.9,
                },
                # page/caption 생략 → 기본값(None / "")
                {"figure_id": "fig-2", "file_id": "file-2", "score": 0.5},
            ],
        }
    )
    assert len(body.figures) == 2
    first, second = body.figures
    assert first.figure_id == "fig-1"
    assert first.file_id == "file-1"
    assert first.page == 3
    assert first.caption == "그림 1"
    assert first.score == 0.9
    assert second.page is None
    assert second.caption == ""
    assert first.model_dump() == {
        "figure_id": "fig-1",
        "file_id": "file-1",
        "page": 3,
        "caption": "그림 1",
        "score": 0.9,
    }


def test_retrieved_figure_item_has_no_url_field():
    """D87: figure 항목에 url 필드가 없다 — 만료 URL 영속 금지, figure_id 재수화."""
    assert "url" not in RetrievedFigureItem.model_fields
    # 프론트가 url을 실어 보내도 extra 무시(기존 모델 설정)로 저장되지 않는다.
    item = RetrievedFigureItem.model_validate(
        {
            "figure_id": "f",
            "file_id": "x",
            "score": 0.1,
            "url": "https://signed/expiring",
        }
    )
    assert not hasattr(item, "url")
    assert "url" not in item.model_dump()


def test_retrieved_body_defaults_empty_figures():
    """figures 생략 시 빈 리스트 기본값."""
    body = RetrievedBody()
    assert body.figures == []


# ---------------------------------------------------------------------------
# _patch_canvas_unified — figures 기록
# ---------------------------------------------------------------------------


class _CaptureClient:
    """select는 기존 attachments를 돌려주고, update payload를 캡처한다."""

    def __init__(self, existing_attachments=None):
        self._existing = existing_attachments
        self.updated = None
        self.select_called = False

    async def select(self, table, params):
        self.select_called = True
        return [{"id": "node-1", "attachments": self._existing}]

    async def update(self, table, match, payload):
        self.updated = payload
        return None


@pytest.mark.asyncio
async def test_patch_canvas_writes_figures():
    """figures가 attachments.canvas에 기록된다(url 없음, D94: figures 키만)."""
    client = _CaptureClient(existing_attachments={})
    retrieved = RetrievedBody(
        figures=[
            RetrievedFigureItem(
                figure_id="fig-1", file_id="file-1", page=2, caption="c", score=0.8
            )
        ],
    )
    await _patch_canvas_unified(client, "node-1", retrieved)

    canvas = client.updated["attachments"]["canvas"]
    assert canvas["figures"] == [
        {
            "figure_id": "fig-1",
            "file_id": "file-1",
            "page": 2,
            "caption": "c",
            "score": 0.8,
        }
    ]
    # D94: canvas에는 figures 키만 남는다.
    assert set(canvas.keys()) == {"figures"}
    # D87: 저장된 figure 어디에도 url 키가 없다.
    assert "url" not in canvas["figures"][0]


@pytest.mark.asyncio
async def test_patch_canvas_empty_figures_key_present():
    """figures 빈 리스트여도 키는 항상 기록된다."""
    client = _CaptureClient(existing_attachments={})
    await _patch_canvas_unified(client, "node-1", RetrievedBody())
    canvas = client.updated["attachments"]["canvas"]
    assert canvas["figures"] == []


@pytest.mark.asyncio
async def test_patch_canvas_none_retrieved_is_noop():
    """retrieved=None이면 select/update 모두 하지 않음(기존 동작 불변 — 회귀)."""
    client = _CaptureClient()
    await _patch_canvas_unified(client, "node-1", None)
    assert client.updated is None
    assert client.select_called is False
