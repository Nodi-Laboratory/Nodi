"""교차 세션 개념 연결의 판정 로직 (D171).

여기 있는 것은 **전부 순수 함수**다. 이 기능에서 조용히 틀릴 수 있는 것들이
모여 있다 — 태그 정규화가 느슨하면 같은 과목을 "다른 과목"이라며 보여 주고,
방향 규칙이 틀리면 개인 공간의 사적인 대화가 학급으로 샌다.
"""

from app.services import crosslink

# ── 태그 정규화 ────────────────────────────────────────────────────────
#
# 태그는 세션마다 모델이 자유롭게 짓는다(D89). 표기만 다른 같은 주제가 필터를
# 통과하면 "다른 과목과 연결됐다"며 같은 과목을 보여 주게 된다.


def test_norm_tag_strips_space_and_case():
    assert crosslink.norm_tag("생명 과학") == crosslink.norm_tag("생명과학")
    assert crosslink.norm_tag(" Biology ") == crosslink.norm_tag("biology")
    assert crosslink.norm_tag("지구\t과학") == crosslink.norm_tag("지구과학")


def test_norm_tag_keeps_different_subjects_different():
    """정규화가 과하면 진짜 다른 과목까지 같아진다 — 그건 더 나쁘다."""
    assert crosslink.norm_tag("생명과학") != crosslink.norm_tag("지구과학")


def test_norm_tag_none_is_empty():
    assert crosslink.norm_tag(None) == ""
    assert crosslink.norm_tag("   ") == ""


# ── 방향 규칙 (사용자 결정 2026-08-04) ──────────────────────────────────
#
# 학급 → 개인은 되고, 개인 → 학급은 안 된다.


def test_personal_can_pull_from_both():
    assert set(crosslink.allowed_space_kinds("personal")) == {"personal", "class"}


def test_class_cannot_pull_from_personal():
    """개인 공간의 사적인 대화가 학급 맥락으로 새면 안 된다."""
    assert crosslink.allowed_space_kinds("class") == ["class"]


def test_unknown_space_kind_is_treated_as_personal():
    """모르는 값이 학급 권한을 얻으면 안 된다 — 넓은 쪽이 아니라 안전한 쪽."""
    assert "class" in crosslink.allowed_space_kinds("personal")
    assert crosslink.allowed_space_kinds("") == ["personal", "class"]


# ── 거리 띠 ────────────────────────────────────────────────────────────
#
# 상한 하나만 두면 "어제도 광합성, 오늘도 광합성"이 걸린다. 그건 융합이 아니다.


def test_band_rejects_too_close():
    """바닥 아래 = 같은 얘기. 융합이 아니라 중복이다."""
    assert not crosslink.in_band(0.05, 0.20, 0.38)


def test_band_rejects_too_far():
    assert not crosslink.in_band(0.55, 0.20, 0.38)


def test_band_accepts_middle():
    assert crosslink.in_band(0.30, 0.20, 0.38)


def test_band_is_inclusive_at_both_ends():
    assert crosslink.in_band(0.20, 0.20, 0.38)
    assert crosslink.in_band(0.38, 0.20, 0.38)


# ── 설명 파싱 ──────────────────────────────────────────────────────────


def test_no_link_marker_yields_empty():
    """모델이 "관련 없다"고 하면 링크를 만들지 않는다. 억지 연결은 없는 것보다 나쁘다."""
    assert crosslink.parse_explanation("NO_LINK") == ""
    assert crosslink.parse_explanation("  no_link  ") == ""


def test_empty_response_yields_empty():
    assert crosslink.parse_explanation("") == ""
    assert crosslink.parse_explanation("   \n ") == ""


def test_real_explanation_survives():
    text = "둘 다 에너지 흐름을 다룬다. 광합성은 빛에너지를 화학에너지로 바꾸고…"
    assert crosslink.parse_explanation(text) == text


def test_explanation_is_capped():
    assert len(crosslink.parse_explanation("가" * 5000)) == 800


# ── 임베딩 텍스트 ──────────────────────────────────────────────────────


def test_embed_text_puts_title_first():
    """제목이 주제를 가장 압축해 담는다 — 잘릴 때 남아야 하는 쪽이다."""
    out = crosslink.embed_text({"title": "광합성", "body": "빛에너지를…"})
    assert out.startswith("광합성")


def test_embed_text_without_title():
    assert crosslink.embed_text({"title": None, "body": "본문만"}) == "본문만"


def test_embed_text_empty_is_empty():
    """빈 카드는 색인하지 않는다 — 호출부가 이 빈 문자열을 보고 건너뛴다."""
    assert crosslink.embed_text({"title": "", "body": "  "}) == ""


def test_embed_text_is_capped():
    assert len(crosslink.embed_text({"title": "", "body": "나" * 9999})) == 2000


# ── 설명 프롬프트 ──────────────────────────────────────────────────────


def test_explain_prompt_carries_both_tags():
    msgs = crosslink.build_explain_messages(
        {"title": "판 구조론", "body": "지각이…", "tag": "지구과학"},
        {"title": "세포 호흡", "body": "미토콘드리아…", "tag": "생명과학"},
    )
    user = msgs[-1]["content"]
    assert "지구과학" in user and "생명과학" in user
    # 억지 연결 금지 지시가 프롬프트에 남아 있어야 한다.
    assert "NO_LINK" in msgs[0]["content"]


def test_explain_prompt_handles_missing_tag():
    msgs = crosslink.build_explain_messages(
        {"title": "가", "body": "나", "tag": None},
        {"title": "다", "body": "라", "tag": ""},
    )
    assert "(분류 없음)" in msgs[-1]["content"]


# ── 판정과 사유 (D172 관리자 로그) ──────────────────────────────────────
#
# 관리자 화면이 "왜 떨어졌는지"를 보여 주려면 판정마다 사유가 붙어야 한다.


def test_verdict_too_close_says_why():
    v, reason = crosslink.band_verdict(0.10, 0.45, 0.72)
    assert v == "too_close"
    assert "중복" in reason


def test_verdict_too_far_says_why():
    v, reason = crosslink.band_verdict(0.90, 0.45, 0.72)
    assert v == "too_far"
    assert "천장" in reason


def test_verdict_accepted_in_band():
    v, _ = crosslink.band_verdict(0.60, 0.45, 0.72)
    assert v == "accepted"


def test_always_on_bypasses_the_band():
    """상시 켜기는 **띠를 무시한다** — 테스트할 때 무조건 뜨게 하려는 노브다."""
    for d in (0.01, 0.50, 0.99):
        v, reason = crosslink.band_verdict(d, 0.45, 0.72, always_on=True)
        assert v == "accepted"
        assert "상시" in reason


def test_always_on_off_by_default():
    """기본은 꺼져 있어야 한다 — 켜 두면 '드물게'라는 성질이 사라진다."""
    v, _ = crosslink.band_verdict(0.99, 0.45, 0.72)
    assert v == "too_far"


def test_verdict_agrees_with_in_band():
    """두 표현이 어긋나면 화면과 동작이 갈린다."""
    for d in (0.0, 0.44, 0.45, 0.60, 0.72, 0.73, 1.0):
        accepted = crosslink.band_verdict(d, 0.45, 0.72)[0] == "accepted"
        assert accepted == crosslink.in_band(d, 0.45, 0.72), d
