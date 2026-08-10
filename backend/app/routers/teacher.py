"""Teacher control panel (Stage 4b) — teacher role only, NO conversation space.

A teacher manages classes: view students, read each student's class-scoped
conversation sessions, and upload class materials (embedded once, then RAG-
shared with all class members). Teachers do not have a chat workspace — there is
no teacher chat endpoint here.

Auth: every endpoint requires app role 'teacher' (gate) AND per-class
is_class_teacher (data scope, enforced in the RPCs / RLS).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, Profile, get_current_user, require_role
from ..db.client import UserClient
from ..services import files as files_svc

logger = logging.getLogger("nodi.teacher")

router = APIRouter(prefix="/teacher", tags=["teacher"])

# Gate: caller must be an app-role 'teacher'. Per-class authority is checked by
# is_class_teacher() inside the RPCs / RLS.
require_teacher = require_role("teacher")

SESSION_SELECT = (
    "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
    "current_head_id,created_at,updated_at"
)


async def _assert_teaches(client: UserClient, class_id: str) -> None:
    is_teacher = await client.rpc("is_class_teacher", {"p_class_id": class_id})
    if not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a teacher of this class.",
        )


@router.get("/classes/overview")
async def list_class_overview(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Teacher console HOME data (D67): one row per class the caller teaches,
    each with student_count, material_count and last_activity_at.

    Delegates to the teacher_class_overview() SECURITY DEFINER RPC (0023), which
    self-guards via is_class_teacher(c.id) — so a teacher sees only their own
    classes.

    구 `/classes`(드롭다운용)는 **2026-08-10에 걷어냈다** — 콘솔이 전부 이
    창구를 쓰게 된 뒤로 아무도 부르지 않았다. 그쪽이 쓰던 `teacher_classes()`
    RPC도 함께 쓸모를 잃었다(마이그레이션 0043에서 DROP).
    """
    client = UserClient.from_user(user)
    return await client.rpc("teacher_class_overview", {}, many=True)


class CreateClassBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/classes", status_code=status.HTTP_201_CREATED)
async def create_class(
    body: CreateClassBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> dict[str, Any]:
    """Create a class owned by the calling teacher (D33).

    Delegates to the `create_class` SECURITY DEFINER RPC: it re-checks the
    teacher app-role, inserts the class (teacher_id = caller, unique join_code),
    and enrolls the caller as a class teacher. Returns the new class row
    (id, name, join_code, teacher_id, created_at). Students join later with the
    join_code via the existing onboarding/profile flow."""
    client = UserClient.from_user(user)
    result = await client.rpc("create_class", {"p_name": body.name})
    if isinstance(result, list):
        return result[0] if result else {}
    return result


@router.get("/classes/{class_id}/students")
async def list_students(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Students of a class the caller teaches (RPC guards via is_class_teacher)."""
    client = UserClient.from_user(user)
    return await client.rpc("class_students", {"p_class_id": class_id}, many=True)


@router.get("/classes/{class_id}/students/{user_id}/sessions")
async def list_student_sessions(
    class_id: str,
    user_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """A student's sessions in THIS class space (teacher reads via RLS R2).

    Open a session's nodes via GET /sessions/{id} (teacher access allowed).
    """
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    return await client.select(
        "sessions",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{class_id}",
            "owner_id": f"eq.{user_id}",
            "select": SESSION_SELECT,
            "order": "updated_at.desc",
        },
    )


@router.get("/classes/{class_id}/materials")
async def list_materials(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Class-material + textbook files for the class + their embedding status.

    TASK 4(0038): 교사가 올린 교과서(kind=textbook)도 자료 목록에 합류한다.
    FILE_SELECT에 kind가 포함되므로 프론트가 배지로 구분할 수 있다.
    """
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    rows = await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{class_id}",
            "kind": "in.(class_material,textbook)",
            "select": files_svc.FILE_SELECT,
            "order": "created_at.desc",
        },
    )
    await _attach_figure_progress(client, rows)
    return rows


