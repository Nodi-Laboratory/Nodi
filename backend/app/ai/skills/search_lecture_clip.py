"""강의 클립 추천 스킬 (D149) — search_textbook_figure 미러.

학급 워크스페이스에서 학생 질의와 맞는 EBS 강의 클립(챕터)을 찾는다. 시스템이
캔버스에 카드로 띄우므로 모델은 본문에 링크를 쓰지 않는다.
"""
from __future__ import annotations

from typing import Any

from ...services import lecture_search
from ..base import SkillBase, SkillContext, SkillResult


class SearchLectureClip(SkillBase):
    name = "search_lecture_clip"
    description = (
        "학급 강의 추천 패키지에서 학생 질문과 관련된 강의 영상 클립(챕터)을 찾는다. "
        "결과는 시스템이 캔버스에 카드로 자동으로 띄우므로, 본문 답변에 영상 링크를 "
        "직접 쓰지 마라. 개념 설명이 필요할 때 함께 호출한다."
    )
    parameters: dict[str, Any] = {
        "type": "object",
        "properties": {"query": {"type": "string",
            "description": "학생이 궁금해하는 개념/주제 (검색어)"}},
        "required": ["query"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        query = (args.get("query") or "").strip()
        if not query:
            return SkillResult(ok=False, message="검색어가 비었습니다.", error_code="bad_args")
        if ctx.space_kind != "class":
            return SkillResult(ok=False, message="개인 세션에서는 강의 추천을 쓸 수 없습니다.",
                               error_code="wrong_scope")
        items = await lecture_search.search_class_clips(ctx.client, ctx.space_ref, query)
        if not items:
            return SkillResult(ok=True, message="관련 강의 클립을 찾지 못했습니다.",
                               data={"clips": []})
        return SkillResult(
            ok=True,
            message=f"강의 클립 {len(items)}개를 찾았습니다.",
            data={"captions": [i.get("title") or "" for i in items], "clips": items},
        )
