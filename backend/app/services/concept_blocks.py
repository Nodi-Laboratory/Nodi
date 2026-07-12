"""@concept 블록 파서 — 답변 전문에서 개념 블록을 추출.

프론트 conceptParser.ts의 정규식 의미와 일치:
  CONCEPT_RE: "^@concept:\\s*(.*)$"
  RELATED_RE: "^@related:\\s*(.*)$"
  @end 라인이 블록을 닫음. @end 없이 다음 @concept이 오면 자동으로 닫힘.

출력: [{index: int, title: str, body: str}]
  body = "- " 본문 라인들을 "\n" 조인, **bold** / ==highlight== 마크업 제거.
"""

from __future__ import annotations

import re

_CONCEPT_RE = re.compile(r"^@concept:\s*(.*)$")
_BODY_RE = re.compile(r"^-\s+(.*)$")

# 마크업 제거: **...** → ... , ==...== → ...
_MARKUP_RE = re.compile(r"\*\*|==")


def _strip_markup(text: str) -> str:
    """** 와 == 마크업 기호를 제거한다 (내용은 보존)."""
    return _MARKUP_RE.sub("", text)


def parse(answer: str) -> list[dict]:
    """답변 전문 파싱 → [{index, title, body}].

    @concept: 제목 | 분류 ~ @end 사이의 "- " 본문 라인들을 수집.
    @end 없이 다음 @concept이 오면 이전 블록을 자동으로 닫는다.
    """
    blocks: list[dict] = []
    current_title: str | None = None
    current_lines: list[str] = []

    def _flush():
        nonlocal current_title, current_lines
        if current_title is not None:
            body = _strip_markup("\n".join(current_lines))
            blocks.append({
                "index": len(blocks),
                "title": current_title,
                "body": body,
            })
        current_title = None
        current_lines = []

    for raw_line in answer.splitlines():
        line = raw_line.rstrip()

        # @concept 시작 감지
        cm = _CONCEPT_RE.match(line)
        if cm:
            _flush()  # 이전 블록 자동 닫기 (@end 없이 다음 @concept 내성)
            parts = cm.group(1).split("|")
            current_title = parts[0].strip()
            current_lines = []
            continue

        # @end 종료
        if line.strip() == "@end":
            _flush()
            continue

        # 본문 라인 ("- " 으로 시작)
        if current_title is not None:
            bm = _BODY_RE.match(line)
            if bm:
                current_lines.append(bm.group(1).strip())

    # 파일 끝: 열려 있는 블록 닫기
    _flush()

    return blocks
