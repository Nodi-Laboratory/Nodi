"""D88·D121 — figure_judge 비전 계열 공용 인프라 테스트.

D121로 판정(선택) 로직이 제거되고 남은 것: 설정 게이트(is_configured/
missing_config, D97)와 image_data_uri. 외부 호출 없음.

D97: judge_base_url의 기본값이 제거되면서(과거 기본값은 실제 운영 호스트를
가리켰다) 이 모듈은 주변 환경의 `.env`에 의존하지 않도록 자체 더미 주소를
세운다 — `.env` 없는 CI에서도 동일하게 돈다.
"""

import pytest

from app.services import figure_judge as FJ


@pytest.fixture(autouse=True)
def _judge_endpoint(monkeypatch):
    """모든 테스트에 더미 판정 엔드포인트를 세운다 (D97).

    설정 검증 테스트는 본문에서 이 값을 다시 덮어쓴다 — autouse가 먼저 돌고
    테스트 본문의 setattr이 나중에 적용되므로 충돌하지 않는다.
    """
    monkeypatch.setattr(FJ.settings, "judge_base_url", "http://judge.test/v1")
    monkeypatch.setattr(FJ.settings, "judge_model", "EXAONE-4.5-33B")


# --- image_data_uri ---------------------------------------------------------

def test_image_data_uri_maps_mime_by_ext():
    """확장자별 mime 매핑(jpg→jpeg, png, webp)."""
    assert FJ.image_data_uri(b"\xff\xd8\xff", "jpg").startswith("data:image/jpeg;base64,")
    assert FJ.image_data_uri(b"\x89PNG", "png").startswith("data:image/png;base64,")
    assert FJ.image_data_uri(b"RIFF", "webp").startswith("data:image/webp;base64,")


# --- is_configured / missing_config (D97) ------------------------------------

def _set_judge(monkeypatch, *, key: str, base_url: str, model: str = "m") -> None:
    monkeypatch.setattr(FJ.settings, "judge_api_key", key)
    monkeypatch.setattr(FJ.settings, "judge_base_url", base_url)
    monkeypatch.setattr(FJ.settings, "judge_model", model)


def test_is_configured_false_when_key_empty(monkeypatch):
    _set_judge(monkeypatch, key="", base_url="http://j/v1")
    assert FJ.is_configured() is False
    assert FJ.missing_config() == ["JUDGE_API_KEY"]


def test_is_configured_false_when_base_url_empty(monkeypatch):
    """D97: base_url 기본값 제거 — 키만 있고 주소가 없으면 호출 불가다.

    과거에는 키 하나만 봐서 True였고, 그 결과 교과서 업로드 게이트가 열린 뒤
    판정만 전량 실패했다(figure는 D88로 files.status와 격리 → 조용한 전멸).
    """
    _set_judge(monkeypatch, key="secret", base_url="")
    assert FJ.is_configured() is False
    assert FJ.missing_config() == ["JUDGE_BASE_URL"]


def test_is_configured_false_when_model_empty(monkeypatch):
    _set_judge(monkeypatch, key="secret", base_url="http://j/v1", model="")
    assert FJ.is_configured() is False
    assert FJ.missing_config() == ["JUDGE_MODEL"]


def test_missing_config_reports_every_gap(monkeypatch):
    """503 사유 메시지가 빠진 항목을 전부 나열할 수 있어야 한다."""
    _set_judge(monkeypatch, key="", base_url="", model="")
    assert FJ.missing_config() == ["JUDGE_API_KEY", "JUDGE_BASE_URL", "JUDGE_MODEL"]


def test_missing_config_treats_whitespace_as_empty(monkeypatch):
    """공백만 든 값은 미설정 — .env 편집 실수(`JUDGE_API_KEY= `)를 잡는다."""
    _set_judge(monkeypatch, key="   ", base_url="http://j/v1")
    assert FJ.is_configured() is False
    assert FJ.missing_config() == ["JUDGE_API_KEY"]


def test_is_configured_true_when_all_present(monkeypatch):
    _set_judge(monkeypatch, key="rkd0520", base_url="http://j/v1", model="EXAONE")
    assert FJ.is_configured() is True
    assert FJ.missing_config() == []
