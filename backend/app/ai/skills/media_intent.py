"""추천 의도 선언 스킬 — 설명과 곁들이를 가른다 (D210 7-1).

## 왜 스킬인가

교과서 도판·강의 클립은 개념 카드가 나온 턴이면 자동으로 곁들여진다(D163).
그런데 학생의 말은 셋으로 갈린다:

    A "지진을 **이미지랑 같이** 설명해줘"  설명 + 곁들이 (반드시)
    B "이미지만 추천해줘" / "영상 추천해줘"  설명 없이 자료만
    C B인데 고른 카드가 없다                자료만, 화면 가운데에

B·C는 개념 카드가 없는 턴이라 D163의 규칙("카드가 나온 턴이면 곁들인다")에
**아예 안 걸린다.** 그리고 설명을 안 쓰니 생성 단계를 통째로 건너뛸 수 있어
응답이 훨씬 빠르다.

판정은 **이미 있는 도구 판단 단계에서 함께** 시킨다. 그 단계가 이미 LLM 콜을
하나 쓰므로 여기에 얹으면 왕복이 안 늘어난다. 규칙 기반 문자열 매칭은 한국어
표현이 다양해서 취약하고("영상 좀 보여줘" · "그림으로 볼 수 있을까"),
판정 전용 콜을 새로 더하면 **추천 턴이 오히려 느려진다** — 빠르게 하려고
만드는 갈래를 느리게 만드는 셈이다.

## 데이터를 건드리지 않는다

`think`와 같은 부류다 — 결과가 조회한 사실이 아니라 모델의 선언이다. 그래서
근거 블록에 싣지 않는다(`_NOT_EVIDENCE`). 오케스트레이터가 이 선언을 읽어
경로를 고른다.
"""

from __future__ import annotations

from typing import Any

from ..base import SkillBase, SkillContext, SkillResult

#: 선언 가능한 값. 여기 없는 값은 "안 부른 것"으로 친다 — 모르는 값에
#: 기본 경로를 주면 오타 하나로 설명이 통째로 사라진다.
MODES = ("with_answer", "only")


class MediaIntentSkill(SkillBase):
    name = "set_media_intent"
    description = (
        "학생이 **교과서 그림이나 강의 영상을 명시적으로 요청했을 때만** 부른다. "
        "설명과 함께 보여 달라는 요청이면 mode='with_answer', "
        "설명은 필요 없고 자료만 추천해 달라는 요청이면 mode='only'. "
        "예: '지진을 이미지랑 같이 설명해줘' → with_answer / "
        "'이미지만 추천해줘', '영상 추천해줘', '관련 영상 보여줘' → only. "
        "학생이 그림·영상을 언급하지 않았으면 이 도구를 부르지 마라. "
        "이 도구는 검색을 하지 않는다 — 검색 도구도 함께 불러야 한다."
    )
    #: ⚠️ `topic`은 있으면 좋은 값이 아니라 **이 기능이 되게 하는 값**이다.
    #: 학생의 문장을 그대로 검색어로 쓰면 "추천해줘"·"영상만" 같은 요청 표현이
    #: 임베딩을 끌고 가 거리 게이트(0.60)를 넘긴다 — 실측 2026-08-08:
    #: "지진파 영상만 추천해줘"로는 3/3 빈손, "지진파"로는 걸렸다.
    #: 요청한 학생이 빈손을 받는 것이 이 갈래에서 가장 나쁜 결과다.
    parameters = {
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": list(MODES),
                "description": "with_answer=설명과 함께 / only=자료만",
            },
            "topic": {
                "type": "string",
                "description": (
                    "학생이 **찾아 달라는 것**만. 요청 표현('추천해줘', '만', "
                    "'보여줘', '영상으로')은 빼고 주제어만 적는다. "
                    "예: '지진파 영상만 추천해줘' → '지진파'"
                ),
            },
            "kinds": {
                "type": "array",
                "items": {"type": "string", "enum": ["figure", "clip"]},
                "description": (
                    "학생이 콕 집어 말한 종류. '이미지'면 figure, '영상'이면 clip. "
                    "구분 없이 '자료'라고만 했으면 비워 둔다."
                ),
            },
        },
        "required": ["mode"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        mode = (args.get("mode") or "").strip()
        if mode not in MODES:
            # 모르는 값은 되돌려 준다. 조용히 기본값을 주면 "설명해 달라"는
            # 요청이 자료만 뜨는 턴으로 바뀔 수 있다.
            return SkillResult(
                ok=False,
                message=f"mode는 {' 또는 '.join(MODES)} 중 하나여야 합니다.",
                error_code="bad_mode",
            )
        topic = (args.get("topic") or "").strip()[:100]
        raw = args.get("kinds")
        kinds = [k for k in raw if k in ("figure", "clip")] if isinstance(raw, list) else []
        label = (
            "설명과 함께 자료를 곁들입니다."
            if mode == "with_answer"
            else "설명 없이 자료만 찾습니다."
        )
        return SkillResult(
            ok=True,
            message=label,
            data={"mode": mode, "kinds": kinds, "topic": topic},
        )
