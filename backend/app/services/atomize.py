"""원자 질문 생성 프롬프트·파서 (TASK 6, D129) — PIKE-RAG atom_prompt_ko 이식.

청크 하나에서 "이 청크로 답할 수 있는 핵심 질문 n개"를 뽑는다. 질문은
embedding-passage로 임베딩되어 chunk_atoms 컬렉션에 들어가고, 학생 질의
(embedding-query)와 질문↔질문 매칭으로 검색 재현율을 높인다.

순수 함수만 둔다 — solar 호출·DB는 워커(worker/atoms.py)가 한다.
"""
from __future__ import annotations

import re

_SYSTEM = "당신은 글의 내용을 정확히 이해하고 좋은 질문을 만드는 한국어 AI 도우미입니다."

# 줄머리 번호·기호 제거: "1.", "1)", "①", "-", "*", "·" 등.
_LEAD_RE = re.compile(r"^\s*(?:[-*·•]|\(?\d{1,2}[.)]|[①-⑳])\s*")


def build_atom_messages(chunk_text: str, n: int) -> list[dict]:
    """PIKE atom_question_tagging_ko_template 이식 — 개체명 포함·지시대명사 금지."""
    user = (
        "# 과제\n"
        f"아래 내용으로 답할 수 있는 가장 핵심적인 질문 {n}개만 뽑아내세요. "
        "서로 다른 내용으로, 중복·유사 질문은 피하세요.\n"
        "각 질문에는 필요한 고유명사·용어를 포함하고, "
        "'그것/이것/그 사람' 같은 지시대명사는 쓰지 마세요.\n\n"
        "# 출력 형식\n"
        "질문을 한 줄에 하나씩, 번호나 기호 없이 출력하세요.\n\n"
        f"# 내용\n{chunk_text}\n\n# 출력:"
    )
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]


def parse_atom_questions(content: str, max_n: int) -> list[str]:
    """줄 단위 파싱 — 번호·기호 제거, 빈 줄·중복 제거, max_n 절단."""
    out: list[str] = []
    seen: set[str] = set()
    for line in (content or "").splitlines():
        q = _LEAD_RE.sub("", line).strip()
        if not q or q in seen:
            continue
        seen.add(q)
        out.append(q)
        if len(out) >= max_n:
            break
    return out
