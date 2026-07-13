from app.services import gemini


def test_textbook_block_span_and_order():
    sp, blocks = gemini.compose_system_structured(
        None,
        "[연결된 자료에서 참고]\n- 파일 청크",
        None,
        textbook_context="[교과서에서 참고]\n- [중학 과학 2 · p.12] 광합성",
        textbook_sources=[{"name": "중학 과학 2", "page": 12}],
        base_instruction="base",
    )
    kinds = [b["kind"] for b in blocks]
    # textbook_rag는 rag 뒤 (스펙 3장)
    assert kinds == ["system_base", "rag", "textbook_rag"]
    tb = blocks[2]
    start, end = tb["prompt_span"]
    # D35 불변식: span이 가리키는 조각 == wrapper + raw_text
    assert sp[start:end] == gemini._WRAP_TEXTBOOK + tb["raw_text"]
    assert tb["raw_text"].startswith("[교과서에서 참고]")
    assert tb["source"] == "교과서 참고"
    assert tb["sources"] == [{"name": "중학 과학 2", "page": 12}]


def test_no_textbook_context_no_block():
    sp, blocks = gemini.compose_system_structured(None, base_instruction="base")
    assert [b["kind"] for b in blocks] == ["system_base"]
    assert "[교과서에서 참고]" not in sp


def test_existing_positional_call_unchanged():
    # 기존 호출부(위치 인자 3개 + 기존 kwargs)가 그대로 동작해야 한다
    sp, blocks = gemini.compose_system_structured(
        "참고", "자료", "비교", base_instruction="base"
    )
    assert [b["kind"] for b in blocks] == [
        "system_base", "memory_link", "rag", "comparison",
    ]
