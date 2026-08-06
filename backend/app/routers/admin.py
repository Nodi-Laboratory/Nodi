"""운영 콘솔 엔드포인트 — 전부 admin 전용.

관리자 **본인의 JWT**로 admin RLS 정책과 SECURITY DEFINER RPC를 탄다
(service_role을 쓰지 않는다). 즉 콘솔이 넓게 보는 것도 DB가 허락한 만큼이다 —
"권한은 DB가 강제한다"(D104)를 콘솔이라고 우회하지 않는다.

D113에서 이 콘솔이 서비스 전체를 관측하는 창구가 됐다:
  개요·AI 흐름·대화 기록·스킬 사용·문서 인제스트·RAG 테스트·런타임 설정.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import ai
from ..auth.deps import CurrentUser, Profile, get_current_user, require_admin
from ..config import get_settings
from ..db.client import UserClient, get_service_client
from ..services import (
    admin_backup,
    admin_console,
    app_settings,
    clip_thumbnails,
    gemini,
    ink_marks,
    solar,
)
from ..services import figures as figures_svc
from . import health

logger = logging.getLogger("nodi.admin")
router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()


# ---------------------------------------------------------------------------
# Users + roles
# ---------------------------------------------------------------------------
@router.get("/users")
async def list_users(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "profiles",
        {
            "select": "id,email,role,display_name,avatar_url,created_at",
            "order": "created_at.desc",
        },
    )


class RoleBody(BaseModel):
    role: str = Field(pattern="^(student|teacher|admin)$")


@router.post("/users/{user_id}/role")
async def set_user_role(
    user_id: str,
    body: RoleBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Change a user's app role. Self-demotion is blocked inside the RPC."""
    client = UserClient.from_user(user)
    result = await client.rpc(
        "admin_set_user_role",
        {"p_user_id": user_id, "p_role": body.role},
    )
    if isinstance(result, list):
        return result[0] if result else {}
    return result


