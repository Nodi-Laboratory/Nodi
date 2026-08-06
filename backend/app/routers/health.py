"""Health / readiness endpoints (no auth).

D97: `/health/config`는 **환경 자가진단 창구**다. 신규 팀원이 자기 `.env`에
무엇이 빠졌는지 브라우저 한 번으로 확인한다.

D104: Supabase 3종(url/anon/service_role) 대신 Postgres DSN 2종을 본다.

**비밀값은 절대 노출하지 않는다** — 존재 여부(bool)와 비밀이 아닌 URL·모델명만.
네트워크 도달성도 확인하지 않는다(헬스 경로에 외부 호출 금지).
"""

from __future__ import annotations

from fastapi import APIRouter

from ..config import get_settings
from ..services import figure_judge, ocr

router = APIRouter(tags=["health"])
settings = get_settings()


def _dsn_host(dsn: str) -> str | None:
    """DSN에서 비밀번호를 뺀 host/db만. 진단에 자격증명을 싣지 않는다."""
    if not dsn:
        return None
    tail = dsn.rsplit("@", 1)[-1]
    return tail or None


@router.get("/health")
async def health() -> dict:
    """Liveness probe + 어떤 통합이 구성됐는지 한눈에.

    비밀값은 노출하지 않는다 — 존재 여부만.
    """
    return {
        "status": "ok",
        "service": "nodi-backend",
        "environment": settings.environment,
        "db_configured": bool(settings.database_url),
        "worker_configured": bool(settings.database_worker_url),
    }


