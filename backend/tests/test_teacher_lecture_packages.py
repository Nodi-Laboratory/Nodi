"""teacher 강의 패키지 선택 라우트 등록 + 바디 모델 검증 (D149)."""

from app.main import app


def _paths() -> set[str]:
    # 이 앱은 include_router가 라우트를 app.routes로 펼치지 않고 _IncludedRouter
    # 래퍼로 감싼다(지연 매칭). 래퍼는 original_router(하위 라우트) + prefix('/api')를
    # 들고 있으니 접두사를 붙여 전체 경로를 복원한다. 감싸이지 않은 라우트는 그대로.
    out: set[str] = set()
    for r in app.routes:
        orig = getattr(r, "original_router", None)
        if orig is not None:
            prefix = r.include_context.prefix
            out |= {
                f"{prefix}{p}"
                for x in orig.routes
                if (p := getattr(x, "path", None))
            }
        elif (p := getattr(r, "path", None)):
            out.add(p)
    return out


def test_teacher_lecture_routes():
    p = _paths()
    assert "/api/teacher/classes/{class_id}/lecture-packages" in p
    assert "/api/teacher/classes/{class_id}/lecture-packages/{package_id}" in p


def test_toggle_body_model():
    from app.routers.teacher import ToggleLecturePackageBody

    assert ToggleLecturePackageBody(enabled=True).enabled is True
