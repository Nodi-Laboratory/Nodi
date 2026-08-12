"""운영 콘솔 백엔드 (D113) — 튜너블 스펙 · AI 흐름 · RAG 테스트.

집계·조인은 DB 함수(`admin_*` RPC)가 하고, 이 모듈은 **코드에서만 알 수 있는
것**을 모은다:

  - 튜너블의 기본값·범위·설명 (config.py와 나란히 있어야 어긋나지 않는다)
  - AI 파이프라인의 단계와 분기 (catalog·registry에서 끌어와 드리프트를 막는다)
  - RAG 테스트 — 실제 검색 경로를 그대로 태우되 게이트에서 **무엇이 왜 잘렸는지**
    까지 돌려준다

튜너블 스펙을 프론트가 아니라 여기 두는 이유: 기본값은 `config.py`에 있고
클램프 범위는 호출부에 있다. 스펙이 프론트에 있으면 노브를 하나 추가할 때
서버·DB·프론트 세 곳이 어긋날 수 있고, 실제로 그렇게 어긋난 적이 있다(D62의
(c)(d) 버그류). 한 곳에서 내보내고 프론트는 그리기만 한다.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..config import get_settings
from ..db.client import UserClient, get_service_client
from . import app_settings, embedding, figure_search, qdrant_store, rag

# 노브 카탈로그는 `admin_knobs`가 갖는다(2026-08-07 분리). 이름을 그대로 다시
# 내보내는 이유: 호출부·테스트가 `admin_console._SPECS`로 참조해 왔고, 그 계약을
# 바꾸는 것은 이 정리의 목적(파일을 읽을 수 있게 만들기)과 상관없는 변경이다.
from .admin_knobs import _GROUP_ORDER, _SPEC_BY_KEY, _SPECS

logger = logging.getLogger("nodi.admin_console")
settings = get_settings()




def default_for(key: str) -> Any:
    """config.py의 기본값. app_settings 키는 config 속성명과 같게 유지한다."""
    return getattr(settings, key, None)


async def settings_view(client: UserClient) -> dict[str, Any]:
    """튜너블 전체 — 현재값 · 기본값 · 변경 여부 · 위젯 스펙.

    app_settings에 행이 없는 스펙 키도 **함께 내보낸다.** 행이 없으면 콘솔에
    아예 안 떠서 조정할 수 없는데(D62), 그 상태를 조용히 숨기지 않고
    `missing_row: true`로 드러낸다.
    """
    rows = await client.select(
        "app_settings",
        {"select": "key,value,updated_at,updated_by", "order": "key.asc"},
    )
    by_key = {r["key"]: r for r in rows}

    items: list[dict[str, Any]] = []
    for key in list(_SPEC_BY_KEY) + [k for k in by_key if k not in _SPEC_BY_KEY]:
        spec = _SPEC_BY_KEY.get(key)
        row = by_key.get(key)
        default = default_for(key)
        value = row["value"] if row else default
        items.append(
            {
                "key": key,
                "value": value,
                "default": default,
                "modified": row is not None and row["value"] != default,
                "missing_row": row is None,
                "updated_at": (row or {}).get("updated_at"),
                "updated_by": (row or {}).get("updated_by"),
                "spec": spec
                or {
                    # 스펙이 없는 키 — JSON으로 직접 편집하게 둔다.
                    "key": key,
                    "label": key,
                    "group": "기타",
                    "widget": "json",
                    "scope": "live",
                    "description": "코드에 스펙이 없는 키입니다(직접 편집).",
                    "effect": "",
                },
            }
        )
    return {
        "groups": _GROUP_ORDER,
        "items": items,
        "ttl_seconds": app_settings.TTL_SECONDS,
    }


# ---------------------------------------------------------------------------
# 2) AI 흐름
# ---------------------------------------------------------------------------
def flow_spec(
    *, react_on: bool, react_steps: int, skills: list[dict[str, Any]]
) -> dict[str, Any]:
    """채팅 한 턴의 파이프라인을 그래프로. 콘솔이 이걸 그린다.

    **레지스트리·설정에서 끌어온다** — 스킬 이름·활성 경로를 손으로 적어 두면
    코드가 바뀔 때 그림만 옛말이 된다(문서가 거짓말하는 가장 흔한 방식).
    """
    skill_names = [s["name"] for s in skills]
    nodes: list[dict[str, Any]] = [
        {
            "id": "question",
            "label": "학생 질문",
            "kind": "io",
            "route": "both",
            "where": "frontend: lib/concept/useConceptStream.ts",
            "detail": "SSE로 POST /chat/stream. 답변은 토큰 단위로 흘러온다.",
        },
        {
            "id": "authz",
            "label": "권한 확인",
            "kind": "guard",
            "route": "both",
            "where": "backend: routers/chat.py",
            "detail": (
                "세션 소유자만 쓸 수 있다(담임은 읽기만). 스트리밍 시작 전에 "
                "막아 AI 토큰을 낭비하지 않는다. 이후 모든 DB 접근은 RLS 스코프."
            ),
        },
        {
            "id": "history",
            "label": "조상 체인 수집",
            "kind": "read",
            "route": "both",
            "where": "backend: services/sessions.ancestor_chain_nodes",
            "detail": "부모를 거슬러 올라간 (질문, 답변) 목록. 형제 가지는 제외한다.",
        },
        {
            "id": "route",
            "label": "react_enabled?",
            "kind": "decision",
            "route": "both",
            "tunables": ["react_enabled"],
            "detail": "켜져 있으면 ReAct 경로, 꺼져 있으면 단발 경로(롤백용).",
        },
        # ── ReAct 경로 ──
        {
            "id": "catalog",
            "label": "도구 카탈로그 좁히기",
            "kind": "logic",
            "route": "react",
            "where": "backend: ai/catalog.py",
            "detail": (
                "(공간, 역할, 세션 상태)로 **먼저** 좁힌다. 개인 세션에 학급 도구를 "
                "보여주면 모델이 부르고 빈 결과로 엉뚱한 답을 한다. 파일·개념이 "
                "없으면 그 스킬도 노출하지 않는다."
            ),
        },
        {
            "id": "decide",
            "label": "도구 판단 (LLM)",
            "kind": "llm",
            "route": "react",
            "where": "backend: ai/orchestrator.py → services/solar.complete",
            "detail": (
                "비스트리밍 1회. 개념 카드 형식을 **주지 않는다**(형식 지시와 도구 "
                "지시가 충돌하기 때문). 이 단계의 텍스트는 사용자에게 가지 않는다."
            ),
            "params": {"max_tokens": 512, "streaming": False, "tools": True},
        },
        {
            "id": "tools_needed",
            "label": "도구가 필요한가?",
            "kind": "decision",
            "route": "react",
            "detail": "tool_calls가 없으면 곧장 생성으로. 인사 턴에 검색이 나가지 않는 이유다.",
        },
        {
            "id": "skills",
            "label": f"스킬 실행 ({len(skill_names)}종)",
            "kind": "skill",
            "route": "react",
            "where": "backend: ai/skills/",
            "tunables": ["react_max_steps"],
            "detail": (
                f"최대 {react_steps} 라운드. 실패는 SkillResult(ok=False)로 모델에 "
                "전달되고 턴을 죽이지 않는다. 같은 인자의 중복 호출은 1회만 실행."
            ),
            "skills": skill_names,
        },
        {
            "id": "evidence",
            "label": "근거 블록 조립",
            "kind": "logic",
            "route": "react",
            "where": "backend: ai/orchestrator._evidence_block",
            "detail": (
                "**모든** 스킬 결과가 여기를 지난다. 예전에는 자료·도판만 렌더해 "
                "다른 스킬 결과가 생성 단계에 닿지 못했고, 모델이 도구를 부르고도 "
                "답을 지어냈다."
            ),
        },
        # ── 단발(legacy) 경로 ──
        {
            "id": "prefetch",
            "label": "컨텍스트 선주입 (병렬)",
            "kind": "read",
            "route": "legacy",
            "where": "backend: services/{rag,session_context,figure_search}",
            "tunables": [
                "class_material_rag_enabled",
                "class_material_rag_max_distance",
                "rag_top_k",
                "session_context_max_chars",
                "figure_retrieve_max_distance",
            ],
            "detail": (
                "질문 내용과 무관하게 자료 검색·세션 파일 전문·도판 검색을 매 턴 "
                "돌린다. 인사 한 마디에도 임베딩과 벡터 검색이 나가는 게 이 경로의 비용."
            ),
        },
        {
            "id": "compose",
            "label": "시스템 프롬프트 조립",
            "kind": "logic",
            "route": "both",
            "where": "backend: services/gemini.compose_system_structured",
            "detail": (
                "프롬프트 문자열과 블록별 문자 구간(span)을 **한 번에** 만든다. "
                "그래서 저장된 프롬프트와 콘솔의 하이라이트가 어긋나지 않는다."
            ),
        },
        {
            "id": "answer",
            "label": "답변 생성 (LLM 스트리밍)",
            "kind": "llm",
            "route": "both",
            "where": "backend: services/solar.stream_answer",
            "detail": (
                "여기서만 진짜 스트리밍이다. 도구를 **주지 않아** 형식에만 집중한다. "
                "출력은 개념 카드 줄 형식(CHAT:/@concept/@end)."
            ),
            "params": {
                "model": settings.upstage_chat_model,
                "temperature": settings.chat_temperature,
                "max_tokens": settings.chat_max_tokens,
                "streaming": True,
                "tools": False,
            },
        },
        {
            "id": "parse",
            "label": "개념 카드 파싱",
            "kind": "render",
            "route": "both",
            "where": "frontend: lib/concept/conceptParser.ts",
            "detail": "토큰 스트림을 줄 단위로 읽어 카드로. 서버의 줄 형식과 1:1이다.",
        },
        {
            "id": "layout",
            "label": "캔버스 배치 (d3-force)",
            "kind": "render",
            "route": "both",
            "where": "frontend: lib/concept/useTagLayout.ts",
            "detail": (
                "분류 태그마다 황금각 슬롯 앵커를 첫 등장 순서로 영구 부여한다. "
                "좌표는 저장하지 않는다 — 같은 세션은 매번 같은 배치로 수렴한다."
            ),
        },
        {
            "id": "persist",
            "label": "노드 저장",
            "kind": "store",
            "route": "both",
            "where": "backend: services/sessions.append_node",
            "detail": "(질문, 답변) 1행 + head 전진. 도판은 attachments.canvas에 식별자만.",
        },
        {
            "id": "log",
            "label": "턴 로그 기록",
            "kind": "store",
            "route": "both",
            "where": "backend: services/turn_log.py → ai_logs",
            "detail": (
                "실제로 보낸 시스템 프롬프트·스킬 트레이스·실측 토큰. best-effort라 "
                "로그 실패가 채팅을 막지 않는다. 이 화면이 읽는 곳이다."
            ),
        },
    ]

    edges = [
        {"from": "question", "to": "authz"},
        {"from": "authz", "to": "history"},
        {"from": "history", "to": "route"},
        {"from": "route", "to": "catalog", "label": "on", "route": "react"},
        {"from": "route", "to": "prefetch", "label": "off", "route": "legacy"},
        {"from": "catalog", "to": "decide", "route": "react"},
        {"from": "decide", "to": "tools_needed", "route": "react"},
        {"from": "tools_needed", "to": "skills", "label": "필요", "route": "react"},
        {"from": "skills", "to": "decide", "label": "재판단", "route": "react"},
        {"from": "skills", "to": "evidence", "route": "react"},
        {"from": "tools_needed", "to": "compose", "label": "불필요", "route": "react"},
        {"from": "evidence", "to": "compose", "route": "react"},
        {"from": "prefetch", "to": "compose", "route": "legacy"},
        {"from": "compose", "to": "answer"},
        {"from": "answer", "to": "parse"},
        {"from": "parse", "to": "layout"},
        {"from": "answer", "to": "persist"},
        {"from": "persist", "to": "log"},
    ]

    return {
        "active_route": "react" if react_on else "legacy",
        "react_max_steps": react_steps,
        "nodes": nodes,
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# 3) RAG 테스트
# ---------------------------------------------------------------------------
_TEST_SNIPPET_CHARS = 600


async def media_readiness(client: UserClient) -> dict[str, Any]:
    """학급마다 **그림·영상이 뜰 수 있는 상태인지** 센다 (사용자 질문 2026-08-12).

    거리 게이트를 아무리 열어도 안 뜨는 경우가 있다 — 게이트는 **찾은 것을
    거르는 자리**이고, 그 앞에 "찾을 것이 있나"라는 하드 전제가 둘 있기
    때문이다:

      · 도판: 그 학급에 `kind='textbook'` 파일이 있어야 하고, 그 도판이
        `status='embedded'`까지 가야 한다. 캡션 생성이 실패하면
        `failed`로 남고 **검색에 안 뜬다**(D134 — 폴백 없음). 캡션은 비전
        모델이 만들므로 `judge_*`가 비어 있으면 **전부** 실패한다.
      · 클립: `class_lecture_packages`에 그 학급 행이 있어야 한다. 관리자가
        패키지를 넣은 것만으로는 안 되고 **학급에 켜야** 한다.

    이 함수가 하는 일은 그 전제들을 숫자로 보여 주는 것뿐이다. 슬라이더를
    옮기기 전에 여기부터 봐야 한다.
    """
    # 설정 게이트는 `figure_judge`에 남아 있다(D131·D134 — 캡션 생성은
    # `figure_caption`으로 옮겼지만 '설정됐나'는 그쪽이 계속 답한다).
    from ..services import figure_judge

    classes = await client.select("classes", {"select": "id,name", "order": "name.asc"})
    rows: list[dict[str, Any]] = []
    for c in classes:
        cid = str(c["id"])
        books = await client.select(
            "files",
            {"space_kind": "eq.class", "space_ref": f"eq.{cid}",
             "kind": "eq.textbook", "select": "id"},
        )
        book_ids = [str(b["id"]) for b in books]
        figs: dict[str, int] = {}
        if book_ids:
            ids = ",".join(book_ids)
            got = await client.select(
                "textbook_figures",
                {"file_id": f"in.({ids})", "select": "status"},
            )
            for g in got:
                key = str(g.get("status") or "?")
                figs[key] = figs.get(key, 0) + 1
        pkgs = await client.select(
            "class_lecture_packages",
            {"class_id": f"eq.{cid}", "select": "package_id"},
        )
        pkg_ids = [str(p["package_id"]) for p in pkgs]
        clips = 0
        if pkg_ids:
            ids = ",".join(pkg_ids)
            got = await client.select(
                "lecture_clips",
                {"package_id": f"in.({ids})", "status": "eq.embedded", "select": "id"},
            )
            clips = len(got)
        rows.append(
            {
                "class_id": cid,
                "name": c.get("name") or "",
                "textbooks": len(book_ids),
                "figures": figs,
                "figures_ready": figs.get("embedded", 0),
                "packages": len(pkg_ids),
                "clips_ready": clips,
            }
        )
    return {
        # 비전 미설정이면 도판 캡션이 **전부** 실패한다 — 그 사실을 함께 준다.
        "vision_configured": figure_judge.is_configured(),
        "classes": rows,
    }



async def rag_test(
    client: UserClient,
    *,
    query: str,
    class_id: str | None = None,
    file_ids: list[str] | None = None,
    top_k: int | None = None,
    max_distance: float | None = None,
    include_figures: bool = True,
) -> dict[str, Any]:
    """실제 검색 경로를 그대로 태우고 **게이트에서 무엇이 잘렸는지**까지 돌려준다.

    채팅과 같은 함수(`rag.search`)를 쓴다 — 테스트 전용 사본을 만들면 그 사본만
    맞고 실제 경로는 다른 상황이 된다. 다른 점은 하나, 게이트를 **필터가 아니라
    표시로** 쓴다는 것이다. 잘린 청크를 거리와 함께 보여줘야 게이트 값을 어디로
    옮길지 판단할 수 있다.
    """
    overlay = await app_settings.get_overlay()
    k = top_k or app_settings.as_int(overlay, "rag_top_k", settings.rag_top_k, 1, 50)
    gate = (
        max_distance
        if max_distance is not None
        else app_settings.as_float(
            overlay,
            "class_material_rag_max_distance",
            settings.class_material_rag_max_distance,
            0.1,
            0.9,
        )
    )

    scope_ids = list(file_ids or [])
    if not scope_ids and class_id:
        scope_ids = await rag.class_material_file_ids(client, class_id)

    result: dict[str, Any] = {
        "query": query,
        "top_k": k,
        "max_distance": gate,
        "scope": {
            "class_id": class_id,
            "file_ids": scope_ids,
            "file_count": len(scope_ids),
        },
        "embedding": {
            "model": settings.upstage_embedding_query_model,
            "collection": qdrant_store.COL_FILE_CHUNKS,
        },
        "hits": [],
        "passed": 0,
        "blocked": 0,
        "block": "",
        "figures": [],
        "notes": [],
    }
    if not scope_ids:
        result["notes"].append(
            "검색 범위에 인덱싱된 파일이 없습니다(학급을 고르거나 파일을 지정하세요)."
        )
        return result

    # 임베딩 지연을 따로 잰다 — RAG 왕복에서 가장 무거운 다리다.
    t0 = time.perf_counter()
    vec = await embedding.embed_texts([query], task_type="RETRIEVAL_QUERY")
    result["embedding"]["ms"] = int((time.perf_counter() - t0) * 1000)
    if not vec:
        result["notes"].append("질의 임베딩에 실패했습니다.")
        return result
    result["embedding"]["dim"] = len(vec[0])

    t1 = time.perf_counter()
    chunks = await rag.search(client, scope_ids, query, k)
    result["search_ms"] = int((time.perf_counter() - t1) * 1000)

    names = await rag.file_names(
        client, list({c["file_id"] for c in chunks if c.get("file_id")})
    )
    hits = []
    for c in chunks:
        distance = c.get("distance")
        passed = distance is not None and distance <= gate
        hits.append(
            {
                "file_id": c.get("file_id"),
                "name": names.get(c.get("file_id"), ""),
                "chunk_id": c.get("chunk_id"),
                "seq": c.get("seq"),
                "distance": distance,
                "score": None if distance is None else round(1.0 - distance, 4),
                "passed": passed,
                "text": (c.get("chunk_text") or "")[:_TEST_SNIPPET_CHARS],
            }
        )
    result["hits"] = hits
    result["passed"] = sum(1 for h in hits if h["passed"])
    result["blocked"] = len(hits) - result["passed"]
    # 실제로 주입될 블록 원문 — 게이트를 통과한 청크만으로 만든다.
    result["block"] = rag.build_block(
        [c for c, h in zip(chunks, hits, strict=True) if h["passed"]], names
    )

    if include_figures and class_id:
        try:
            result["figures"] = await figure_search.search_class_figures(
                client, class_id, query
            )
        except Exception:  # noqa: BLE001 - 테스트 화면이 도판 때문에 죽지 않는다
            logger.warning("RAG 테스트: 도판 검색 실패", exc_info=True)
            result["notes"].append("도판 검색에 실패했습니다(로그 참고).")

    return result


async def ensure_setting_rows() -> int:
    """카탈로그의 모든 노브에 app_settings 행이 있도록 보장한다 (D174).

    **왜 필요한가**: `db/03_app_settings.sql`은 **빈 볼륨일 때 한 번만** 돈다.
    그래서 DB가 만들어진 뒤에 추가된 노브는 행이 없고, 콘솔이 그걸 빨간
    "DB 행 없음" 경보로 띄운다 — 동작은 멀쩡한데(코드 기본값으로 돈다)
    관리자 눈에는 고장으로 보인다. 실측 2026-08-04: 로컬 32개 중 **18개**가
    이 상태였다.

    노브를 추가할 때마다 마이그레이션을 쓰게 하면 반드시 빠뜨린다. 카탈로그가
    노브의 단일 소유자이므로(D113), 부팅 때 카탈로그를 보고 **없는 행만** 채운다.

    값은 config 기본값이라 **동작이 바뀌지 않는다.** 되돌리기(reset)가 행을
    지우면 다음 부팅에 같은 기본값으로 다시 생기므로 의미도 그대로다.

    부팅 경로이므로 **절대 raise하지 않는다.** 워커 DSN이 없으면 조용히 건너뛴다
    (files.py 업로드 경로와 같은 계약).
    """
    svc = get_service_client()
    if svc is None:
        return 0
    try:
        rows = await svc.select("app_settings", {"select": "key"})
        have = {r["key"] for r in rows}
        missing = [
            {"key": s["key"], "value": default_for(s["key"])}
            for s in _SPECS
            if s["key"] not in have and default_for(s["key"]) is not None
        ]
        if not missing:
            return 0
        await svc.insert("app_settings", missing, returning=False)
        app_settings.bust_cache()
        logger.info(
            "app_settings 기본 행 %d개 생성: %s",
            len(missing),
            ", ".join(m["key"] for m in missing),
        )
        return len(missing)
    except Exception:  # noqa: BLE001 - 부팅을 죽이지 않는다
        logger.warning("app_settings 기본 행 보장 실패", exc_info=True)
        return 0


# ---------------------------------------------------------------------------
# 클라이언트 설정 (D174)
#
# 캔버스 상수들은 지금까지 프론트에 박혀 있어 관리자가 못 만졌다. 서버가
# 값을 갖고 이 목록만 내려보낸다 — **화면 동작에 쓰이는 것만** 담는다.
# 학생도 부르는 경로이므로 거리 게이트·모델명 같은 운영 값은 절대 넣지 않는다.
# ---------------------------------------------------------------------------
CLIENT_KEYS = (
    # 홈 지도의 움직임 — 배경이라 값 하나에 인상이 크게 달라진다.
    "home_drift_force",
    "home_drift_breath",
    "home_drift_anchor",
    "home_fit_boost",
    "canvas_cards_per_turn",
    "canvas_type_chars_per_frame",
    "canvas_focus_zoom",
    "canvas_map_node_zoom",
    "canvas_connectors_default_on",
    "canvas_col_gap",
    "canvas_row_gap",
    "canvas_sib_gap",
    # D207: 밀어내기는 브라우저에서 돈다(월드 좌표와 실측 크기가 거기 있다).
    "card_min_gap",
    "card_push_strength",
    "card_push_speed_ms",
    # D178: 카드 선정·도식 렌더는 **브라우저에서** 돈다(월드 좌표와 실측 크기가
    # 거기 있다). 서버가 판정하는 값(ink_vlm_enabled·타임아웃·본문 길이)은
    # 내려보내지 않는다 — 프론트가 알 이유가 없다.
    "ink_card_max",
    "ink_near_pad",
    "ink_box_max_scale",
    "ink_scene_max_side",
    "ink_figure_zoom_enabled",
)


async def client_settings() -> dict[str, Any]:
    """프론트가 쓰는 값만 골라 돌려준다 (D174).

    스펙의 min/max로 clamp한다 — 관리자가 DB를 직접 만져 이상한 값을 넣어도
    화면이 깨지지 않게. 실패는 config 기본값으로 조용히 떨어진다(이 경로가
    죽으면 캔버스가 안 뜬다).
    """
    try:
        overlay = await app_settings.get_overlay()
    except Exception:  # noqa: BLE001
        overlay = {}
    out: dict[str, Any] = {}
    for key in CLIENT_KEYS:
        default = default_for(key)
        spec = _SPEC_BY_KEY.get(key) or {}
        if isinstance(default, bool):
            out[key] = app_settings.as_bool(overlay, key, default)
        elif isinstance(default, int):
            out[key] = app_settings.as_int(
                overlay, key, default, spec.get("min", 0), spec.get("max", 10_000)
            )
        elif isinstance(default, float):
            out[key] = app_settings.as_float(
                overlay, key, default, spec.get("min", 0.0), spec.get("max", 100.0)
            )
        else:
            out[key] = default

    #: 지금 쓰는 손글씨 폰트 (D210 8-1). 없으면 저장소에 박힌 기본 폰트다.
    #:
    #: **이 경로가 죽으면 캔버스가 안 뜬다** — 폰트를 못 읽는 것은 폰트가
    #: 기본으로 도는 것으로 끝나야지 화면을 막으면 안 된다.
    out["handFont"] = None
    try:
        from . import hand_fonts

        svc = get_service_client()
        if svc is not None:
            row = await hand_fonts.active_font(svc)
            if row:
                out["handFont"] = {
                    "family": row["family"],
                    "url": f"/api/hand-fonts/{row['slug']}/web",
                    "letterSpacing": float(row["letter_spacing"]),
                    "sizeScale": float(row["size_scale"]),
                    "ideographScale": float(row["ideograph_scale"]),
                }
    except Exception:  # noqa: BLE001 - 폰트를 못 읽어도 캔버스는 뜬다
        logger.warning("활성 손글씨 폰트 조회 실패 — 기본 폰트로 간다", exc_info=True)
    return out
