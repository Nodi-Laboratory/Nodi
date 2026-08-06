"""세션 파일 전문 주입(D83·D84·D85) — 학생 user_upload를 임베딩 없이 컨텍스트로.

빌더는 best-effort: 어떤 실패도 채팅을 막지 않는다(None 반환). 청크 본문은
USER 스코프 클라이언트로 조회해 RLS가 재검증한다(Qdrant 무접촉 — 신뢰 경계
무관). 파일 순서는 created_at asc 고정 — 턴 간 프롬프트 프리픽스를 보존해
Friendli 프리픽스 캐시를 살린다(D85).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings

settings = get_settings()
logger = logging.getLogger("nodi.session_context")


async def build_session_file_context(
    client: UserClient, session_id: str
) -> dict[str, Any] | None:
    """세션에 연결된 user_upload(indexed) 파일 전문을 업로드 순으로 이어붙인다.

    Returns ``{"block": str, "files": [{file_id, name, chars}]}`` or ``None``.
    D84 이중 방어: 워커 게이트가 정상 경로를 막으므로 여기 초과 도달은 admin이
    예산을 낮춘 뒤 등 예외 상황 — 부분 절단(환각 유발) 대신 파일 단위 제외.
    """
    try:
        files = await client.select(
            "files",
            {
                "session_id": f"eq.{session_id}",
                "kind": "eq.user_upload",
                "status": "eq.indexed",
                "select": "id,name,context_chars,created_at",
                "order": "created_at.asc",
            },
        )
        if not files:
            return None
        overlay = await app_settings.get_overlay()
        budget = app_settings.as_int(
            overlay,
            "session_context_max_chars",
            settings.session_context_max_chars,
            10_000,
            # D195: 상한은 solar-pro3 윈도(131,072토큰)에 묶인다 — 180K자 ≈
            # 78K 토큰(한국어 최악 2.31자/토큰). 워커 게이트와 같은 값이어야
            # 저장은 통과하고 주입만 빠지는 어긋남이 안 생긴다.
            180_000,
        )
        parts: list[str] = []
        metas: list[dict[str, Any]] = []
        used = 0
        for f in files:
            declared = f.get("context_chars") or 0
            if used + declared > budget:
                logger.warning(
                    "세션 컨텍스트 예산 초과로 파일 제외: session=%s file=%s",
                    session_id, f.get("id"),
                )
                continue
            # 예산 상한 300K자 ≈ 청크 250행 — PostgREST 기본 max-rows(1000) 이내.
            chunks = await client.select(
                "file_chunks",
                {
                    "file_id": f"eq.{f['id']}",
                    "select": "seq,chunk_text",
                    "order": "seq.asc",
                },
            )
            if not chunks:
                continue
            # 오버랩 0으로 저장(D83)되어 그대로 이어붙이면 원문이 복원된다.
            text = "".join(c.get("chunk_text") or "" for c in chunks)
            name = f.get("name") or "업로드 파일"
            parts.append(f"[세션 파일: {name}]\n{text}")
            metas.append(
                {"file_id": f.get("id"), "name": name, "chars": len(text)}
            )
            used += declared
        if not parts:
            return None
        return {"block": "\n\n".join(parts), "files": metas}
    except Exception:  # noqa: BLE001 - 주입 실패가 채팅을 막으면 안 된다
        logger.exception("세션 파일 컨텍스트 구축 실패")
        return None

