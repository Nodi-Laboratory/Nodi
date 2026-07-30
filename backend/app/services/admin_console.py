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
from ..db.client import UserClient
from . import app_settings, embedding, figure_search, qdrant_store, rag

logger = logging.getLogger("nodi.admin_console")
settings = get_settings()


# ---------------------------------------------------------------------------
# 1) 튜너블 스펙
# ---------------------------------------------------------------------------
# scope 는 "언제부터 듣는가"다 — 이걸 잘못 알면 관리자가 값을 바꾸고 왜 안
# 바뀌는지 헤맨다.
#   live      다음 요청부터 (오버레이 TTL 20초 안)
#   new-only  이미 처리된 것에는 소급되지 않는다 (신규 업로드·신규 잡부터)
#   danger    기존 인덱스와 불일치하면 검색이 깨진다 (재임베딩 필요)
_SPECS: list[dict[str, Any]] = [
    {
        "key": "react_enabled",
        "label": "ReAct 스킬 루프",
        "group": "AI 흐름",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "켜면 채팅 턴이 '도구 판단 → 스킬 실행 → 생성' 2단계로 돈다. "
            "끄면 컨텍스트를 미리 다 주입하는 기존 단발 경로로 돌아간다(롤백용)."
        ),
        "effect": "인사 턴의 불필요한 검색 제거 ↔ 자료 턴의 LLM 왕복 1회 추가",
    },
    {
        "key": "react_max_steps",
        "label": "ReAct 도구 라운드 상한",
        "group": "AI 흐름",
        "widget": "number",
        "min": 1,
        "max": 8,
        "step": 1,
        "scope": "live",
        "description": "도구 호출 라운드 최대 횟수. 넘으면 가진 것으로 생성 단계로 넘어간다.",
        "effect": "조사 깊이 ↔ 응답 지연·토큰",
    },
    {
        "key": "rag_top_k",
        "label": "RAG 주입 청크 수(top-k)",
        "group": "RAG 검색",
        "widget": "number",
        "min": 1,
        "max": 20,
        "step": 1,
        "scope": "live",
        "description": "질의당 벡터 검색에서 가져올 자료 청크의 최대 개수.",
        "effect": "근거 풍부함 ↔ 프롬프트 길이·비용",
    },
    {
        "key": "class_material_rag_enabled",
        "label": "학급 자료 검색 사용",
        "group": "RAG 검색",
        "widget": "toggle",
        "scope": "live",
        "description": "끄면 학급 자료 벡터 검색 자체를 하지 않는다(킬 스위치).",
        "effect": "학급 자료 근거 사용 여부",
    },
    {
        "key": "class_material_rag_max_distance",
        "label": "학급 자료 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": (
            "거리(= 1 − 코사인 유사도) 컷오프. 낮을수록 엄격하다. "
            "실측상 온토픽 질의는 0.50~0.56, 인사말은 0.87 부근이다."
        ),
        "effect": "무관한 자료의 프롬프트 오염 차단 ↔ 온토픽 자료 누락",
    },
    {
        "key": "figure_retrieve_max_distance",
        "label": "교과서 도판 거리 게이트",
        "group": "RAG 검색",
        "widget": "slider",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": "도판 검색에 적용하는 거리 컷오프(자료 게이트와 같은 스케일).",
        "effect": "도판 표시 엄격도",
    },
    {
        "key": "figure_pipeline_enabled",
        "label": "교과서 도판 파이프라인",
        "group": "교과서 도판",
        "widget": "toggle",
        "scope": "live",
        "description": "교과서 업로드 시 도판 추출·임베딩을 수행할지(킬 스위치).",
        "effect": "도판 인제스트 수행 여부",
    },
    {
        "key": "figure_judge_concurrency",
        "label": "도판 비전 판정 동시성",
        "group": "교과서 도판",
        "widget": "number",
        "min": 1,
        "max": 16,
        "step": 1,
        "scope": "new-only",
        "description": "도판 캡션 판정을 몇 개씩 병렬로 돌릴지. 신규 잡부터 적용된다.",
        "effect": "인제스트 속도 ↔ 판정 서버 부하",
    },
    {
        "key": "session_context_max_chars",
        "label": "세션 파일 전문 주입 예산",
        "group": "세션 파일",
        "widget": "number",
        "min": 10000,
        "max": 300000,
        "step": 10000,
        "unit": "자",
        "scope": "new-only",
        "description": (
            "학생이 세션에 올린 파일 전문을 주입할 때 세션당 합산 문자 상한. "
            "업로드 시점에 초과 파일이 거부되므로 이미 저장된 파일에는 소급되지 않는다."
        ),
        "effect": "세션 파일 근거량 ↔ 컨텍스트 길이",
    },
    {
        "key": "file_max_bytes",
        "label": "학생 업로드 최대 크기",
        "group": "업로드",
        "widget": "number",
        "min": 1048576,
        "max": 104857600,
        "step": 1048576,
        "unit": "B",
        "scope": "live",
        "description": "학생·개인 업로드 한 파일의 최대 바이트. 52428800 = 50MB.",
        "effect": "업로드 허용 크기",
    },
    {
        "key": "class_material_max_bytes",
        "label": "교사 자료 최대 크기",
        "group": "업로드",
        "widget": "number",
        "min": 1048576,
        "max": 536870912,
        "step": 10485760,
        "unit": "B",
        "scope": "live",
        "description": "교사 학급 자료 한 파일의 최대 바이트. 524288000 = 500MB.",
        "effect": "교사 자료 업로드 크기",
    },
    {
        "key": "chunk_size_chars",
        "label": "청크 크기",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 400,
        "max": 4000,
        "step": 100,
        "unit": "자",
        "scope": "new-only",
        "description": "문서를 임베딩할 때 한 청크의 글자 수. 기존 문서는 재업로드해야 반영된다.",
        "effect": "검색 단위의 정밀도 ↔ 문맥 보존",
    },
    {
        "key": "chunk_overlap_chars",
        "label": "청크 겹침",
        "group": "청킹·임베딩",
        "widget": "number",
        "min": 0,
        "max": 500,
        "step": 10,
        "unit": "자",
        "scope": "new-only",
        "description": "인접 청크가 겹치는 글자 수(경계에서 문맥이 끊기는 것을 막는다).",
        "effect": "경계 문맥 보존 ↔ 저장·임베딩 비용",
    },
    # --- PIKE-RAG (TASK 6, D129~D132) — 클램프는 각 호출부와 일치시킨다 ---
    {
        "key": "atom_rag_enabled",
        "label": "지식 원자화 + 이중 검색",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "new-only",
        "description": (
            "켜면 자료 인제스트 때 청크마다 '이 청크로 답할 수 있는 예상 질문'을 "
            "solar로 생성해 별도 컬렉션에 임베딩하고, 학생 질의 때 청크·질문 두 "
            "컬렉션을 동시에 검색한다(질문↔질문 매칭으로 재현율 보강). 켜기 전에 "
            "올린 자료에는 원자가 없다 — 재업로드해야 적용된다."
        ),
        "effect": "표현이 다른 질문의 검색 재현율 ↑ ↔ 인제스트 LLM·임베딩 비용 추가",
    },
    {
        "key": "atom_questions_per_chunk",
        "label": "청크당 예상 질문 수",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 8,
        "step": 1,
        "unit": "개",
        "scope": "new-only",
        "description": "원자화 때 청크 하나에서 생성할 예상 질문 개수.",
        "effect": "질문 표현 커버리지 ↑ ↔ 인제스트 비용 정비례",
    },
    {
        "key": "atom_top_k",
        "label": "원자 검색 top-k",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 20,
        "step": 1,
        "scope": "live",
        "description": "이중 검색에서 예상 질문 컬렉션을 몇 개까지 조회할지.",
        "effect": "원자 경유 후보 폭 ↔ 검색 지연",
    },
    {
        "key": "atom_rag_max_distance",
        "label": "원자 거리 게이트",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 0.1,
        "max": 0.9,
        "step": 0.05,
        "scope": "live",
        "description": (
            "원자(예상 질문) 히트를 채택할 최대 거리(distance = 1 − cosine). "
            "질문↔질문 매칭이라 청크 게이트(0.60)보다 엄격한 0.45가 기본 — "
            "원자로 잡힌 청크에는 청크 게이트를 다시 적용하지 않는다."
        ),
        "effect": "낮출수록 정밀 ↑ 재현율 ↓ (실측 후 조정 권장)",
    },
    {
        "key": "atom_gen_concurrency",
        "label": "원자 생성 동시 호출",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 1,
        "max": 16,
        "step": 1,
        "scope": "new-only",
        "description": "원자 질문 생성 시 solar 동시 호출 수.",
        "effect": "인제스트 속도 ↔ API 부하",
    },
    {
        "key": "rag_query_rewrite_enabled",
        "label": "검색어 정제",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "live",
        "description": (
            "자료 검색 전에 solar 1콜로 학생 질문을 검색에 적합한 자연어 의문문으로 "
            "정제한다(키워드 나열로 바꾸지 않는다 — 실측상 거리 악화). 실패하면 "
            "원문 그대로 검색한다."
        ),
        "effect": "구어체·오타 질문의 검색 품질 ↑ ↔ 자료 턴당 약 +0.8초",
    },
    {
        "key": "semantic_chunking_enabled",
        "label": "LLM 의미 청킹",
        "group": "PIKE-RAG",
        "widget": "toggle",
        "scope": "new-only",
        "description": (
            "켜면 상한 이하 크기의 문서에 한해 solar가 청크 경계를 의미 단위로 "
            "재조정한다(문단 중간 절단 방지). 어떤 실패든 기존 정규식 청킹으로 "
            "폴백하므로 인덱싱이 막히지는 않는다. 학생 세션 업로드에는 적용 안 됨."
        ),
        "effect": "청크 경계 품질 ↑ ↔ 인제스트 지연·LLM 비용",
    },
    {
        "key": "semantic_chunking_max_chars",
        "label": "의미 청킹 문서 상한",
        "group": "PIKE-RAG",
        "widget": "number",
        "min": 10000,
        "max": 500000,
        "step": 10000,
        "unit": "자",
        "scope": "new-only",
        "description": "이 글자 수를 넘는 문서는 의미 청킹 없이 정규식 청킹만 쓴다(비용 폭주 가드).",
        "effect": "적용 범위 ↔ 대형 문서 인제스트 비용",
    },
]

_SPEC_BY_KEY = {s["key"]: s for s in _SPECS}
_GROUP_ORDER = [
    "AI 흐름",
    "RAG 검색",
    "청킹·임베딩",
    "세션 파일",
    "업로드",
    "교과서 도판",
    "PIKE-RAG",
    "기타",
]


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
