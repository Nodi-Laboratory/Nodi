"""학급 수업 자료 검색 스킬 (D109).

기존 `rag.build_rag_context`가 하던 일을 **모델이 부를 때만** 한다. 예전에는
학급 세션의 모든 턴에서 무조건 돌았다 — 인사에도 질의 임베딩과 Qdrant 검색이
나갔다는 뜻이다.

검색 자체(`rag.search`)와 거리 게이트·튜너블은 그대로 재사용한다. 바뀐 것은
**언제 부르느냐**뿐이다.
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import get_settings
from ...services import app_settings, rag, solar
from ..base import SkillBase, SkillContext, SkillResult

logger = logging.getLogger("nodi.ai.skill.class_material")
settings = get_settings()

# 모델에게 돌려줄 청크 본문 길이 상한(자). 전문을 그대로 실으면 다음 LLM 호출
# 입력이 그만큼 커진다 — 근거로 쓰기엔 이 정도면 충분하다.
_SNIPPET_CHARS = 700


async def _refine_query(query: str) -> str:
    """D117: 검색어 정제 — 지시대명사·구어체 잔재를 풀어낸 자연어 의문문으로.

    best-effort: 실패·빈 응답이면 원문 그대로. **키워드화 금지** — embedding-query는
    자연어 질문으로 학습돼 있어 줄일수록 거리가 나빠진다(위 parameters 실측 주석).
    """
    try:
        completion = await solar.complete(
            [
                {"role": "system", "content": (
                    "학생 질문을 검색용으로 정제한다. 지시대명사('그것/이거')를 "
                    "구체적 명사로 바꾸고 오탈자를 고치되, **완전한 자연어 의문문 "
                    "형태를 유지**하라. 키워드 나열로 줄이지 마라. 이미 명확하면 "
                    "그대로 돌려줘라. 정제된 질문 한 문장만 출력하라."
                )},
                {"role": "user", "content": query},
            ],
            max_tokens=128,
        )
        refined = (completion.message.get("content") or "").strip()
        return refined or query
    except Exception:  # noqa: BLE001 - 정제 실패가 검색을 막지 않는다
        logger.warning("검색어 정제 실패 — 원문으로 검색", exc_info=True)
        return query


class SearchClassMaterialSkill(SkillBase):
    name = "search_class_material"
    description = (
        "선생님이 이 학급에 올린 수업 자료·교과서 본문에서 질문과 관련된 부분을 "
        "찾는다. 수업 내용·교과서에 근거해 답해야 할 때 쓴다. "
        "인사나 잡담, 일반 상식으로 충분한 질문에는 쓰지 마라."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                # 실측(2026-07-28)으로 확인한 규칙이다. 같은 자료·같은 의도인데
                # 표현만 바꿔도 거리가 크게 달라진다:
                #   "광합성에서 명반응이 어디서 일어나?" 0.543 (통과)
                #   "광합성 명반응 위치"                 0.604 (차단)
                #   "명반응 장소"                        0.740 (차단)
                # 검색용 임베딩(embedding-query)이 **자연어 질문**으로 학습돼
                # 있어서, 키워드로 줄일수록 오히려 못 찾는다. 모델이 요약하려는
                # 습관을 여기서 눌러 준다.
                "description": (
                    "학생이 물어본 문장을 **그대로** 넣어라. 키워드로 줄이거나 "
                    "명사구로 바꾸지 마라 — 짧게 줄일수록 검색 정확도가 떨어진다. "
                    "예: '광합성 명반응 위치'(나쁨) → "
                    "'광합성에서 명반응이 어디서 일어나?'(좋음)"
                ),
            }
        },
        "required": ["query"],
    }

    async def run(self, args: dict[str, Any], ctx: SkillContext) -> SkillResult:
        query = (args.get("query") or "").strip()
        if not query:
            return SkillResult(
                ok=False, message="검색어가 비어 있습니다.", error_code="bad_args"
            )
        if ctx.space_kind != "class" or not ctx.space_ref:
            # 카탈로그가 막아 주지만, 모델이 이름을 지어 부를 수 있으므로 방어.
            return SkillResult(
                ok=False,
                message="개인 공간에는 학급 자료가 없습니다.",
                error_code="wrong_scope",
            )

        overlay = await app_settings.get_overlay()
        if not app_settings.as_bool(
            overlay, "class_material_rag_enabled", settings.class_material_rag_enabled
        ):
            return SkillResult(
                ok=False,
                message="자료 검색이 꺼져 있습니다.",
                error_code="disabled",
            )

        file_ids = await rag.class_material_file_ids(ctx.client, ctx.space_ref)
        if not file_ids:
            return SkillResult(
                ok=True,
                message="이 학급에 올라온 수업 자료가 아직 없습니다.",
                data={"chunks": []},
            )

        # D117: 검색어 정제 — 지시대명사·구어체를 자연어 의문문으로 풀어 검색
        # 정확도를 올린다. query 확정 단계이므로 이중 검색 분기보다 **앞**에 둔다.
        if app_settings.as_bool(
            overlay, "rag_query_rewrite_enabled", settings.rag_query_rewrite_enabled
        ):
            query = await _refine_query(query)

        max_dist = app_settings.as_float(
            overlay,
            "class_material_rag_max_distance",
            settings.class_material_rag_max_distance,
            0.1,
            0.9,
        )
        use_atoms = app_settings.as_bool(
            overlay, "atom_rag_enabled", settings.atom_rag_enabled
        )
        if use_atoms:
            # D116: 이중 검색은 게이트(직접 0.60/원자 0.45)를 내부에서 끝냈다 —
            # 여기서 재게이트하면 원자 경유 청크(distance=None)가 다 죽는다.
            chunks = await rag.dual_search(ctx.client, file_ids, query)
        else:
            chunks = await rag.search(ctx.client, file_ids, query)
            # 거리 게이트 — 무관한 청크가 근거로 새는 것을 막는다(D73).
            chunks = [
                c for c in chunks
                if c.get("distance") is not None and c["distance"] <= max_dist
            ]
        if not chunks:
            return SkillResult(
                ok=True,
                message="질문과 충분히 가까운 자료를 찾지 못했습니다.",
                data={"chunks": []},
            )

        hit_ids = list({c.get("file_id") for c in chunks if c.get("file_id")})
        names = await rag.file_names(ctx.client, hit_ids)
        items = [
            {
                "file": names.get(c.get("file_id")) or "자료",
                "text": (c.get("chunk_text") or "")[:_SNIPPET_CHARS],
                # D116: 원자 경유 청크는 청크 벡터 거리를 알 수 없어 distance=None —
                # round() 전에 가드하지 않으면 TypeError로 스킬이 죽는다.
                "distance": (
                    round(float(c["distance"]), 3)
                    if c.get("distance") is not None
                    else None
                ),
            }
            for c in chunks
        ]
        logger.info("스킬 자료 검색: files=%d chunks=%d", len(hit_ids), len(items))
        return SkillResult(
            ok=True,
            message=f"수업 자료에서 {len(items)}곳을 찾았습니다.",
            data={
                "chunks": items,
                # 출처 칩(D32/D74)에 쓰는 형태 — 오케스트레이터가 노드에 실어 준다.
                "sources": rag.build_sources(chunks, names),
            },
        )
