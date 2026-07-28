"""프롬프트 조립 전용(D35 span 단일 소스) — Gemini API 호출 없음(D80 정리).

compose_system_structured가 시스템 프롬프트 문자열과 블록별 span 메타데이터를
한 곳에서 만들어, 저장된 프롬프트와 하이라이트 오프셋이 절대 어긋나지 않게 한다.
Gemini API 경로(OCR·라벨·태깅)는 배포 환경에 키가 없어 한 번도 동작한 적 없어
D80에서 제거했다 — D108 이후 채팅·임베딩·문서 파싱이 전부 Upstage다.
"""

from __future__ import annotations

# A system instruction kept deliberately generic: nodi's AI is a general
# conversational assistant; the tree is only a UX layer (no topic restriction).
_SYSTEM_INSTRUCTION = (
    "You are nodi's assistant, a helpful general-purpose conversational AI. "
    "Answer the user's latest message using the prior conversation as context. "
    "Respond in the user's language."
)


# Per-block instruction wrappers. The wrapper text + its context together form
# one prompt "part"; parts are joined with "\n\n". Keeping the exact strings in
# one place lets compose_system_structured() report each part's char span (D35).
_WRAP_MEMORY = (
    "아래는 사용자가 다른 대화 분기에서 끌어온 참고 자료입니다. 현재 분기 "
    "대화와 출처를 구분해 활용하되, 답변에 자연스럽게 반영하세요. 현재 "
    "분기에서 실제로 오간 대화가 아님에 유의하세요.\n\n"
)
_WRAP_RAG = (
    "아래는 사용자가 이 분기에 연결한 자료에서 검색된 내용입니다. 질문과 "
    "관련된 근거로 우선 활용하고, 자료에 없는 내용은 일반 지식으로 보완하되 "
    "출처를 구분하세요.\n\n"
)
_WRAP_COMPARISON = (
    "아래는 사용자가 이번 질문에서만 비교 목적으로 참조한 다른 분기들의 "
    "내용입니다. 현재 분기와 비교/대조해 답하되, 출처를 구분하세요.\n\n"
)
_WRAP_SESSION_FILES = (
    "아래는 사용자가 이 세션에 올린 파일의 전문입니다. 질문과 관련된 근거로 "
    "우선 활용하고, 파일에 없는 내용은 일반 지식으로 보완하되 출처를 "
    "구분하세요.\n\n"
)
_WRAP_TAGS = (
    "[지금까지 사용한 분류]\n"
    "아래는 이 학습 지도에서 이미 사용된 개념 카드 분류 태그 목록입니다. 새 "
    "개념이 아래 태그 중 하나와 같은 주제면 그 태그를 글자 그대로 재사용하고, "
    "없을 때만 새 태그를 만드세요.\n\n"
)


def compose_system_structured(
    rag_context: str | None = None,
    *,
    session_file_context: str | None = None,
    session_file_sources: list[dict] | None = None,
    tag_context: str | None = None,
    rag_sources: list[dict] | None = None,
    base_instruction: str | None = None,
) -> tuple[str, list[dict]]:
    """Single source of truth (D35): build the system prompt AND the per-block
    metadata (kind/order/source/raw_text/node_ids/sources/prompt_span) in one
    place, so the saved prompt and the highlight offsets can never drift.

    - `rag_context`: chunks from files linked to the branch (Stage 3b-2 RAG).
    - session_file_context: 세션에 올린 학생 파일 전문(D83, TASK 3).
    - tag_context: 이 세션에서 이미 쓰인 분류 태그 목록 문자열(D89, TASK 5).

    Returns ``(system_prompt, blocks)`` where each block's ``prompt_span`` is the
    ``[start, end)`` char range of that part inside ``system_prompt``.
    """
    # (kind, segment_text, source, raw_text, node_ids, sources)
    parts: list[tuple[str, str, str | None, str | None, list | None, list | None]] = [
        ("system_base", base_instruction or _SYSTEM_INSTRUCTION, None, None, None, None)
    ]
    # D85: 세션 파일 전문은 턴 간 불변(파일 추가/삭제 전까지) — system_base
    # 직후 고정 배치로 Friendli 프리픽스 캐시(입력 단가·TTFT)를 살린다.
    # 턴마다 변하는 rag는 뒤에 둔다.
    if session_file_context:
        parts.append(
            (
                "session_files",
                _WRAP_SESSION_FILES + session_file_context,
                "세션에 올린 파일",
                session_file_context,
                None,
                session_file_sources or [],
            )
        )
    # D89: 태그 연속성 블록. D85 프리픽스 캐시는 system_base+session_files의 턴 간
    # 불변 프리픽스로 성립하는데, tag_guide는 세션 태그가 쌓일수록 턴마다 변하므로
    # 그 프리픽스 뒤, 턴 가변 블록(rag)의 앞에 둔다.
    if tag_context:
        parts.append(
            (
                "tag_guide",
                _WRAP_TAGS + tag_context,
                "분류 태그 연속성",
                tag_context,
                None,
                None,
            )
        )
    if rag_context:
        parts.append(
            (
                "rag",
                _WRAP_RAG + rag_context,
                "이 분기에 연결한 자료",
                rag_context,
                None,
                rag_sources or [],
            )
        )

    system_prompt = "\n\n".join(p[1] for p in parts)

    blocks: list[dict] = []
    cursor = 0
    sep = len("\n\n")
    for order, (kind, seg, source, raw_text, node_ids, sources) in enumerate(parts):
        start = cursor
        end = start + len(seg)
        block: dict = {"kind": kind, "order": order, "prompt_span": [start, end]}
        if source:
            block["source"] = source
        if raw_text:
            block["raw_text"] = raw_text
        if node_ids:
            block["node_ids"] = node_ids
        if sources is not None:
            block["sources"] = sources
        blocks.append(block)
        cursor = end + sep
    return system_prompt, blocks
