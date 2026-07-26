"""D88 — figure_judge 비전 판정 클라이언트(labs judge.py async 이식) 테스트.

외부 호출 없음: judge_one은 httpx.MockTransport로 요청을 가로채고, judge_all은
모듈의 judge_one을 가짜로 교체(monkeypatch)해 회로차단·강등·세마포어를 검증한다.

D97: judge_base_url의 기본값이 제거되면서(과거 기본값은 실제 운영 호스트를
가리켰다) 이 모듈은 주변 환경의 `.env`에 의존하지 않도록 자체 더미 주소를
세운다 — `.env` 없는 CI에서도 동일하게 돈다.
"""

import asyncio

import httpx
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


def _ok_response(index: int, reason: str = "근거") -> httpx.Response:
    """정상 판정 응답(OpenAI 호환 chat/completions shape)."""
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "message": {
                        "content": f'{{"selected_index": {index}, "reason": "{reason}"}}'
                    },
                    "finish_reason": "stop",
                }
            ]
        },
    )


def _empty_response() -> httpx.Response:
    """content 없는 응답 — _call_judge가 ValueError를 던지게 한다."""
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": None}, "finish_reason": "length"}]},
    )


# --- parse_judgment ---------------------------------------------------------

def test_parse_judgment_normal_json():
    """정상 JSON은 selected_index·reason을 그대로 통과시킨다."""
    out = FJ.parse_judgment('{"selected_index": 1, "reason": "가깝다"}', 3)
    assert out == {"selected_index": 1, "reason": "가깝다"}


def test_parse_judgment_salvages_broken_json():
    """JSON이 깨져도 selected_index가 보이면 복구(thinking off 공백루프 잘림 e18/e38)."""
    broken = '{"selected_index": 2, "reason": "여기서 응답이 잘'
    out = FJ.parse_judgment(broken, 5)
    assert out["selected_index"] == 2
    assert "복구" in out["reason"]


def test_parse_judgment_out_of_range_becomes_minus_one():
    """범위 밖 index(n_candidates 이상)는 -1로 강등한다."""
    out = FJ.parse_judgment('{"selected_index": 9, "reason": "x"}', 3)
    assert out["selected_index"] == -1


def test_parse_judgment_totally_unparseable_raises():
    """JSON도 아니고 selected_index도 없으면 ValueError."""
    with pytest.raises(ValueError):
        FJ.parse_judgment("완전히 이상한 응답", 3)


# --- final_embed_text -------------------------------------------------------

def _record(**over) -> dict:
    base = {
        "caption": "위치기반 캡션",
        "alt": "대체텍스트",
        "description": "그림 설명",
        "heading": "단원 제목",
        "candidates": ["후보0", "후보1", "후보2"],
    }
    base.update(over)
    return base


def test_final_embed_text_uses_selected_candidate_only():
    """D93: 선택 후보 텍스트만 임베딩 — heading·alt·description 전부 제외."""
    text = FJ.final_embed_text(_record(), 1)
    assert text == "후보1"
    assert "단원 제목" not in text
    assert "대체텍스트" not in text
    assert "그림 설명" not in text


def test_final_embed_text_minus_one_returns_empty():
    """-1(해당 없음)이면 '' — 워커가 해당 행을 failed 처리한다(D93 게이트)."""
    assert FJ.final_embed_text(_record(), -1) == ""


def test_final_embed_text_out_of_range_returns_empty():
    """후보 범위 밖 index·None도 ''(방어 — 임베딩 불가 신호)."""
    assert FJ.final_embed_text(_record(), 9) == ""
    assert FJ.final_embed_text(_record(candidates=[]), 0) == ""
    assert FJ.final_embed_text(_record(), None) == ""


def test_final_embed_text_truncates_at_8000():
    """선택 후보를 8000자로 절단한다."""
    text = FJ.final_embed_text(_record(candidates=["가" * 10000]), 0)
    assert len(text) == 8000


# --- build_judge_messages ---------------------------------------------------

def test_build_judge_messages_has_image_and_numbered_candidates():
    """단일 user 턴 안에 image_url + 번호 매긴 후보 텍스트가 들어간다."""
    msgs = FJ.build_judge_messages(["첫 후보", "둘째"], "data:image/png;base64,QQ==")
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    content = msgs[0]["content"]
    assert content[0]["type"] == "image_url"
    assert content[0]["image_url"]["url"] == "data:image/png;base64,QQ=="
    text = content[1]["text"]
    assert "[0] 첫 후보" in text and "[1] 둘째" in text
    assert "교과서 편집자" in text


def test_build_judge_messages_cleans_candidate_whitespace_and_truncates():
    """_clean: 연속 공백(탭 포함) 정규화 + 200자 절단(탭 reasoning 폭주 방지 e15)."""
    dirty = "앞\t\t\t  뒤" + "가" * 500
    msgs = FJ.build_judge_messages([dirty], "data:image/png;base64,QQ==")
    text = msgs[0]["content"][1]["text"]
    assert "앞 뒤" in text  # 연속 공백/탭 → 단일 공백
    assert "\t" not in text
    # "[0] " + 200자 = 후보 본문이 200자로 잘렸는지
    line = [ln for ln in text.splitlines() if ln.startswith("[0]")][0]
    assert len(line) == len("[0] ") + 200


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


