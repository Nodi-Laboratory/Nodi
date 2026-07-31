"""D89 — 태그 연속성: extract_used_tags 수집 + tag_guide 블록 주입 테스트.

세션 노드 answer의 개념 카드 분류 태그를 첫 등장 순서로 모아(solar), 시스템
프롬프트에 tag_guide 블록으로 주입(gemini)해 같은 주제 새 개념이 기존 태그를
재사용하게 한다.
"""


import pytest

from app.services import canvas_items as ci
from app.services.gemini import _WRAP_TAGS, compose_system_structured
from app.services.solar import extract_used_tags

# --- extract_used_tags -----------------------------------------------------


def _node(answer):
    return {"id": "n", "answer": answer}


def test_extract_first_appearance_order_and_dedup():
    """여러 노드 answer에서 첫 등장 순서 유지·중복 제거."""
    nodes = [
        _node("CHAT: 안녕\n@concept: 삼국의 성립 | 고대 국가의 성립\n- 본문\n@end"),
        _node(
            "@concept: 가야 토기 | 가야의 성립과 발전\n- 본문\n@end\n"
            "@concept: 고구려 고분 | 고대 국가의 성립\n- 본문\n@end"
        ),
    ]
    # 두 번째 노드의 "고대 국가의 성립"은 첫 노드에서 이미 등장 → 중복 제거.
    assert extract_used_tags(nodes) == ["고대 국가의 성립", "가야의 성립과 발전"]


def test_extract_ignores_missing_category_line():
    """`|` 없는 @concept 줄(분류 누락)은 수집하지 않는다."""
    nodes = [_node("@concept: 제목만\n- 본문\n@end")]
    assert extract_used_tags(nodes) == []


def test_extract_ignores_none_answer():
    """answer가 None이거나 키가 없는 노드는 무시(best-effort)."""
    nodes = [
        {"id": "n1"},  # answer 키 없음
        {"id": "n2", "answer": None},
        _node("@concept: 지진파 | 판 구조론\n@end"),
    ]
    assert extract_used_tags(nodes) == ["판 구조론"]


def test_extract_strips_and_drops_empty_category():
    """분류가 공백뿐이면 strip 후 빈 문자열로 제외."""
    nodes = [_node("@concept: 제목 |   ")]
    assert extract_used_tags(nodes) == []


def test_extract_empty_category_does_not_swallow_next_line():
    """분류가 빈 @concept 줄이 다음 줄(본문·@end)을 태그로 삼키지 않는다.

    구 정규식(\\s*)은 개행을 넘어 "- 본문"/"@end"를 캡처했다 — 줄 단위 처리
    하드닝의 회귀 방어(task5-1 최종 리뷰 Minor).
    """
    nodes = [
        _node("@concept: 제목 |\n- 본문 줄\n@end"),
        _node("@concept: 제목2 |\n@end"),
    ]
    assert extract_used_tags(nodes) == []


def test_extract_title_pipe_matches_frontend_parser():
    """제목에 '|'가 섞이면 프론트 파서(parts[1])와 동일하게 두 번째 조각만 태그."""
    nodes = [_node("@concept: a|b | 분류\n@end")]
    # conceptParser.ts: split("|")[1].trim() == "b" — 캔버스 그룹핑 값과 일치.
    assert extract_used_tags(nodes) == ["b"]


def test_extract_cap_truncates_to_first_tags():
    """cap 초과분은 버리고 첫 등장 cap개만 남긴다."""
    answer = "\n".join(f"@concept: t{i} | 태그{i}\n@end" for i in range(10))
    assert extract_used_tags([_node(answer)], cap=3) == ["태그0", "태그1", "태그2"]


def test_extract_empty_nodes():
    """빈 목록 → 빈 결과."""
    assert extract_used_tags([]) == []


# --- compose_system_structured: tag_guide 블록 -----------------------------


def test_tag_guide_after_session_files():
    """tag_context가 있으면 tag_guide 블록이 session_files 다음에 온다(span 정합)."""
    tags = "판 구조론, 고대 국가의 성립"
    prompt, blocks = compose_system_structured(
        None,
        session_file_context="파일 전문",
        tag_context=tags,
        base_instruction="BASE",
    )
    kinds = [b["kind"] for b in blocks]
    assert kinds == ["system_base", "session_files", "tag_guide"]
    tg = blocks[2]
    s, e = tg["prompt_span"]
    assert prompt[s:e] == _WRAP_TAGS + tags
    assert tg["raw_text"] == tags
    assert tg["source"] == "분류 태그 연속성"
    assert "sources" not in tg
    assert "node_ids" not in tg


