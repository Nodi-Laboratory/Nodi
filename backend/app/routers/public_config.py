"""`GET /api/config` — 화면이 키 입력 UI를 띄울지 정하는 창구 (공개판 C 분류).

**true/false만 담는다.** 키 값·모델명·URL은 싣지 않는다 — 인증 없이 열려 있는
창구라 로그인 전(첫 진입) 화면에서도 부를 수 있어야 하고, 그래서 더더욱 설정
여부 외에는 아무것도 내보내지 않는다.

- `upstage_key_configured` — .env에 Upstage 키가 있다 → 키 입력 UI 숨김
- `gemini_key_configured`  — .env에 Gemini 키가 있다 → 키·모델 입력 UI 숨김
- `upload_enabled`         — 업로드 워커가 돌 수 있다(.env Upstage 키 전용)
"""

from __future__ import annotations

from fastapi import APIRouter

from ..services import api_keys

router = APIRouter(tags=["config"])


@router.get("/config")
async def public_config() -> dict[str, bool]:
    return {
        "upstage_key_configured": api_keys.upstage_env_configured(),
        "gemini_key_configured": api_keys.gemini_env_configured(),
        "upload_enabled": api_keys.upload_enabled(),
    }
