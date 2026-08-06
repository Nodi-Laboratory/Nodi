"""질문 방향성 코치 (D194).

고정하는 계약:
  1. **말할 것이 없으면 말하지 않는다** — 중단이 정상 동작이다. 억지로 채우면
     이미 정의를 물은 브랜치에 "정의를 물어보세요"가 뜬다.
  2. 형식을 어기면 중단 — 반쪽짜리 문구("지금 에 대해서 만 질문하고 있어요")가
     학생에게 가는 것보다 아무 말도 안 하는 편이 낫다.
  3. 모르는 낱말은 버린다 — 모델이 '심화' 같은 것을 지어내도 학생 화면에는
     우리가 정의한 여덟 개만 뜬다.
  4. **문구에 질문 문장이 없다** — 베낄 수 있는 문장이 되는 순간 이 기능은
     반대로 작동한다(사용자 지시 2026-08-06).
"""

from __future__ import annotations

import pytest

from app.services import question_coach as qc

aio = pytest.mark.asyncio


# --- 1·2. 중단 ----------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "중단: 여덟 방향을 이미 다 물었습니다",
        "중단",
        "그냥 아무 말이나 합니다",          # 형식 없음
        "주제: 화강암\n지금: 정의",          # '다음'이 없다
        "주제: 화강암\n다음: 비교",          # '지금'이 없다
        "지금: 정의\n다음: 비교",            # 주제가 없다
    ],
)
def test_말할_것이_없으면_중단(raw):
    assert qc.parse_reply(raw) is None


def test_이미_물은_방향만_남으면_중단():
    """'정의를 물어보세요'가 정의를 물은 브랜치에 뜨면 소음이 된다."""
    got = qc.parse_reply("주제: 화강암\n지금: 정의, 원인\n다음: 정의, 원인")
    assert got is None


# --- 3. 낱말 정리 --------------------------------------------------------------


def test_아는_방향만_남긴다():
    got = qc.parse_reply("주제: 화강암\n지금: 정의, 심화, 원인\n다음: 비교, 마법")
    assert got["covered"] == ["정의", "원인"]
    assert got["suggest"] == ["비교"]


def test_구분자와_따옴표를_견딘다():
    got = qc.parse_reply("주제: 화강암\n지금: '정의' · '원인'\n다음: [비교], \"응용\"")
    assert got["covered"] == ["정의", "원인"]
    assert got["suggest"] == ["비교", "응용"]


def test_중복은_한_번만():
    got = qc.parse_reply("주제: 화강암\n지금: 정의, 정의, 원인\n다음: 비교, 비교")
    assert got["covered"] == ["정의", "원인"]
    assert got["suggest"] == ["비교"]


def test_너무_많으면_자른다():
    """말풍선 두 줄에 낱말 여덟 개가 들어가면 아무도 안 읽는다."""
    got = qc.parse_reply(
        "주제: 화강암\n지금: 정의, 원인, 비교, 과정, 응용\n다음: 예시, 근거, 한계, 정의"
    )
    assert len(got["suggest"]) <= 3
    # covered는 안 자른다 — 자르는 판단은 문구가 하고, 자른 것은 "등"으로 밝힌다.
    bubble = qc.build_bubble(got["topic"], got["covered"], got["suggest"])
    assert "등" in bubble


def test_여덟_방향이_전부다():
    """목록이 길어지면 모델이 아무거나 붙이고 뜻이 겹치는 낱말이 나란히 뜬다."""
    assert len(qc.DIRECTIONS) == 8
    assert set(qc.DIRECTIONS) >= {"정의", "원인", "비교", "과정", "응용"}


# --- 4. 문구 ------------------------------------------------------------------


def test_말풍선은_사용자_예시를_따른다():
    text = qc.build_bubble("화강암", ["정의", "원인"], ["비교", "응용"])
    assert "지금 화강암에 대해서 '정의', '원인'만 질문하고 있어요" in text
    assert "'비교', '응용'" in text
    assert "\n" in text  # 두 줄


def test_문구에_베낄_질문이_없다():
    """**이 기능의 핵심 제약이다.** 베낄 수 있는 문장이 되면 반대로 작동한다.

    말풍선이 "어떨까요?"로 끝나는 것은 **학생에게 건네는 말**이라 괜찮다.
    막아야 하는 것은 학생이 그대로 복사해 입력창에 넣을 수 있는 **주제에 대한
    질문**이다 — "화강암은 무엇인가요?" 같은 것.
    """
    bubble = qc.build_bubble("화강암", ["정의"], ["비교", "응용"])
    hint = qc.build_hint("화강암", ["비교", "응용"])

    # 입력창 문구는 명령형이다 — 물음표가 하나라도 있으면 질문을 준 것이다.
    assert "?" not in hint

    # 말풍선의 물음표는 마지막 하나(학생에게 묻는 말)뿐이어야 한다.
    assert bubble.count("?") == 1
    assert bubble.rstrip().endswith("?")

    # 어느 쪽에도 주제를 겨눈 의문사가 없어야 한다.
    for text in (bubble, hint):
        for word in ("무엇인가", "무엇일까", "왜 ", "어떻게 "):
            assert word not in text, f"{word!r}가 들어 있다: {text}"


