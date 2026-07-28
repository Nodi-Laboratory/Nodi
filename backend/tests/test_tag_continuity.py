"""D89 — 태그 연속성: extract_used_tags 수집 + tag_guide 블록 주입 테스트.

세션 노드 answer의 개념 카드 분류 태그를 첫 등장 순서로 모아(solar), 시스템
프롬프트에 tag_guide 블록으로 주입(gemini)해 같은 주제 새 개념이 기존 태그를
재사용하게 한다.
"""


from app.services.solar import extract_used_tags
from app.services.gemini import _WRAP_TAGS, compose_system_structured

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