async def config_report() -> dict:
    # async가 된 이유: 킬 스위치(`ocr_enabled`)가 admin 노브라 오버레이를 읽어야
    # 하고, 그 읽기가 비동기다. 호출부는 둘 다 async 핸들러다(admin·health) —
    # 부팅 로그는 이 함수를 안 쓴다(logging_setup은 figure_judge를 직접 본다).

    """설정 자가진단 페이로드.

    D116: 라우트에서 떼어 함수로 뺐다. 같은 내용을 운영 콘솔이 **관리자 인증을
    거쳐** 받아야 하기 때문이다(`/api/admin/env`). 아래 `/health/config`는
    서버에 들어가서 치는 로컬 진단 창구로 남는다 — 백엔드는 127.0.0.1에만
    바인딩하고, 프론트가 이 경로를 외부로 프록시하지 않는다.

    비밀값은 담지 않는다는 규칙은 그대로다. 그래도 공개는 하지 않는다 —
    `secret_is_default`·`jwt_algorithm`·내부 경로는 공격자에게 정찰 정보다.
    """
    database = {
        "app_dsn_set": bool(settings.database_url),
        # 미설정이면 업로드·임베딩 워커가 전부 503 (구 service_role 부재와 동형).
        "worker_dsn_set": bool(settings.database_worker_url),
        "host": _dsn_host(settings.database_url),
    }
    database["configured"] = database["app_dsn_set"]

    auth = {
        "jwt_algorithm": settings.jwt_algorithm,
        "expire_minutes": settings.jwt_expire_minutes,
        # 기본 시크릿이면 누구나 토큰을 위조할 수 있다 — 운영 전 반드시 교체.
        "secret_is_default": settings.jwt_secret == "dev-only-change-me",
        "configured": bool(settings.jwt_secret),
    }

    # D108: 대화 생성도 Upstage로 옮겨져 키가 하나다. 그래도 블록은 둘로
    # 나눠 둔다 — 무엇이 안 되는지(생성인지 임베딩인지)가 진단에서 갈린다.
    chat = {
        "api_key_set": bool(settings.upstage_api_key),
        "model": settings.upstage_chat_model,
        "base_url": settings.upstage_base_url,
    }
    chat["configured"] = chat["api_key_set"]

    upstage = {
        "api_key_set": bool(settings.upstage_api_key),
        "base_url": settings.upstage_base_url,
        "embedding_query_model": settings.upstage_embedding_query_model,
        "embedding_passage_model": settings.upstage_embedding_passage_model,
    }
    upstage["configured"] = upstage["api_key_set"]

    judge_missing = figure_judge.missing_config()
    judge = {
        "configured": not judge_missing,
        "missing": judge_missing,
        "base_url": settings.judge_base_url or None,
        "model": settings.judge_model or None,
        "pipeline_enabled": settings.figure_pipeline_enabled,
        # ⚠️ **폴백이 아니다** (D134, 점검 2026-08-06에서 바로잡음).
        #
        # D103 시절에는 파서 라벨이 본선이고 비전이 폴백이었다. D134가 그걸
        # 뒤집었다 — 캡션은 **비전 생성이 단독으로** 만들고 폴백이 없다
        # (`services/worker/figures.py` 머리말: "judge 계열 미설정이면 생성
        # 자체가 불가하므로 전 행 no-caption failed").
        #
        # 그런데 이 문구는 옛 설명 그대로였다. 관리자가 "일부만 안 된다"로 읽고
        # 급한 문제로 안 볼 수 있는데, 실제로는 **교과서 도판이 하나도 검색에
        # 안 뜬다.** 진단이 사실보다 낙관적이면 없느니만 못하다.
        "role": "required-for-figures",
        "note": (
            "미설정이면 교과서 도판이 **하나도** 검색에 안 뜬다(캡션 생성이 "
            "불가하므로 전 도판이 실패). 텍스트 인덱싱과 업로드 자체는 정상이다."
        ),
    }

    # D176: 손글씨 OCR. base_url이 비면 judge 호스트에서 유도하므로, 진단에는
    # **실제로 부를 주소**를 싣는다(유도값인지 명시값인지가 여기서 갈린다).
    # 킬 스위치는 **오버레이**가 정한다 — config만 보면 관리자가 끈 것을
    # 진단이 모른다(점검 2026-08-06).
    ocr_missing = ocr.missing_config()
    ocr_enabled = (await ocr.read_knobs())["enabled"]
    if not ocr_enabled:
        ocr_missing = [*ocr_missing, "OCR_ENABLED(관리자가 껐음)"]
    ocr_block = {
        "configured": not ocr_missing,
        "missing": ocr_missing,
        "base_url": ocr.resolve_base_url() or None,
        "derived_from_judge": not settings.ocr_base_url.strip(),
        "enabled": ocr_enabled,
        "role": "optional",
        "note": (
            "미설정이어도 채팅은 정상이다. 프롬프트창의 펜 입력만 '준비 중'으로 "
            "안내된다(501)."
        ),
    }

    qdrant = {"url": settings.qdrant_url, "configured": bool(settings.qdrant_url)}
    storage = {"root": settings.storage_root, "bucket": settings.storage_bucket}

    # 채팅 한 턴이 불가능하게 만드는 항목들 — 비어 있어야 정상.
    blocking: list[str] = []
    if not database["configured"]:
        blocking.append("database")
    if not chat["configured"]:
        blocking.append("chat")
    if not upstage["configured"]:
        blocking.append("upstage")

    return {
        "ready": not blocking,
        "blocking": blocking,
        "environment": settings.environment,
        "database": database,
        "auth": auth,
        "chat": chat,
        "upstage": upstage,
        "qdrant": qdrant,
        "storage": storage,
        "judge": judge,
        "ocr": ocr_block,
    }


@router.get("/health/config")
async def health_config() -> dict:
    """설정 자가진단 — 신규 환경에서 무엇이 빠졌는지 한눈에 본다.

    `ready`는 **채팅 한 턴이 성립하는 최소 조건**이다(DB + Upstage).
    파일 업로드는 worker DSN이, 교과서는 judge가 추가로 필요하므로 각 블록의
    `configured`를 따로 본다.

    **외부에 공개되지 않는다** — 배포에서 프론트가 `/health`(liveness)만
    프록시한다. 서버에서 `curl localhost:8000/health/config`로 본다.
    """
    return await config_report()