def test_입력창_문구는_방향을_풀어_쓴다():
    text = qc.build_hint("화강암", ["비교", "응용"])
    assert "화강암" in text
    assert "비교" in text and "응용" in text
    assert "직접" in text  # 학생이 만든다는 것을 말한다


# --- 노브 ---------------------------------------------------------------------


@aio
async def test_노브가_오버레이를_탄다(monkeypatch):
    """D62 — config만 읽으면 콘솔에서 바꿔도 안 먹는다(D192에서 겪은 그것)."""

    async def overlay():
        return {"question_coach_min_cards": 7, "question_coach_enabled": False}

    monkeypatch.setattr(qc.app_settings, "get_overlay", overlay)
    got = await qc.read_knobs()
    assert got["min_cards"] == 7
    assert got["enabled"] is False


@aio
async def test_말도_안_되는_n은_clamp된다(monkeypatch):
    async def overlay():
        return {"question_coach_min_cards": 0}

    monkeypatch.setattr(qc.app_settings, "get_overlay", overlay)
    assert (await qc.read_knobs())["min_cards"] >= 1


# --- 카드 읽기 ----------------------------------------------------------------


class FakeClient:
    def __init__(self, rows):
        self.rows = rows
        self.params = None

    async def select(self, table, params):
        self.params = params
        return self.rows


@aio
async def test_카드가_없으면_모델을_안_부른다(monkeypatch):
    called = {"n": 0}

    async def ask(*a, **k):
        called["n"] += 1
        return ""

    monkeypatch.setattr(qc, "_ask", ask)
    assert await qc.analyse(FakeClient([]), ["x"], model=None) is None
    assert await qc.analyse(FakeClient([{"id": "a"}]), [], model=None) is None
    assert called["n"] == 0


@aio
async def test_본문은_서버가_다시_읽는다(monkeypatch):
    """클라이언트가 보낸 본문을 그대로 쓰면 신뢰 경계를 넘는다(D104·D178)."""

    async def ask(user_text, model):
        assert "학생 질문" in user_text
        return "주제: 화강암\n지금: 정의\n다음: 비교"

    monkeypatch.setattr(qc, "_ask", ask)
    c = FakeClient([
        {"id": "a", "title": "화강암", "body": "본문", "tag": "지질",
         "seq": 0, "data": {"askedQuestion": "화강암이 뭐야?"}},
    ])
    got = await qc.analyse(c, ["a"], model=None)
    assert got["topic"] == "화강암"
    assert "id" in c.params  # id로 좁혀 읽었다


@aio
async def test_모델이_죽어도_턴을_안_막는다(monkeypatch):
    """코치는 곁들이다 — 'RAG는 채팅을 절대 막지 않는다'와 같은 성질."""

    async def boom(*a, **k):
        raise RuntimeError("모델 죽음")

    monkeypatch.setattr(qc, "_ask", boom)
    c = FakeClient([{"id": "a", "title": "x", "body": "", "tag": None, "seq": 0, "data": {}}])
    assert await qc.analyse(c, ["a"], model=None) is None


def test_중단은_어디에_있든_이긴다():
    """실물 모델(solar-pro2)이 세 줄을 쓰고 **뒤에** 중단을 붙였다(실측 2026-08-06).

    맨 앞만 보면 그 중단을 못 보고 말풍선을 띄운다 — 사용자 규칙("모든 방향을
    물었으면 중단")이 조용히 깨진다.
    """
    raw = (
        "주제: 광합성\n지금: 정의, 원인, 과정, 비교, 응용\n다음: 예시, 근거, 한계\n\n"
        "중단: 여덟 방향을 이미 다 물었다"
    )
    assert qc.parse_reply(raw) is None


def test_자른_것을_안_자른_척하지_않는다():
    """다섯 개를 물은 학생에게 "네 개만 질문하고 있어요"라고 하면 안 된다.

    실측 2026-08-06(광합성 브랜치)에서 실제로 그랬다. 작은 거짓말이지만 학생은
    자기 카드를 안다 — 한 번 어긋나면 이 말풍선을 안 믿는다.
    """
    five = ["정의", "원인", "과정", "비교", "응용"]
    assert "등" in qc.build_bubble("광합성", five, ["예시"])
    # 다 보여 줄 수 있으면 "등"을 안 붙인다.
    assert "등" not in qc.build_bubble("광합성", ["정의", "원인"], ["비교"])


def test_콘솔이_보여주는_재발동_수가_상수를_따라간다():
    """관리자 콘솔은 노브 옆에 "재발동까지 n+3장"을 붙여 보여 준다.

    사용자 지시 2026-08-06: 콘솔이 n+3이 몇인지 보여 줘야 한다. 그 3을 스펙에
    숫자로 박아 두면 간격을 바꿀 때 **콘솔만 옛 수를 말한다** — 화면에도 로그에도
    안 드러나고, 관리자는 안 뜨는 이유를 다른 데서 찾게 된다.

    판정 자체는 프론트가 한다(`lib/canvas2/questionCoach.ts`의 REARM_GAP).
    저쪽에도 같은 수를 못 박는 테스트가 있다 — 언어가 갈려 한 곳에서 못 묶는다.
    """
    from app.services import admin_console

    spec = admin_console._SPEC_BY_KEY["question_coach_min_cards"]
    assert spec["derived"]["add"] == qc.REARM_GAP