# --- judge_one (httpx MockTransport, 외부 호출 없음) ------------------------

async def test_judge_one_retries_empty_content_then_succeeds(monkeypatch):
    """빈 content(ValueError) → 1회 재시도 후 성공(labs _judge_one 규약)."""
    monkeypatch.setattr(FJ.settings, "judge_api_key", "k")
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _empty_response() if calls["n"] == 1 else _ok_response(0)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        out = await FJ.judge_one(client, ["후보0"], b"\xff\xd8\xff", "jpg")

    assert calls["n"] == 2
    assert out["selected_index"] == 0


async def test_judge_one_raises_after_two_failures(monkeypatch):
    """재시도까지 실패(빈 content 2회)면 ValueError를 던진다."""
    monkeypatch.setattr(FJ.settings, "judge_api_key", "k")
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _empty_response()

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError):
            await FJ.judge_one(client, ["후보0"], b"\xff\xd8\xff", "jpg")
    assert calls["n"] == 2


async def test_judge_one_sends_labs_request_params(monkeypatch):
    """요청 payload가 labs 파라미터(모델·max_tokens·enable_thinking False 등)를 담는다."""
    monkeypatch.setattr(FJ.settings, "judge_api_key", "secret")
    monkeypatch.setattr(FJ.settings, "judge_model", "EXAONE-4.5-33B")
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = _json.loads(request.content)
        return _ok_response(1)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await FJ.judge_one(client, ["a", "b"], b"\xff\xd8\xff", "jpg")

    assert captured["url"].endswith("/chat/completions")
    assert captured["auth"] == "Bearer secret"
    body = captured["body"]
    assert body["model"] == "EXAONE-4.5-33B"
    assert body["max_tokens"] == 512
    assert body["temperature"] == 1.0
    assert body["top_p"] == 0.95
    assert body["presence_penalty"] == 1.5
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


# --- judge_all --------------------------------------------------------------

def _item(candidates, **over) -> dict:
    base = {"candidates": list(candidates), "image_bytes": b"\xff\xd8\xff", "ext": "jpg"}
    base.update(over)
    return base


async def test_judge_all_no_candidates_skips_immediately(monkeypatch):
    """후보 없는 레코드는 호출 없이 즉시 selected_index=-1로 확정한다."""
    called = {"n": 0}

    async def fake_judge_one(*a, **k):
        called["n"] += 1
        return {"selected_index": 0, "reason": "x"}

    monkeypatch.setattr(FJ, "judge_one", fake_judge_one)
    out = await FJ.judge_all([_item([])], concurrency=2)
    assert out == [{"selected_index": -1, "reason": "후보 없음 — 판정 생략"}]
    assert called["n"] == 0


async def test_judge_all_individual_failure_returns_none(monkeypatch):
    """개별 실패는 raise하지 않고 None(워커가 judge-error로 강등)."""
    async def fake_judge_one(client, candidates, image_bytes, ext):
        if candidates[0] == "boom":
            raise RuntimeError("죽은 후보")
        return {"selected_index": 0, "reason": "ok"}

    monkeypatch.setattr(FJ, "judge_one", fake_judge_one)
    out = await FJ.judge_all(
        [_item(["ok"]), _item(["boom"]), _item(["ok"])], concurrency=1
    )
    assert out[0] == {"selected_index": 0, "reason": "ok"}
    assert out[1] is None
    assert out[2] == {"selected_index": 0, "reason": "ok"}


async def test_judge_all_circuit_breaks_after_five_consecutive_failures(monkeypatch):
    """연속 5회 실패 시 잔여 항목 판정을 생략(회로차단) — 전부 None, judge_one 5회만 호출."""
    called = {"n": 0}

    async def always_fail(*a, **k):
        called["n"] += 1
        raise RuntimeError("죽은 엔드포인트")

    monkeypatch.setattr(FJ, "judge_one", always_fail)
    items = [_item([f"c{i}"]) for i in range(8)]
    out = await FJ.judge_all(items, concurrency=1)

    assert called["n"] == FJ.CIRCUIT_BREAK_THRESHOLD == 5
    assert out == [None] * 8


async def test_judge_all_semaphore_limits_concurrency(monkeypatch):
    """세마포어가 동시 호출 수를 concurrency로 제한한다(최대 동시 관측치 확인)."""
    state = {"cur": 0, "max": 0}

    async def slow_judge_one(*a, **k):
        state["cur"] += 1
        state["max"] = max(state["max"], state["cur"])
        await asyncio.sleep(0.01)
        state["cur"] -= 1
        return {"selected_index": 0, "reason": "ok"}

    monkeypatch.setattr(FJ, "judge_one", slow_judge_one)
    items = [_item([f"c{i}"]) for i in range(6)]
    out = await FJ.judge_all(items, concurrency=2)

    assert state["max"] <= 2
    assert all(o == {"selected_index": 0, "reason": "ok"} for o in out)
