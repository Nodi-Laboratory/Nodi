"""스코프별 도구 카탈로그 — "필요한 도구만"의 1층 (D109).

선택은 두 층으로 나뉜다:

  **층 1 (여기)** 서버가 카탈로그를 좁힌다. 이 세션에서 **쓸 수 없는** 도구를
                 애초에 보여주지 않는다.
  **층 2**       좁혀진 목록에서 모델이 고른다. 인사에는 아무것도 안 고른다
                 (실측 확인, 2026-07-28).

층 1이 왜 필요한가 — 개인 세션에서 `search_class_material`을 노출하면 모델이
그걸 부르고, 빈 결과를 받고, "자료를 찾을 수 없다"는 엉뚱한 답을 한다. 없는
도구는 보여주지 않는 게 가장 확실한 방어다. 토큰도 아낀다(카탈로그는 매 턴
프롬프트에 들어간다).

층 3은 스킬 안에 있다 — 모든 DB 접근이 호출자 스코프 UserClient를 거치므로
RLS가 최종 방어선이다. 카탈로그를 뚫어도 남의 데이터는 못 읽는다.
"""

from __future__ import annotations

# 실제로 데이터를 가져오는 도구 — 스코프가 결정한다.
_CLASS_ONLY = ["search_class_material", "search_textbook_figure"]

# 이 세션에서 만든 개념 조회 — 어디서나 가능하지만 **카드가 있을 때만** 넣는다.
# 첫 질문(카드 0장)에 노출하면 모델이 부르고 빈 목록을 받는다. think가 도구
# 0개인 세션에서 헛돌던 것과 같은 낭비다(2026-07-28 실측).
_CONCEPTS = ["list_session_concepts", "get_concept"]

# 교사 전용 — 학급 세션의 담임에게만. 권한은 스킬 안에서 is_class_teacher로
# 한 번 더 확인한다(카탈로그는 1층 방어일 뿐이다).
_TEACHER_ONLY = ["list_class_materials", "summarize_class_questions"]

# 세션에 올린 파일 조회 — **파일이 실제로 있을 때만** 넣는다. 없는데 노출하면
# 모델이 부르고, 빈 목록을 받고, "올리신 파일이 없네요"라는 군더더기를 답에
# 붙인다(학생은 파일 얘기를 꺼낸 적도 없다).
_SESSION_FILES = ["list_session_files", "read_session_file"]

# 계획 수립 도구. **조합할 대상이 2개 이상일 때만** 넣는다.
#
# 실측(2026-07-28): 개인 세션은 실도구가 0개인데 think만 노출하니 모델이
# "뭐라도 불러야 하나" 싶어 그걸 불렀다. 순서를 정할 도구가 없는데 순서를
# 정하는 셈이라 왕복 한 번(2.5초)이 통째로 낭비됐다. 도구가 하나뿐일 때도
# 마찬가지다 — 계획 없이 그냥 부르면 된다.
_PLANNER = "think"
_PLANNER_MIN_TOOLS = 2


def skills_for(
    space_kind: str,
    role: str,
    *,
    has_session_files: bool = False,
    has_concepts: bool = False,
) -> list[str]:
    """(공간 종류, 앱 역할, 세션 상태) → 노출할 스킬 이름 목록.

    세션 상태(파일·개념 유무)까지 보는 이유는 하나다 — **빈 도구를 보여주면
    모델이 부른다.** 부르고, 빈 결과를 받고, 묻지도 않은 얘기를 답에 붙인다.
    """
    names: list[str] = list(_CONCEPTS) if has_concepts else []
    if space_kind == "class":
        names += _CLASS_ONLY
        if role in ("teacher", "admin"):
            names += _TEACHER_ONLY
    if has_session_files:
        names += _SESSION_FILES
    if len(names) >= _PLANNER_MIN_TOOLS:
        names.append(_PLANNER)
    return names
