"""프롬프트 조립 전용(D35 span 단일 소스) — Gemini API 호출 없음(D80 정리).

compose_system_structured가 시스템 프롬프트 문자열과 블록별 span 메타데이터를
한 곳에서 만들어, 저장된 프롬프트와 하이라이트 오프셋이 절대 어긋나지 않게 한다.
Gemini API 경로(OCR·라벨·태깅)는 배포 환경에 키가 없어 한 번도 동작한 적 없어
D80에서 제거했다 — 채팅 답변은 EXAONE, 임베딩·문서 파싱은 Upstage가 담당한다.
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


def compose_system_structured(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
    *,
    session_file_context: str | None = None,
    session_file_sources: list[dict] | None = None,
    rag_sources: list[dict] | None = None,
    reference_node_ids: list[str] | None = None,
    comparison_node_ids: list[str] | None = None,
    base_instruction: str | None = None,
) -> tuple[str, list[dict]]:
    """Single source of truth (D35): build the system prompt AND the per-block
    metadata (kind/order/source/raw_text/node_ids/sources/prompt_span) in one
    place, so the saved prompt and the highlight offsets can never drift.

    - `reference_context`: imported other-branch content (Stage 3a memory link).
    - `rag_context`: chunks from files linked to the branch (Stage 3b-2 RAG).
    - `comparison_context`: one-time referenced branches for comparison (D15).
    - session_file_context: 세션에 올린 학생 파일 전문(D83, TASK 3).

    Returns ``(system_prompt, blocks)`` where each block's ``prompt_span`` is the
    ``[start, end)`` char range of that part inside ``system_prompt``.
    """
    # (kind, segment_text, source, raw_text, node_ids, sources)
    parts: list[tuple[str, str, str | None, str | None, list | None, list | None]] = [
        ("system_base", base_instruction or _SYSTEM_INSTRUCTION, None, None, None, None)
    ]
    # D85: 세션 파일 전문은 턴 간 불변(파일 추가/삭제 전까지) — system_base
    # 직후 고정 배치로 Friendli 프리픽스 캐시(입력 단가·TTFT)를 살린다.
    # 턴마다 변하는 memory/rag/comparison은 뒤에 둔다.
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
    if reference_context:
        parts.append(
            (
                "memory_link",
                _WRAP_MEMORY + reference_context,
                "다른 분기 노드(기억 연결)",
                reference_context,
                reference_node_ids or None,
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
    if comparison_context:
        parts.append(
            (
                "comparison",
                _WRAP_COMPARISON + comparison_context,
                "이번 질문 한정 비교 참조",
                comparison_context,
                comparison_node_ids or None,
                None,
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