# ---------------------------------------------------------------------------
# Runtime settings (app_settings)
# ---------------------------------------------------------------------------
@router.get("/settings")
async def list_settings(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """튜너블 전체 — 현재값 · 기본값 · 변경 여부 · 위젯 스펙 (D113).

    예전에는 app_settings 행만 그대로 돌려주고 라벨·범위·설명은 프론트가 따로
    들고 있었다. 그러면 노브를 추가할 때 서버·DB·프론트가 어긋난다. 스펙의
    소유자를 서버로 옮겼다(services/admin_console.py).
    """
    client = UserClient.from_user(user)
    return await admin_console.settings_view(client)


class SettingBody(BaseModel):
    # jsonb value — any JSON type (str/number/bool/object/array).
    value: Any


@router.put("/settings/{key}")
async def put_setting(
    key: str,
    body: SettingBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Upsert one runtime setting and invalidate the overlay cache (D62).

    The value lands in app_settings AND, because every tunable call site now
    reads through the app_settings overlay (services/app_settings.py), takes
    LIVE effect — instantly in this process via bust_cache(), within the TTL
    elsewhere. (new-only 키는 신규 잡부터 적용된다 — 워커의 청킹 파라미터 등.)
    """
    client = UserClient.from_user(user)
    result = await client.upsert(
        "app_settings",
        {
            "key": key,
            "value": body.value,
            "updated_by": user.id,
            "updated_at": datetime.now(UTC).isoformat(),
        },
        on_conflict="key",
    )
    app_settings.bust_cache()
    return result


@router.post("/settings/{key}/reset")
async def reset_setting(
    key: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """한 설정을 config 기본값으로 되돌린다 (D113).

    행을 **지우지 않고 기본값을 써 넣는다.** 지우면 admin 콘솔에서 그 노브가
    사라져 다시 조정할 수 없다(D62: 행이 없으면 오버레이 자체가 불가능).
    """
    default = admin_console.default_for(key)
    if default is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="이 키에는 코드 기본값이 없습니다.",
        )
    client = UserClient.from_user(user)
    result = await client.upsert(
        "app_settings",
        {
            "key": key,
            "value": default,
            "updated_by": user.id,
            "updated_at": datetime.now(UTC).isoformat(),
        },
        on_conflict="key",
    )
    app_settings.bust_cache()
    return result


# ---------------------------------------------------------------------------
# Logs — chat turn browser (ai_logs, D25)
# ---------------------------------------------------------------------------
@router.get("/logs")
async def list_logs(
    user_id: str | None = Query(None),
    since: str | None = Query(None, description="ISO timestamp (created_at >=)"),
    until: str | None = Query(None, description="ISO timestamp (created_at <)"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Chat turn logs (`ai_logs`): system prompt, Q/A, used contexts, skill
    calls, errors, token estimate. user/date filters + pagination, newest first.
    The frontend live-appends new turns via Supabase Realtime and pages history
    through this endpoint."""
    client = UserClient.from_user(user)
    params: dict[str, str] = {
        "select": _LOG_SELECT,
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if user_id:
        params["owner_id"] = f"eq.{user_id}"
    if since:
        params["created_at"] = f"gte.{since}"
    if until:
        # combine with `since` when both present
        params["and"] = f"(created_at.lt.{until})"
    logs = await client.select("ai_logs", params)
    return {"limit": limit, "offset": offset, "logs": logs}


# 목록·상세·대화 상세가 **같은 컬럼 집합**을 쓴다. 예전에는 목록이 자기 문자열을
# 따로 들고 있어서, D113으로 컬럼을 늘렸을 때 상세에만 반영되고 목록에는 빠졌다
# (실측: 콘솔에 route·토큰이 안 뜸). 한 곳으로 모아 다시 갈라지지 않게 한다.
_LOG_SELECT = (
    "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
    "contexts,skill_calls,errors,token_estimate,tokens,route,model,"
    "duration_ms,created_at"
)


@router.get("/logs/{log_id}")
async def get_log_detail(
    log_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """D34 turn detail: one `ai_logs` turn (structured contexts incl. RAG
    sources + prompt spans), so the admin sees how a turn was built. Admin-only
    (require_admin + admin RLS)."""
    client = UserClient.from_user(user)
    rows = await client.select(
        "ai_logs",
        {"id": f"eq.{log_id}", "select": _LOG_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Log not found."
        )
    return {"log": rows[0]}


# ---------------------------------------------------------------------------
# 개요 (D113)
# ---------------------------------------------------------------------------
@router.get("/overview")
async def overview(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """서비스 전체 카운터 한 판 — 사용자·세션·문서·청크·잡·턴·토큰·지연.

    집계는 `admin_overview()` RPC가 한 질의로 한다. 앱에서 행을 끌어와 세면
    수천 행이 오간다.
    """
    client = UserClient.from_user(user)
    return await client.rpc("admin_overview", {})


@router.get("/env")
async def env(
    _user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """환경 자가진단 — 콘솔 개요의 "환경" 카드.

    D116: 콘솔이 원래 `/health/config`를 직접 불렀는데, 같은 출처로 배포하면서
    그 경로가 인터넷에 인증 없이 열리게 됐다. 비밀값은 없지만
    `secret_is_default`·`jwt_algorithm`·내부 경로·모델명은 정찰 정보다 —
    관리자만 볼 이유가 충분하다.

    내용은 `/health/config`와 **같은 함수**가 만든다. 둘이 갈라지면 서버에서
    친 진단과 콘솔 화면이 달라져 원인을 찾기 어려워진다.
    """
    return await health.config_report()


# ---------------------------------------------------------------------------
# AI 흐름 · 스킬 (D113)
# ---------------------------------------------------------------------------
@router.get("/skills")
async def list_skills(
    days: int = Query(30, ge=1, le=365),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """등록된 스킬 전부 + 노출 조건 + 실제 사용 통계.

    카탈로그를 **하드코딩하지 않는다** — 레지스트리에서 읽어야 스킬을 추가·삭제
    했을 때 이 화면이 저절로 맞는다. `exposed_in`은 어느 스코프에서 그 스킬이
    보이는지를 `catalog.skills_for`를 실제로 호출해 계산한다(설명과 코드가
    갈라지지 않게).
    """
    client = UserClient.from_user(user)
    registry = ai.get_orchestrator().registry

    # 노출 조건은 조합을 직접 돌려 확인한다 — 표를 손으로 적으면 틀린다.
    combos = [
        ("personal/student", ("personal", "student", False, False)),
        ("personal/파일있음", ("personal", "student", True, False)),
        ("personal/개념있음", ("personal", "student", False, True)),
        ("class/student", ("class", "student", False, False)),
        ("class/teacher", ("class", "teacher", False, False)),
        ("class/teacher+전체", ("class", "teacher", True, True)),
    ]
    exposure: dict[str, list[str]] = {n: [] for n in registry.names()}
    for label, (space, role, files, concepts) in combos:
        for name in ai.skills_for(
            space, role, has_session_files=files, has_concepts=concepts
        ):
            if name in exposure:
                exposure[name].append(label)

    usage_rows = await client.rpc("admin_skill_usage", {"p_days": days})
    if isinstance(usage_rows, dict):
        usage_rows = [usage_rows]
    usage = {r["skill"]: r for r in (usage_rows or []) if r.get("skill")}

    skills = []
    for name in sorted(registry.names()):
        skill = registry.get(name)
        skills.append(
            {
                "name": name,
                "description": skill.description if skill else "",
                "parameters": skill.parameters if skill else {},
                "exposed_in": exposure.get(name, []),
                "usage": usage.get(name),
            }
        )
    return {"days": days, "skills": skills}


@router.get("/flow")
async def ai_flow(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """채팅 한 턴의 파이프라인 그래프 — 어떤 경로가 지금 살아 있는지 포함."""
    client = UserClient.from_user(user)
    overlay = await app_settings.get_overlay()
    react_on = app_settings.as_bool(overlay, "react_enabled", settings.react_enabled)
    steps = app_settings.as_int(
        overlay, "react_max_steps", settings.react_max_steps, 1, 8
    )
    registry = ai.get_orchestrator().registry
    skills = [
        {"name": n, "description": (registry.get(n).description if registry.get(n) else "")}
        for n in sorted(registry.names())
    ]
    flow = admin_console.flow_spec(
        react_on=react_on, react_steps=steps, skills=skills
    )
    # 대화가 실제로 어느 경로로 돌고 있는지(로그 기준)도 같이 — 설정과 실제가
    # 어긋나면 여기서 드러난다.
    counts = await client.rpc("admin_overview", {})
    flow["observed_routes"] = (counts or {}).get("turns", {}).get("by_route", {})
    return flow


# ---------------------------------------------------------------------------
# 대화 기록 (D113)
# ---------------------------------------------------------------------------
@router.get("/conversations")
async def list_conversations(
    owner_id: str | None = Query(None),
    space_kind: str | None = Query(None, pattern="^(personal|class)$"),
    search: str | None = Query(None, description="제목·이메일·질문·답변 부분일치"),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """모든 사용자의 대화를 **세션 단위**로 목록화.

    Plant-Counselor의 로그 화면은 대화가 파일 단위로 흩어져 읽기 어려웠다.
    여기서는 한 줄이 곧 한 대화다 — 누가·어디서·몇 턴·토큰 얼마.
    """
    client = UserClient.from_user(user)
    rows = await client.rpc(
        "admin_conversations",
        {
            "p_owner": owner_id,
            "p_space": space_kind,
            "p_search": (search or None),
            "p_limit": limit,
            "p_offset": offset,
        },
    )
    rows = _as_list(rows)
    total = int(rows[0]["total_count"]) if rows else 0
    for r in rows:
        r.pop("total_count", None)
    return {"total": total, "limit": limit, "offset": offset, "conversations": rows}


@router.get("/conversations/{session_id}")
async def get_conversation(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """한 대화의 전체 기록 — 세션 · 캔버스 · 노드 · 턴 로그.

    노드와 로그를 **함께** 돌려준다. 노드는 AI가 뱉은 원문이고 로그는 그렇게
    나오기까지의 과정이라, 둘을 나란히 놓아야 원인을 짚을 수 있다.

    ## 캔버스가 곧 학생이 본 화면이다 (D193)

    예전에는 `sessions + nodes + ai_logs`만 읽었다. 캔버스 v2(D120~D122) 이후
    **학생이 실제로 보고 고치는 글은 `canvas_items`에 있다** — `nodes.answer`는
    AI가 뱉은 원문이라, 학생이 카드를 고치거나 분류를 바꾸거나 메모를 더한 것이
    이 화면에 안 나왔다.

    같은 함정을 저장소가 이미 두 번 기록했다: D135("태그의 출처는
    `canvas_items.tag`다 — `nodes.answer` 파싱은 학생이 고친 분류를 못 본다")와
    D152(백업이 같은 이유로 canvas_items를 추가했다). 대화 탭만 안 옮겨져 있었다.

    **증상이 안 보이는 것이 이 결함의 성질이다** — 화면은 정상으로 그려지고,
    그냥 학생 편집분이 없을 뿐이다.

    개념 연결(D171)도 함께 준다. "왜 이 배지가 떴나"를 관리자가 되짚으려면
    카드와 나란히 있어야 한다.
    """
    client = UserClient.from_user(user)
    sessions = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": (
                "id,owner_id,space_kind,space_ref,title,emoji,"
                "root_node_id,current_head_id,created_at,updated_at"
            ),
            "limit": "1",
        },
    )
    if not sessions:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Session not found."
        )
    session = sessions[0]
    nodes = await client.select(
        "nodes",
        {
            "session_id": f"eq.{session_id}",
            "select": "id,parent_id,question,answer,label,attachments,rag_sources,created_at",
            "order": "created_at.asc",
        },
    )
    logs = await client.select(
        "ai_logs",
        {
            "session_id": f"eq.{session_id}",
            "select": _LOG_SELECT,
            "order": "created_at.asc",
        },
    )
    # 학생이 실제로 본 화면 (D193). 순서는 캔버스와 같게 `seq`다 — 화면에서
    # 위에서 아래로 읽히는 순서라야 관리자가 짚어 가며 볼 수 있다.
    items = await client.select(
        "canvas_items",
        {
            "session_id": f"eq.{session_id}",
            "select": (
                "id,node_id,parent_item_id,kind,source,title,body,tag,"
                "x,y,pinned,seq,data,created_at,updated_at"
            ),
            "order": "seq.asc",
        },
    )
    # 개념 연결 배지 (D171) — 이 세션의 카드에서 **나간** 것.
    links: list[dict[str, Any]] = []
    if items:
        ids = ",".join(str(i["id"]) for i in items)
        links = await client.select(
            "item_links",
            {
                "from_item_id": f"in.({ids})",
                "select": "id,from_item_id,to_item_id,explanation,distance,opened_at",
            },
        )
    owners = await client.select(
        "profiles",
        {"id": f"eq.{session['owner_id']}", "select": "id,email,role,display_name", "limit": "1"},
    )
    return {
        "session": session,
        "owner": owners[0] if owners else None,
        "nodes": nodes,
        "logs": logs,
        "canvas_items": items,
        "item_links": links,
    }


# ---------------------------------------------------------------------------
# 문서 인제스트 (D113)
# ---------------------------------------------------------------------------
@router.get("/documents")
async def list_documents(
    kind: str | None = Query(None, pattern="^(user_upload|class_material|textbook)$"),
    file_status: str | None = Query(None, alias="status"),
    search: str | None = Query(None),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """모든 문서 + 인제스트 현황(청크 행 수·임베딩 성공·글자 수·도판).

    files.chunk_total/chunk_done은 워커가 갱신하는 **진행률**이라 실제 행 수와
    어긋날 수 있다. 양쪽을 다 돌려주므로 어긋난 파일이 눈에 띈다.
    """
    client = UserClient.from_user(user)
    rows = _as_list(
        await client.rpc(
            "admin_documents",
            {
                "p_kind": kind,
                "p_status": file_status,
                "p_search": (search or None),
                "p_limit": limit,
                "p_offset": offset,
            },
        )
    )
    total = int(rows[0]["total_count"]) if rows else 0
    for r in rows:
        r.pop("total_count", None)
    return {"total": total, "limit": limit, "offset": offset, "documents": rows}


@router.get("/documents/{file_id}")
async def get_document(
    file_id: str,
    chunk_limit: int = Query(50, ge=1, le=500),
    chunk_offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """문서 하나의 인제스트 상세 — 파일 · 청크 원문 · 잡 이력 · 도판 · 지식 원자.

    "문서가 어떻게 올라갔는가"의 답은 결국 **청크 경계**다. 어디서 끊겼는지를
    직접 봐야 청크 크기·겹침 값을 고칠 수 있다. 원자(D129 — 청크별 예상 질문)도
    같은 이유로 원문을 보여준다: 어떤 질문이 생성됐는지 봐야
    atom_questions_per_chunk·atom_rag_max_distance를 고칠 수 있다.
    """
    client = UserClient.from_user(user)
    files = await client.select(
        "files",
        {
            "id": f"eq.{file_id}",
            "select": (
                "id,owner_id,space_kind,space_ref,kind,storage_path,mime,size_bytes,"
                "status,chunk_total,chunk_done,error,name,session_id,context_chars,"
                "created_at,updated_at"
            ),
            "limit": "1",
        },
    )
    if not files:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="File not found."
        )
    chunks = await client.select(
        "file_chunks",
        {
            "file_id": f"eq.{file_id}",
            "select": "id,seq,status,chunk_text,created_at",
            "order": "seq.asc",
            "limit": str(chunk_limit),
            "offset": str(chunk_offset),
        },
    )
    jobs = await client.select(
        "jobs",
        {
            "target_id": f"eq.{file_id}",
            "select": (
                "id,kind,status,progress,attempts,error,batch_range,"
                "parent_job_id,created_at,updated_at"
            ),
            "order": "created_at.asc",
        },
    )
    figure_rows = await client.select(
        "textbook_figures",
        {
            "file_id": f"eq.{file_id}",
            # D134: 확정 캡션은 embed_text(생성 캡션)다 — caption 컬럼은 파서
            # 라벨 힌트라 대부분 비어 있어, 그대로 내리면 콘솔에 '캡션 없음'으로
            # 보인다. 검색·파일 상세와 같은 표시 규약(display_caption)으로 내린다.
            "select": (
                "id,seq,page,caption,alt,candidates,selected_index,"
                "embed_text,match_kind,figure_type,status"
            ),
            "order": "seq.asc",
            "limit": "200",
        },
    )
    figures = [
        {
            "id": f["id"], "seq": f["seq"], "page": f["page"],
            "caption": figures_svc.display_caption(f),
            "figure_type": f["figure_type"], "status": f["status"],
            "match_kind": f.get("match_kind") or "",
            "selected_index": f.get("selected_index"),
        }
        for f in figure_rows
    ]
    # D129: 지식 원자 — atom_rag_enabled로 만들어진 청크별 예상 질문. 노브가
    # 꺼져 있었거나 원자화 전 문서면 빈 목록(프론트는 있을 때만 패널을 그린다).
    atoms = await client.select(
        "chunk_atoms",
        {
            "file_id": f"eq.{file_id}",
            "select": "id,chunk_seq,question,status",
            "order": "chunk_seq.asc",
            "limit": "500",
        },
    )
    owners = await client.select(
        "profiles",
        {"id": f"eq.{files[0]['owner_id']}", "select": "id,email,role", "limit": "1"},
    )
    return {
        "file": files[0],
        "owner": owners[0] if owners else None,
        "chunks": chunks,
        "chunk_offset": chunk_offset,
        "jobs": jobs,
        "figures": figures,
        "atoms": atoms,
    }


# ---------------------------------------------------------------------------
# RAG 테스트 (D113)
# ---------------------------------------------------------------------------
class RagTestBody(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    class_id: str | None = None
    file_ids: list[str] = Field(default_factory=list)
    top_k: int | None = Field(default=None, ge=1, le=50)
    max_distance: float | None = Field(default=None, ge=0.0, le=1.0)
    include_figures: bool = True


@router.post("/rag/test")
async def rag_test(
    body: RagTestBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """RAG 검색을 실제 경로 그대로 돌리되 **잘린 것까지** 돌려준다.

    게이트를 필터가 아니라 표시로 쓴다 — 통과·차단을 거리와 함께 봐야 게이트
    값을 어디로 옮길지 판단할 수 있다. 채팅과 같은 함수를 쓰므로 여기서 잘
    되는 질의는 실제로도 잘 된다.
    """
    client = UserClient.from_user(user)
    return await admin_console.rag_test(
        client,
        query=body.query,
        class_id=body.class_id,
        file_ids=body.file_ids,
        top_k=body.top_k,
        max_distance=body.max_distance,
        include_figures=body.include_figures,
    )


@router.get("/classes")
async def list_all_classes(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    """모든 학급 — RAG 테스트의 검색 범위를 고르는 데 쓴다."""
    client = UserClient.from_user(user)
    return await client.select(
        "classes",
        {"select": "id,name,join_code,teacher_id,created_at", "order": "created_at.desc"},
    )


# ---------------------------------------------------------------------------
# 백업 · 복원 · 초기화 (D114)
# ---------------------------------------------------------------------------
class BackupBody(BaseModel):
    scopes: list[str] = Field(default_factory=list)
    note: str = ""


@router.get("/backups")
async def list_backups(
    _u: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """저장된 스냅샷 목록 + 이 서버가 지원하는 스코프."""
    return {
        "backups": admin_backup.list_backups(),
        "scopes": {
            "all": list(admin_backup.ALL_SCOPES),
            "restorable": list(admin_backup.RESTORABLE_SCOPES),
            "purgeable": list(admin_backup.PURGEABLE_SCOPES),
        },
    }


@router.post("/backups", status_code=status.HTTP_201_CREATED)
async def create_backup(
    body: BackupBody,
    user: CurrentUser = Depends(get_current_user),
    profile: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """스냅샷 생성. 스코프를 비우면 전부 담는다."""
    client = UserClient.from_user(user)
    return await admin_backup.create_backup(
        client,
        scopes=body.scopes,
        note=body.note,
        actor=getattr(profile, "email", "") or user.id,
    )


@router.get("/backups/{name}/download")
async def download_backup(
    name: str,
    _u: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> FileResponse:
    """스냅샷 원본 내려받기.

    **이 파일에는 학생 대화 원문이 들어 있다.** 밖으로 옮기면 그 내용도 함께 나간다.
    """
    path = admin_backup.backup_path(name)
    return FileResponse(path, media_type="application/json", filename=name)


@router.delete("/backups/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_backup(
    name: str,
    _u: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> None:
    admin_backup.delete_backup(name)


class RestoreBody(BaseModel):
    scopes: list[str] = Field(default_factory=lambda: ["conversations"])


@router.post("/backups/{name}/restore")
async def restore_backup(
    name: str,
    body: RestoreBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """스냅샷에서 복원. 이미 있는 행은 건너뛴다(설정만 덮어쓴다)."""
    client = UserClient.from_user(user)
    return await admin_backup.restore_backup(client, name, body.scopes)


# 되돌릴 수 없는 동작이라 **문장을 그대로 입력**해야 실행된다. 버튼 한 번으로
# 전체 대화가 사라지면 안 된다.
PURGE_PHRASE = "초기화합니다"


class PurgeBody(BaseModel):
    scopes: list[str]
    confirm: str = Field(description=f"정확히 '{PURGE_PHRASE}' 여야 한다")
    owner_id: str | None = None
    # 기본적으로 지우기 전에 백업을 뜬다. 끄려면 명시해야 한다.
    backup_first: bool = True


@router.post("/purge")
async def purge_data(
    body: PurgeBody,
    user: CurrentUser = Depends(get_current_user),
    profile: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """스코프별 데이터 초기화 — **되돌릴 수 없다.**

    기본값이 "지우기 전에 백업"인 이유는 하나다. 백업 없는 초기화는 기능이
    아니라 사고다. 끄고 싶으면 호출부가 명시적으로 꺼야 한다.
    """
    if body.confirm != PURGE_PHRASE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"확인 문구가 다릅니다. '{PURGE_PHRASE}'를 정확히 입력하세요.",
        )
    client = UserClient.from_user(user)
    actor = getattr(profile, "email", "") or user.id

    backup: dict[str, Any] | None = None
    if body.backup_first:
        # 백업이 실패하면 **지우지 않는다.** 여기서 계속 진행하면 되돌릴 수단 없이
        # 데이터가 사라진다.
        backup = await admin_backup.create_backup(
            client,
            scopes=list(admin_backup.ALL_SCOPES),
            note=f"초기화 직전 자동 백업 ({', '.join(body.scopes)})",
            actor=actor,
        )

    service = get_service_client()
    if service is None and "documents" in body.scopes:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="문서 삭제에는 워커 DSN이 필요합니다(원본·벡터 정리).",
        )
    result = await admin_backup.purge(
        client, service, scopes=body.scopes, owner_id=body.owner_id
    )
    logger.warning("ADMIN_PURGE actor=%s scopes=%s", actor, body.scopes)
    return {**result, "backup": backup}


# ---------------------------------------------------------------------------
# 강의 클립 — 패키지·영상 CRUD + 파싱 잡 (D149)
#
# admin 본인 JWT(UserClient)로 lecture_* 테이블을 다룬다 — admin RLS가 is_admin
# 쓰기를 강제하므로 앱에서 다시 검사하지 않는다("권한은 DB가 강제한다", D104).
# 파싱 잡 en큐만 ServiceClient(files.py와 동형): jobs 삽입은 워커 DSN이 필요하다.
# ---------------------------------------------------------------------------
class CreateLecturePackageBody(BaseModel):
    grade: str = Field(min_length=1, max_length=40)
    subject: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=120)


@router.post("/lecture-packages", status_code=status.HTTP_201_CREATED)
async def create_lecture_package(
    body: CreateLecturePackageBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    return await client.insert(
        "lecture_packages",
        {
            "grade": body.grade,
            "subject": body.subject,
            "title": body.title,
            "created_by": user.id,
        },
    )


@router.get("/lecture-packages")
async def list_lecture_packages(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "lecture_packages",
        {"select": "id,grade,subject,title,created_at", "order": "created_at.desc"},
    )


@router.delete("/lecture-packages/{package_id}")
async def delete_lecture_package(
    package_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.delete("lecture_packages", {"id": f"eq.{package_id}"})
    return {"ok": True}


@router.get("/lecture-packages/{package_id}/videos")
async def list_lecture_videos(
    package_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "lecture_videos",
        {
            "package_id": f"eq.{package_id}",
            "select": "id,page_url,title,status,error,created_at",
            "order": "created_at.desc",
        },
    )


@router.post(
    "/lecture-packages/{package_id}/videos", status_code=status.HTTP_201_CREATED
)
async def add_lecture_video(
    package_id: str,
    page_url: str = Form(..., min_length=8, max_length=1000),
    title: str = Form(..., min_length=1, max_length=200),
    subtitle: UploadFile | None = File(None),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """EBS 영상 등록(멀티파트) — page_url·title + 자막파일(선택).

    자막이 있으면 Storage에 올려 subtitle_path를 채우고, 파싱 잡을 en큐한다.
    워커 DSN이 없으면(get_service_client None) 행만 만들고 잡·자막은 건너뛴다 —
    files.py 업로드 경로와 같은 계약(en큐 불가 시 조용히 비활성).
    """
    # page_url은 프론트에서 <a href>로 렌더된다. javascript:/data: URL이면
    # 학생 클릭 시 스크립트가 실행되므로 http(s)만 허용한다 (D149).
    if not page_url.lower().startswith(("http://", "https://")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="page_url은 http:// 또는 https://로 시작해야 합니다.",
        )
    client = UserClient.from_user(user)
    video = await client.insert(
        "lecture_videos",
        {
            "package_id": package_id,
            "source": "ebs",
            "page_url": page_url,
            "title": title,
            "status": "pending",
        },
    )
    svc = get_service_client()
    if svc is None:
        return video
    if subtitle is not None:
        data = await subtitle.read()
        ext = ((subtitle.filename or "sub").rsplit(".", 1)[-1] or "sub").lower()
        path = f"lectures/{video['id']}/subtitle.{ext}"
        await svc.storage_upload(
            settings.storage_bucket,
            path,
            data,
            subtitle.content_type or "text/plain",
        )
        await client.update(
            "lecture_videos", {"id": f"eq.{video['id']}"}, {"subtitle_path": path}
        )
        video["subtitle_path"] = path
    await svc.insert(
        "jobs",
        {
            "owner_id": user.id,
            "kind": "lecture_parse",
            "target_id": video["id"],
            "status": "queued",
        },
        returning=False,
    )
    return video


@router.post("/lecture-videos/{video_id}/reparse")
async def reparse_lecture_video(
    video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.update(
        "lecture_videos", {"id": f"eq.{video_id}"}, {"status": "pending", "error": None}
    )
    svc = get_service_client()
    if svc is not None:
        await svc.insert(
            "jobs",
            {
                "owner_id": user.id,
                "kind": "lecture_parse",
                "target_id": video_id,
                "status": "queued",
            },
            returning=False,
        )
    return {"ok": True}


@router.delete("/lecture-videos/{video_id}")
async def delete_lecture_video(
    video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    await client.delete("lecture_videos", {"id": f"eq.{video_id}"})
    return {"ok": True}


@router.get("/lecture-videos/{video_id}/clips")
async def list_lecture_clips(
    video_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "lecture_clips",
        {
            "video_id": f"eq.{video_id}",
            "select": "id,seq,start_sec,title,status",
            "order": "seq.asc",
        },
    )


def _as_list(rows: Any) -> list[dict[str, Any]]:
    """RPC 반환 정규화.

    `UserClient.rpc`는 행이 하나면 **dict**, 여럿이면 list, 없으면 None을
    돌려준다(스칼라/복합 타입 반환을 구분하려는 계약). 목록을 기대하는 곳에서
    그대로 쓰면 행이 하나일 때 조용히 깨진다.
    """
    if rows is None:
        return []
    if isinstance(rows, dict):
        return [rows]
    return list(rows)



# ---------------------------------------------------------------------------
# 교차 연결 판정 로그 (D172)
#
# item_links는 성공한 링크만 남긴다. 여기 있는 것은 **판정 전체**다 — 어떤
# 세션들을 뒤졌고, 각 후보의 유사도가 얼마였고, 무엇이 왜 떨어졌는지.
# "왜 안 뜨지"에 답하려면 떨어진 이유가 남아 있어야 한다.
# ---------------------------------------------------------------------------
_CROSSLINK_RUN_SELECT = (
    "id,owner_id,from_item_id,from_session_id,from_title,from_tag,"
    "from_space_kind,knobs,candidates,outcome,link_id,explanation,"
    "searched_sessions,duration_ms,created_at"
)


@router.get("/crosslink-runs")
async def list_crosslink_runs(
    outcome: str | None = Query(None, description="linked|all_rejected|no_candidate|skipped"),
    limit: int = Query(30, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """교차 연결 판정 기록(최신순). 후보별 유사도·판정 사유까지 그대로 준다."""
    client = UserClient.from_user(user)
    params: dict[str, str] = {
        "select": _CROSSLINK_RUN_SELECT,
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    if outcome:
        params["outcome"] = f"eq.{outcome}"
    rows = await client.select("crosslink_runs", params)

    # 사람이 읽는 화면이므로 소유자 이메일을 붙인다 — id만으로는 누구인지 모른다.
    owner_ids = sorted({str(r["owner_id"]) for r in rows if r.get("owner_id")})
    emails: dict[str, str] = {}
    if owner_ids:
        profs = await client.select(
            "profiles",
            {"id": f"in.({','.join(owner_ids)})", "select": "id,email,display_name"},
        )
        emails = {
            str(p["id"]): (p.get("display_name") or p.get("email") or "")
            for p in profs
        }
    for r in rows:
        r["owner_label"] = emails.get(str(r.get("owner_id") or ""), "")
    return {"items": rows, "limit": limit, "offset": offset}


@router.get("/crosslink-runs/summary")
async def crosslink_runs_summary(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """결과별 건수. 게이트가 너무 빡빡한지 한눈에 보는 용도."""
    client = UserClient.from_user(user)
    out: dict[str, int] = {}
    for name in ("linked", "all_rejected", "no_candidate", "skipped"):
        out[name] = await client.count("crosslink_runs", {"outcome": f"eq.{name}"})
    out["total"] = sum(out.values())
    return out


# ---------------------------------------------------------------------------
# 펜 표시 실험실 (D178)
# ---------------------------------------------------------------------------
@router.get("/ink-lab/figure")
async def ink_lab_figure(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """실험실 캔버스에 얹을 **실제 도판** 하나.

    붙박이 그림을 쓰지 않는 이유: 실험실의 요점은 **실제 경로를 태우는 것**이다.
    진짜 도판이라야 `/files/figures/{id}/raw`(캔버스 오염 회피 창구)와
    `object-contain` 레터박스 좌표 변환까지 함께 검증된다.

    이 기계에 도판이 없으면 `figure_id: null`을 준다 — 그때 실험실은 **주소
    없는 도판**(D167) 상태를 그대로 시험한다. 오류가 아니다.
    """
    client = UserClient.from_user(user)
    rows = await client.select(
        "textbook_figures",
        {
            # 색인이 끝난 것만 — 실패한 행은 이미지가 없을 수 있다.
            "status": "eq.embedded",
            "select": "id,page,caption,alt,candidates,selected_index,embed_text",
            "order": "created_at.desc",
            "limit": "1",
        },
    )
    if not rows:
        return {"figure_id": None, "caption": "", "page": None}
    row = rows[0]
    return {
        "figure_id": row["id"],
        "caption": figures_svc.display_caption(row),
        "page": row.get("page"),
    }


class InkAnswerBody(BaseModel):
    """실험실이 SOLAR까지 태워 보기 위한 입력 (D178).

    **왜 채팅 창구를 안 쓰나**: 실험실 카드는 붙박이라 DB에 없다(매번 같은
    조건에서 재려면 그래야 한다). 그래서 `card_ids`로 본문을 다시 읽는 실제
    경로를 그대로 쓸 수 없고, 카드 본문을 그대로 받는다.

    **그 대신 프롬프트 조립은 실제와 같은 것을 태운다** —
    `gemini.compose_system_structured(ink_context=…)`. 사본을 만들면 사본만
    맞고 실제 경로는 다른 상황이 된다(RagLabTab과 같은 태도).
    """

    question: str = Field(min_length=1, max_length=2000)
    marks_note: str = Field(default="", max_length=2000)
    cards: list[dict[str, Any]] = Field(default_factory=list, max_length=8)


@router.post("/ink-lab/answer")
async def ink_lab_answer(
    body: InkAnswerBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """표시 맥락을 얹어 SOLAR에게 한 번 물어본다 — 실험실 전용.

    스트리밍하지 않는다. 여기서 볼 것은 "어떻게 써지는가"가 아니라 **무엇을
    답하는가**이고, 실험실은 그 결과 한 장이면 된다.
    """
    lines = []
    note = body.marks_note.strip()
    if note:
        lines.append(note)
    elif body.cards:
        lines.append(
            "표시가 무엇을 가리키는지는 읽지 못했습니다. "
            "아래 카드들이 학생이 표시한 자리 주변에 있었습니다."
        )
    body_max = await ink_marks.read_card_body_max()
    rows = []
    for c in body.cards:
        try:
            n = int(c.get("n"))
        except (TypeError, ValueError):
            continue
        title = str(c.get("title") or "제목 없음")[:120]
        # 실험실은 **실제와 같은 것을 태운다** — 채팅 턴과 같은 노브를 읽는다.
        # 각자 config에서 읽던 시절에는 콘솔에서 바꿔도 한쪽만 따라갔다.
        text = " ".join(str(c.get("body") or "").split())[:body_max]
        rows.append(f"[카드 {n}] {title}: {text}" if text else f"[카드 {n}] {title}")
    if rows:
        lines.append("[표시 주변의 카드]\n" + "\n".join(rows))
    ink_context = "\n\n".join(lines) or None

    system_prompt, blocks = gemini.compose_system_structured(
        None,
        ink_context=ink_context,
        base_instruction=solar.CONCEPT_CARD_SYSTEM_PROMPT,
    )
    started = time.monotonic()
    try:
        done = await solar.complete(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": body.question},
            ]
        )
    except Exception as exc:  # noqa: BLE001 - 실험실은 실패도 보여 준다
        logger.warning("실험실 SOLAR 호출 실패", exc_info=True)
        return {"ok": False, "error": str(exc)[:300], "ms": 0, "answer": "",
                "system_prompt": system_prompt, "ink_block": ink_context or ""}

    return {
        "ok": True,
        "error": "",
        "ms": int((time.monotonic() - started) * 1000),
        "answer": done.message.get("content") or "",
        "usage": solar.usage_of(getattr(done, "usage", None)),
        # 실험실의 요점은 **무엇을 보고 답했나**다 — 프롬프트도 함께 낸다.
        "system_prompt": system_prompt,
        "ink_block": ink_context or "",
        "blocks": [b.get("kind") for b in blocks],
    }


# --- 강의 클립 썸네일 (D190) ------------------------------------------------
#
# EBS 썸네일을 가져올 방법이 없어(저작권·차단) 관리자가 쓸 만한 그림을 올려
# 두고 클립마다 그중 하나를 보여 준다. 학생 화면이 읽는 창구는 files 라우터에
# 있고, 여기는 **넣고 빼는 쪽**이다.
@router.get("/clip-thumbnails")
async def list_clip_thumbnails_admin(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    return await clip_thumbnails.list_thumbnails(UserClient.from_user(user))


@router.post("/clip-thumbnails", status_code=status.HTTP_201_CREATED)
async def add_clip_thumbnail(
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """썸네일 한 장 등록. 형식·용량 검증은 서비스가 한다."""
    return await clip_thumbnails.add_thumbnail(
        UserClient.from_user(user),
        owner_id=user.id,
        filename=file.filename or "썸네일",
        mime=file.content_type,
        data=await file.read(),
    )


@router.delete("/clip-thumbnails/{thumb_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_clip_thumbnail(
    thumb_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> None:
    await clip_thumbnails.remove_thumbnail(UserClient.from_user(user), thumb_id)


@router.post("/backups/import", status_code=status.HTTP_201_CREATED)
async def import_backup(
    file: UploadFile = File(...),
    _u: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """다른 곳에서 만든 백업 파일을 가져온다 (D193).

    시연에 쓸 상황을 미리 만들어 두고 그때 불러오려면 파일이 서버를 건너올 수
    있어야 한다 — 지금까지는 내려받기만 되고 올리기가 없었다.

    가져오는 것과 **적용하는 것은 다른 단계**다. 여기서는 목록에 넣기만 하고,
    복원은 관리자가 스코프를 골라 따로 누른다 — 올리자마자 덮어쓰면 되돌릴
    방법이 없다.
    """
    return await admin_backup.import_backup(
        file.filename or "backup.json", await file.read()
    )
