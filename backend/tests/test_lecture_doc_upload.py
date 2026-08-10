"""파싱 파일 일괄 업로드 (2026-08-10).

대회 규정상 제품 안에서 해외 모델을 못 쓴다. EBS 파싱과 전사는 저장소 밖
오프라인 스크립트가 끝내고, 관리자는 그 결과 JSON을 **여러 개 한 번에** 끌어다
놓는다. 서버가 하는 일은 읽어서 넣기다.

고정하는 계약 다섯:
  1. **믿지 않고 검사한다** — 형식이 어긋난 파일이 반쯤 들어가는 것이 가장 나쁘다.
  2. `page_url`은 http(s)만 — 화면에서 `<a href>`로 렌더된다(D149).
  3. 시간 구간이 뒤집힌 챕터는 거절한다 — 통과시키면 학생에게 엉뚱한 지점이
     추천되는데, 그 결과는 그럴싸해서 아무도 못 잡는다.
  4. 한 파일이 틀려도 **나머지는 들어간다** — 폴더째 올리는 흐름이라 전부
     되돌리면 어느 것이 문제인지 모른 채 처음부터 해야 한다.
  5. 하나도 못 받았으면 **성공으로 끝내지 않는다** — 화면이 "됐다"로 읽으면
     관리자가 빈 패키지를 학급에 켠다.
"""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from app.routers import admin

aio = pytest.mark.asyncio


def _doc(**over) -> bytes:
    base = {
        "source": "ebs",
        "title": "빛의 굴절 1강",
        "page_url": "https://www.ebsi.co.kr/lecture/1",
        "chapters": [
            {"start_sec": 0, "end_sec": 60, "title": "여는 말", "transcript": "안녕하세요"},
            {"start_sec": 60, "end_sec": None, "title": "굴절", "transcript": "빛이 꺾입니다"},
        ],
    }
    base.update(over)
    return json.dumps(base, ensure_ascii=False).encode("utf-8")


def test_정상_파일은_클립까지_편다():
    out = admin._parse_lecture_doc("a.json", _doc())
    assert out["title"] == "빛의 굴절 1강"
    assert [c["seq"] for c in out["clips"]] == [0, 1]
    assert out["clips"][0]["end_sec"] == 60
    assert out["clips"][1]["end_sec"] is None
    assert all(c["status"] == "pending" for c in out["clips"])


@pytest.mark.parametrize(
    "over",
    [
        {"title": ""},
        {"page_url": "javascript:alert(1)"},  # 학생이 누르면 스크립트가 돈다
        {"page_url": "ebsi.co.kr/lecture/1"},  # 스킴 없음
        {"chapters": []},
        {"chapters": [{"start_sec": 0, "title": ""}]},
        {"chapters": [{"start_sec": 90, "end_sec": 30, "title": "뒤집힘"}]},
        {"chapters": [{"start_sec": "처음", "title": "숫자가 아님"}]},
    ],
)
def test_어긋난_파일은_사유와_함께_거절한다(over):
    with pytest.raises(HTTPException) as e:
        admin._parse_lecture_doc("bad.json", _doc(**over))
    assert e.value.status_code == 422
    assert "bad.json" in str(e.value.detail)  # 어느 파일인지 말해 준다


def test_JSON이_아니면_거절한다():
    with pytest.raises(HTTPException):
        admin._parse_lecture_doc("x.json", "이건 JSON이 아니다".encode())


def test_너무_큰_파일은_거절한다():
    with pytest.raises(HTTPException):
        admin._parse_lecture_doc("big.json", b"x" * (admin._LECTURE_DOC_MAX + 1))


class _Up:
    """UploadFile 대역 — 이름과 바이트만 있으면 된다."""

    def __init__(self, filename: str, data: bytes):
        self.filename = filename
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _Client:
    def __init__(self):
        self.rows: list[dict] = []

    async def insert(self, table: str, row, returning=True):
        self.rows.append({"table": table, "row": row})
        return {"id": f"v{len(self.rows)}", **(row if isinstance(row, dict) else {})}


class _Svc(_Client):
    pass


@aio
async def test_하나가_틀려도_나머지는_들어간다(monkeypatch):
    client, svc = _Client(), _Svc()
    fake = type("U", (), {"from_user": staticmethod(lambda u: client)})
    monkeypatch.setattr(admin, "UserClient", fake)
    monkeypatch.setattr(admin, "get_service_client", lambda: svc)

    out = await admin.upload_lecture_docs(
        package_id="p1",
        files=[_Up("good.json", _doc()), _Up("bad.json", b"{}")],
        user=type("U", (), {"id": "u1"})(),
        _=None,
    )
    assert len(out["added"]) == 1
    assert out["skipped"][0]["file"] == "bad.json"
    # 클립 행과 임베딩 잡이 함께 나갔다.
    tables = [r["table"] for r in svc.rows]
    assert "lecture_clips" in tables and "jobs" in tables


@aio
async def test_하나도_못_받으면_실패로_끝낸다(monkeypatch):
    client, svc = _Client(), _Svc()
    fake = type("U", (), {"from_user": staticmethod(lambda u: client)})
    monkeypatch.setattr(admin, "UserClient", fake)
    monkeypatch.setattr(admin, "get_service_client", lambda: svc)

    with pytest.raises(HTTPException) as e:
        await admin.upload_lecture_docs(
            package_id="p1",
            files=[_Up("bad.json", b"nope")],
            user=type("U", (), {"id": "u1"})(),
            _=None,
        )
    assert e.value.status_code == 422
