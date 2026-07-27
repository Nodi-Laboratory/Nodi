"""TASK 4 — 업로드 kind='textbook' 수용 + storage_sign(D86/D87) 테스트.

교사가 교과서(PDF)를 class 공간에 업로드하는 경로를 검증한다:
- textbook은 class_material과 동형(class 공간·교사 전용·500MB 노브 공유)이되,
  figure 파이프라인이 페이지 좌표를 전제하므로(D86) PDF 전용이다.
- storage_sign은 figure 이미지 서빙에 쓸 signed URL 발급 프리미티브(D87).

mock 방식은 test_upload_whitelist.py / test_rpc_void.py 패턴을 그대로 따른다.
"""


import pytest
from fastapi import HTTPException

from app.services import files as F

MB = 1024 * 1024


# --- files.upload_file(kind='textbook') -------------------------------------


class _FakeService:
    def __init__(self):
        self.storage = []
        self.inserted = []

    async def storage_upload(self, bucket, path, data, mime):
        self.storage.append(path)

    async def insert(self, table, row, returning=True):
        self.inserted.append((table, row))
        return [dict(row)] if returning and isinstance(row, dict) else None


class _FakeUserClient:
    """rpc(is_class_teacher)와 select(class_members)를 흉내낸다.

    is_teacher=False면 교사 검증(_assert_class_teacher)이 403을 던진다.
    """

    def __init__(self, is_teacher=True):
        self._is_teacher = is_teacher

    async def select(self, *a, **k):
        return [{"class_id": "c1"}]

    async def rpc(self, *a, **k):
        return self._is_teacher


async def _fake_overlay():
    return {}


@pytest.fixture(autouse=True)
def _judge_configured(monkeypatch):
    """D93: 교과서 업로드는 figure 판정(VLM) 설정이 필수 — 기본 테스트는 설정된
    상태로 두고, 미설정 거부는 전용 테스트가 개별적으로 덮어쓴다.

    D97: 게이트가 `missing_config()`(빠진 키 목록)를 보도록 바뀌었다 — 빈
    리스트가 '전부 설정됨'이다.
    """
    monkeypatch.setattr(F.figure_judge, "missing_config", lambda: [])


async def _upload(svc, user, name, *, space_kind="class", space_ref="c1", mime=None):
    return await F.upload_file(
        svc, user, "t1", space_kind, space_ref, name, mime, b"data", kind="textbook"
    )


@pytest.mark.asyncio
async def test_textbook_upload_allowed_without_judge(monkeypatch):
    """D103: 판정 미설정이어도 교과서 업로드는 통과한다.

    캡션 확정에 파서 라벨(caption/footnote) 경로가 생겨서 판정이 유일한 출처가
    아니다. 판정은 라벨 없는 figure를 건지는 폴백일 뿐이므로, 미설정을 이유로
    업로드 자체를 막으면 멀쩡히 처리될 figure까지 잃는다. (D93에서는 판정이
    유일한 출처라 503으로 막았다 — 그 전제가 깨졌다.)
    """
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    monkeypatch.setattr(
        F.figure_judge, "missing_config", lambda: ["JUDGE_API_KEY", "JUDGE_BASE_URL"]
    )
    svc = _FakeService()
    row = await _upload(svc, _FakeUserClient(is_teacher=True), "book.pdf")
    assert row["kind"] == "textbook"
    assert row["status"] == "uploaded"
    assert svc.storage and svc.inserted  # 저장·DB 쓰기까지 정상 진행


@pytest.mark.asyncio
async def test_judge_unconfigured_other_kinds_unaffected(monkeypatch):
    """class_material 업로드는 예나 지금이나 판정 설정과 무관하다."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    monkeypatch.setattr(F.figure_judge, "missing_config", lambda: ["JUDGE_API_KEY"])
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(is_teacher=True), "t1", "class", "c1",
        "notes.pdf", None, b"data", kind="class_material",
    )
    assert row["status"] == "uploaded"


@pytest.mark.asyncio
async def test_textbook_pdf_teacher_class_ok(monkeypatch):
    """textbook + PDF + class + 교사 → 성공(files 행 kind='textbook', split 잡 생성)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    row = await _upload(svc, _FakeUserClient(is_teacher=True), "book.pdf")
    assert row["kind"] == "textbook"
    assert row["status"] == "uploaded"
    assert row["space_kind"] == "class"
    assert len(svc.storage) == 1
    # embedding_split 잡 큐잉 유지(워커 분기는 task4-6, 여기선 잡만 확인).
    split = [r for t, r in svc.inserted if t == "jobs"]
    assert split and split[0]["kind"] == "embedding_split"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["scan.png", "notes.txt", "figure.jpg", "memo.md"])
async def test_textbook_non_pdf_rejected_422(monkeypatch, name):
    """textbook + 비PDF → 422(figure 파이프라인은 PDF 페이지 좌표 전제, D86)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await _upload(svc, _FakeUserClient(is_teacher=True), name)
    assert ei.value.status_code == 422
    assert "교과서" in ei.value.detail and "PDF" in ei.value.detail
    assert svc.storage == []


@pytest.mark.asyncio
async def test_textbook_personal_space_rejected_422(monkeypatch):
    """textbook + personal 공간 → 422(class 공간 전용)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await _upload(
            svc, _FakeUserClient(is_teacher=True), "book.pdf",
            space_kind="personal", space_ref=None,
        )
    assert ei.value.status_code == 422
    assert svc.storage == []


@pytest.mark.asyncio
async def test_textbook_non_teacher_rejected_403(monkeypatch):
    """textbook + 학생(비교사) → 403(class_material 거부와 동형)."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    svc = _FakeService()
    with pytest.raises(HTTPException) as ei:
        await _upload(svc, _FakeUserClient(is_teacher=False), "book.pdf")
    assert ei.value.status_code == 403
    assert svc.storage == []


def test_textbook_resolve_uses_class_material_limit():
    """textbook 상한은 class_material_max_bytes(500MB)를 공유 — 신규 노브 없음."""
    assert F.resolve_upload_max_bytes({}, "textbook") == 500 * MB
    assert F.resolve_upload_max_bytes({}, "textbook") != 50 * MB


@pytest.mark.asyncio
async def test_textbook_rides_larger_limit(monkeypatch):
    """경계 — textbook은 file_max_bytes(학생 50MB)를 넘어도 자기 상한 이내면 통과."""
    monkeypatch.setattr(F.app_settings, "get_overlay", _fake_overlay)
    monkeypatch.setattr(F.settings, "file_max_bytes", 2048)
    svc = _FakeService()
    row = await F.upload_file(
        svc, _FakeUserClient(is_teacher=True), "t1", "class", "c1",
        "book.pdf", None, b"\0" * 4096, kind="textbook",
    )
    assert row["status"] == "uploaded"
    assert len(svc.storage) == 1



