"""이 세션의 개념 카드 조회 스킬 (D109 2단계).

기존에는 `extract_used_tags`가 매 턴 태그 목록을 뽑아 tag_guide 블록으로
무조건 주입했다. 태그 연속성(D89)을 위해서인데, 인사 턴에는 필요 없는 일이다.

두 스킬로 나눈다:
  list_session_concepts  지금까지 만든 개념의 제목·분류 목록 (태그 재사용의 근거)
  get_concept            특정 개념의 본문 (이어지는 질문에 답할 때)

개념 카드는 별도 테이블이 아니라 `nodes.answer` 원문에 줄 형식으로 들어 있다.
파싱 규약은 프론트 파서·`solar.extract_used_tags`와 같아야 한다 — "|" split의
두 번째 조각이 분류다(정규식으로 하면 개행을 넘어 다음 줄을 삼킨다, D89 하드닝).
"""

from __future__ import annotations

import logging
from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.concepts")

_CONCEPT = "@concept:"
_END_TOKENS = {"@end", "/end", "[end]", "(end)"}
# 목록이 길어지면 프롬프트만 부풀린다. 최근 것 위주로 잘라 준다.
_MAX_LIST = 40


def _parse_cards(answer: str) -> list[dict[str, Any]]:
    """answer 원문 → [{title, cluster, body}]. 형식 밖 줄은 조용히 버린다."""
    cards: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for raw in (answer or "").splitlines():
        line = raw.strip()
        if line.startswith(_CONCEPT):
            parts = line[len(_CONCEPT) :].split("|")
            cur = {
                "title": parts[0].strip(),
                "cluster": parts[1].strip() if len(parts) > 1 else "",
                "body": [],
            }
            cards.append(cur)
            continue
        if line.lower() in _END_TOKENS:
            cur = None
            continue
        if cur is not None and line.startswith("- "):
            # 강조 마커는 걷어내고 준다 — 모델이 읽을 때 잡음일 뿐이다.
            cur["body"].append(line[2:].replace("**", "").replace("==", "").strip())
    return cards


async def _session_cards(ctx: SkillContext) -> list[dict[str, Any]]:
    nodes = await ctx.client.select(
        "nodes",
        {
            "session_id": f"eq.{ctx.session_id}",
            "select": "answer,created_at",
            "order": "created_at.asc",
        },
    )
    out: list[dict[str, Any]] = []
    for n in nodes:
        out.extend(_parse_cards(n.get("answer") or ""))
    return out


class ListSessionConceptsSkill(SkillBase):
    name = "list_session_concepts"
    description = (
        "이 학습 지도에 지금까지 만든 개념 카드의 제목과 분류를 본다. "
        "새 개념의 분류를 정하기 전에 확인하면 같은 주제가 다른 태그로 흩어지는 "
        "것을 막을 수 있다. 첫 질문이거나 분류가 자명하면 부르지 않아도 된다."
    )
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        cards = await _session_cards(ctx)
        if not cards:
            return SkillResult(
                ok=True,
                message="아직 만든 개념이 없습니다. 새 분류를 지어도 됩니다.",
                data={"concepts": [], "clusters": []},
            )
        recent = cards[-_MAX_LIST:]
        clusters: list[str] = []
        for c in cards:
            cl = c["cluster"]
            if cl and cl not in clusters:
                clusters.append(cl)
        return SkillResult(
            ok=True,
            message=f"개념 {len(cards)}개, 분류 {len(clusters)}종.",
            data={
                "concepts": [
                    {"title": c["title"], "cluster": c["cluster"]} for c in recent
                ],
                # 태그 재사용의 핵심 — 이 목록에 있으면 글자 그대로 다시 쓰게 한다.
                "clusters": clusters,
            },
        )


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
            return SkillResult(
                ok=False, message="개념 제목이 필요합니다.", error_code="bad_args"
            )
        cards = await _session_cards(ctx)
        if not cards:
            return SkillResult(
                ok=True, message="아직 만든 개념이 없습니다.", data={"found": False}
            )

        # 정확 일치 → 부분 일치 순. 모델이 제목을 조금 다르게 기억할 수 있다.
        hit = next((c for c in cards if c["title"] == want), None)
        if hit is None:
            hit = next(
                (c for c in cards if want in c["title"] or c["title"] in want), None
            )
        if hit is None:
            return SkillResult(
                ok=True,
                message=f"'{want}' 개념을 찾지 못했습니다.",
                data={
                    "found": False,
                    # 헛물을 켜지 않도록 있는 제목을 알려 준다.
                    "available": [c["title"] for c in cards[-_MAX_LIST:]],
                },
            )
        return SkillResult(
            ok=True,
            message=f"'{hit['title']}' 개념을 찾았습니다.",
            data={
                "found": True,
                "title": hit["title"],
                "cluster": hit["cluster"],
                "body": hit["body"],
            },
        )
