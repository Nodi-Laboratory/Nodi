"""이 세션의 개념 카드 본문 조회 스킬 (D109 2단계 → D215 출처 교체 → D216).

  get_concept  특정 개념의 본문 (학생이 "아까 그거"라고 가리킬 때)

원래는 `list_session_concepts`가 짝으로 있었다. 2026-08-09에 걷어냈다 —
**목록은 도구가 아니라 안내로 준다**(D216, `catalog.py` 주석). 모델은 매번
`list`로 제목을 찾고 나서 `get`을 불렀는데, 그 제목은 서버가 이미 알고 있다.

## ⚠️ 출처는 `canvas_items`다 — `nodes.answer`가 아니다

원래는 `nodes.answer` 원문을 파싱했다. 그 시절에는 그것이 유일한 사본이었지만
지금은 아니다:

  · 학생이 카드 본문을 **고친다**(캔버스 편집기).
  · 분류를 바꾸고, 가지를 떼어내면 **시스템이 새 분류를 붙인다**(D211 10).
  · 카드를 **지운다.**

`nodes.answer`는 AI가 처음 쓴 글이라 이 셋 중 무엇도 안 보인다. D135가 태그에
대해 이미 같은 결론을 내렸다 — "출처는 canvas_items.tag다. nodes.answer 파싱은
학생이 직접 고친 분류를 못 본다." 그 결론이 **이 스킬에는 적용되지 않은 채**
남아 있었다.

## 그리고 본문이 통째로 비어 있었다

옛 파서는 `- `로 시작하는 줄만 본문으로 주웠다. 그때는 개념 카드가 목록이었기
때문이다. 지금 프롬프트는 **"설명을 목록으로 쪼개지 마라"**(solar.py)라 본문이
문단이다 — 실측 2026-08-09: 지금 형식의 카드에서 본문 줄 수가 **0**이었다.
`get_concept`은 "아까 그거"에 답하라고 만든 스킬인데 아무것도 못 주고 있었다.

행을 그대로 읽으면 파싱이 아예 없어진다. 개념 카드 형식을 읽는 구현이 이미
셋인데(CLAUDE.md 불변식) 여기서 하나를 **줄인다.**
"""

from __future__ import annotations

import logging
from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.concepts")

# 목록이 길어지면 프롬프트만 부풀린다. 최근 것 위주로 잘라 준다.
_MAX_LIST = 40
# 본문 한 장의 상한. 카드 하나가 프롬프트를 삼키지 않게 한다.
_MAX_BODY = 1200

_SELECT = "id,title,body,tag,seq,kind,source"


async def _session_cards(ctx: SkillContext) -> list[dict[str, Any]]:
    """이 세션의 **AI 개념 카드**를 화면 순서(seq)대로.

    도판·클립·학생 글은 뺀다 — 개념 목록에 그것들이 섞이면 모델이 "이미 있는
    개념"으로 오해한다.
    """
    rows = await ctx.client.select(
        "canvas_items",
        {
            "session_id": f"eq.{ctx.session_id}",
            "kind": "eq.concept",
            "source": "eq.ai",
            "select": _SELECT,
            "order": "seq.asc",
        },
    )
    return [r for r in rows if (r.get("title") or "").strip()]


class GetConceptSkill(SkillBase):
    name = "get_concept"
    description = (
        "이 학습 지도에서 이미 만든 개념 카드의 본문을 읽는다. "
        "학생이 '아까 그거', '앞에서 배운 것'처럼 이전 설명을 가리킬 때 쓴다."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "찾을 개념 카드의 제목(정확히 일치하지 않아도 된다)",
            }
        },
        "required": ["title"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        want = (args.get("title") or "").strip()
        if not want:
            return SkillResult(ok=False, message="개념 제목이 필요합니다.", error_code="bad_args")
        cards = await _session_cards(ctx)
        if not cards:
            return SkillResult(ok=True, message="아직 만든 개념이 없습니다.", data={"found": False})

        # 정확 일치 → 부분 일치 순. 모델이 제목을 조금 다르게 기억할 수 있다.
        hit = next((c for c in cards if c["title"] == want), None)
        if hit is None:
            hit = next((c for c in cards if want in c["title"] or c["title"] in want), None)
        if hit is None:
            return SkillResult(
                ok=True,
                message=f"'{want}'라는 개념을 찾지 못했습니다.",
                # 헛물을 켜지 않게 후보를 준다 — 없다고만 하면 다시 헤맨다.
                data={
                    "found": False,
                    "available": [c["title"] for c in cards[-_MAX_LIST:]],
                },
            )
        body = (hit.get("body") or "").strip()
        return SkillResult(
            ok=True,
            message=f"'{hit['title']}' 본문입니다.",
            data={
                "found": True,
                "title": hit["title"],
                "cluster": (hit.get("tag") or ""),
                # **학생이 고친 뒤의 글**이다 — 그것이 지금 화면에 있는 글이고,
                # 학생이 "아까 그거"라고 부르는 것도 그것이다.
                "body": body[:_MAX_BODY],
            },
        )