def test_tag_guide_after_system_base_when_no_session_files():
    """session_files가 없으면 tag_guide가 system_base 직후·rag 앞."""
    tags = "이차방정식과 그래프"
    prompt, blocks = compose_system_structured(
        "rag",
        tag_context=tags,
        base_instruction="BASE",
    )
    kinds = [b["kind"] for b in blocks]
    assert kinds == ["system_base", "tag_guide", "rag"]
    s, e = blocks[1]["prompt_span"]
    assert prompt[s:e] == _WRAP_TAGS + tags


def test_tag_guide_absent_when_none_is_regression():
    """tag_context=None이면 블록 부재이고 기본 경로 출력이 기존과 동일(회귀)."""
    prompt_a, blocks_a = compose_system_structured("rag")
    prompt_b, blocks_b = compose_system_structured("rag", tag_context=None)
    assert prompt_a == prompt_b
    assert [b["kind"] for b in blocks_a] == [b["kind"] for b in blocks_b]
    assert "tag_guide" not in [b["kind"] for b in blocks_a]


# --- D135: 태그 출처를 canvas_items로 --------------------------------------
#
# 이 절이 지키는 것은 하나다 — **태그 목록 주입은 보장이지 권유가 아니다.**
# D109에서 ReAct로 옮기며 `list_session_concepts` 스킬이 대신한다고 보고 주입을
# 껐는데, 그 스킬은 모델이 부를지 정하는 선택지라 실제로는 거의 불리지 않았다.
# 결과(실측 2026-07-31): 개념 18개가 태그 10종으로 흩어져 열당 1.5~1.8개 —
# "태그끼리 묶는다"가 작동하지 않았다.

aio = pytest.mark.asyncio


class _TagClient:
    """canvas_items.select만 흉내 내는 대역."""

    def __init__(self, rows):
        self.rows = rows
        self.params: dict | None = None

    async def select(self, table, params):
        assert table == "canvas_items"
        self.params = params
        return self.rows


@aio
async def test_session_tags_첫등장순서_중복제거():
    c = _TagClient(
        [
            {"tag": "지구과학", "seq": 0},
            {"tag": "생명과학", "seq": 1},
            {"tag": "지구과학", "seq": 2},  # 중복
            {"tag": "화학", "seq": 3},
        ]
    )
    assert await ci.session_tags(c, "s1") == ["지구과학", "생명과학", "화학"]
    # seq 오름차순으로 읽어야 "첫 등장 순서"가 성립한다.
    assert c.params["order"] == "seq.asc"
    # **DB 필터로 거르지 않는다.** 이 클라이언트는 `is.null`만 알고
    # `not.is.null`은 UnsupportedQuery로 죽는다 — 그 예외가 조용히 삼켜져
    # "태그가 주입되는 줄 알았는데 아니었던" 상태로 한참 갔다.
    assert "tag" not in c.params


@aio
async def test_session_tags_태그_없는_행은_파이썬에서_거른다():
    """학생 메모(tag=None)가 섞여 와도 결과에 들어가지 않는다."""
    c = _TagClient(
        [
            {"tag": None, "seq": 0},
            {"tag": "지구과학", "seq": 1},
            {"tag": None, "seq": 2},
        ]
    )
    assert await ci.session_tags(c, "s1") == ["지구과학"]


@aio
async def test_session_tags_공백만_있는_태그는_버린다():
    c = _TagClient([{"tag": "  ", "seq": 0}, {"tag": " 물리 ", "seq": 1}])
    assert await ci.session_tags(c, "s1") == ["물리"]


@aio
async def test_session_tags_상한():
    c = _TagClient([{"tag": f"t{i}", "seq": i} for i in range(100)])
    assert len(await ci.session_tags(c, "s1", cap=5)) == 5


@aio
async def test_session_tags_학생이_고친_분류를_반영한다():
    """**nodes.answer 파싱으로는 못 보던 것.**

    학생이 ⋯ 메뉴로 "생명과학 기초"를 "생명과학"으로 바꾸면 canvas_items에만
    반영된다. 옛 경로(extract_used_tags)는 노드 본문을 읽으므로 계속 옛 태그를
    돌려주고, 모델은 사라진 분류를 다시 만들어 낸다.
    """
    nodes = [_node("@concept: 광합성 | 생명과학 기초\n- 본문\n@end")]
    assert extract_used_tags(nodes) == ["생명과학 기초"]

    edited = _TagClient([{"tag": "생명과학", "seq": 0}])
    assert await ci.session_tags(edited, "s1") == ["생명과학"]