async def _attach_figure_progress(
    client: UserClient, rows: list[dict[str, Any]]
) -> None:
    """교과서 행에 도판 진척(`figure_done`/`figure_total`)을 붙인다 (D186).

    ## 왜 필요한가

    교사 화면의 진행률은 **텍스트 청크만** 셌다. 그런데 교과서는 도판 파이프라인
    (크롭 → 비전 캡션 → 임베딩)이 훨씬 길고, 그 잡들이 텍스트 잡과 **같은 순간에**
    만들어져 큐에서 앞을 차지한다(`_claim_jobs`는 created_at 오름차순인데 동점이다).
    그래서 도판이 다 끝날 때까지 화면은 **0%에 붙어 있는다.**

    실측 2026-08-06(173p 교과서): 도판 336/708장을 처리하는 동안 화면은 계속 0%
    였다. 사용자 보고가 "진행도가 0에서 안 움직이는데 왜이래?"였다 — 멎은 것과
    구분할 방법이 화면에 없다. **일을 절반 해 놓고 아무것도 안 한 척하는 표시는
    고장난 표시보다 나쁘다**(교사가 재시도를 누르거나 포기하게 만든다).

    ## 왕복 한 번

    파일마다 세면 N+1이다. 교과서 id를 모아 한 번에 읽고 파이썬에서 센다 —
    행이 (file_id, status) 둘뿐이라 도판 수백 개도 가볍다.

    실패는 삼킨다. 진척 표시는 **있으면 좋은 것**이지 목록을 막을 이유가 아니다
    (D88이 도판 실패를 텍스트 인덱싱과 격리한 것과 같은 정신).
    """
    ids = [str(r["id"]) for r in rows if r.get("kind") == "textbook"]
    if not ids:
        return
    try:
        figures = await client.select(
            "textbook_figures",
            {"select": "file_id,status", "file_id": f"in.({','.join(ids)})"},
        )
    except Exception:  # noqa: BLE001 - 진척 표시가 목록을 막지 않는다
        logger.warning("도판 진척 조회 실패 (교과서 %d건)", len(ids), exc_info=True)
        return
    done: dict[str, int] = dict.fromkeys(ids, 0)
    total: dict[str, int] = dict.fromkeys(ids, 0)
    for f in figures:
        fid = str(f.get("file_id"))
        if fid not in total:
            continue
        total[fid] += 1
        # 'pending'만 남은 일이다 — embedded는 끝났고, failed는 더 안 는다
        # (D88: 도판 실패는 파일 상태를 바꾸지 않는다). 둘 다 "처리됨"으로 센다.
        if f.get("status") != "pending":
            done[fid] += 1
    for r in rows:
        rid = str(r["id"])
        if rid in total:
            r["figure_total"] = total[rid]
            r["figure_done"] = done[rid]


class ToggleLecturePackageBody(BaseModel):
    enabled: bool


@router.get("/classes/{class_id}/lecture-packages")
async def list_class_lecture_packages(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """전체 강의 패키지 카탈로그 + 이 학급의 켜짐 여부(enabled) (D149).

    카탈로그(lecture_packages)는 전역 콘텐츠라 인증만 되면 읽힌다. 켜짐 매핑은
    class_lecture_packages를 학급으로 좁혀 읽어(clp_select_member) enabled로 합친다.
    _assert_teaches로 가르치는 학급인지 먼저 확인한다.
    """
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    packages = await client.select(
        "lecture_packages",
        {"select": "id,grade,subject,title", "order": "grade.asc"},
    )
    enabled_rows = await client.select(
        "class_lecture_packages",
        {"class_id": f"eq.{class_id}", "select": "package_id"},
    )
    enabled = {str(r["package_id"]) for r in enabled_rows}
    return [{**p, "enabled": str(p["id"]) in enabled} for p in packages]


@router.put("/classes/{class_id}/lecture-packages/{package_id}")
async def toggle_class_lecture_package(
    class_id: str,
    package_id: str,
    body: ToggleLecturePackageBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> dict[str, Any]:
    """학급에 강의 패키지를 켜거나 끈다 (D149).

    켜면 class_lecture_packages에 upsert(중복 시 무시), 끄면 해당 행을 삭제한다.
    쓰기는 clp_write_teacher(RLS my_taught_class_ids)가 강제하고, 앱은
    _assert_teaches로 가르치는 학급인지 먼저 확인한다.
    """
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    if body.enabled:
        await client.upsert(
            "class_lecture_packages",
            {"class_id": class_id, "package_id": package_id},
            on_conflict="class_id,package_id",
        )
    else:
        await client.delete(
            "class_lecture_packages",
            {"class_id": f"eq.{class_id}", "package_id": f"eq.{package_id}"},
        )
    return {"ok": True, "enabled": body.enabled}

