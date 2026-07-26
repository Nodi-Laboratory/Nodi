"""`nodi.*` 로거 배선 + 부팅 시 설정 요약 (D97).

**왜 필요했나**: 서비스 코드는 전부 `logging.getLogger("nodi.*")`로 로그를
남기는데, uvicorn 기본 설정은 자기 로거(`uvicorn.*`)에만 핸들러를 붙인다.
그래서 RAG 주입 결과·figure 판정 실패 같은 관측 정보가 **어디에도 출력되지
않았다**(TASK 2 잔여 메모 ③). figure 판정이 전량 실패해도 화면·로그 어디에도
흔적이 없어 "조용한 전멸"이 성립한 원인 중 하나다.

부팅 요약은 여기에 둔다 — 신규 팀원이 서버를 처음 띄우는 순간 자기 환경에
무엇이 빠졌는지 터미널에서 바로 본다. 외부 네트워크 호출은 하지 않는다
(설정이 채워졌는지만 본다 — 도달성은 운영자가 /health/config로 판단).
"""

from __future__ import annotations

import logging
import sys

from .config import get_settings
from .services import figure_judge

logger = logging.getLogger("nodi.startup")


def configure_logging() -> None:
    """`nodi` 루트 로거에 stdout 핸들러를 1회 부착 (멱등).

    이미 핸들러가 있으면(테스트 하네스·상위 배포 설정이 붙였을 수 있다)
    건드리지 않는다. `propagate=False`로 root 로거 중복 출력을 막는다.
    """
    nodi = logging.getLogger("nodi")
    if nodi.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(levelname)s [%(name)s] %(message)s")
    )
    nodi.addHandler(handler)
    nodi.setLevel(logging.INFO)
    nodi.propagate = False


def log_config_summary() -> None:
    """부팅 시 통합 설정 상태를 1회 출력 — 빠진 값은 WARNING으로 승격.

    비밀은 찍지 않는다(존재 여부만). /health/config의 판정 기준과 동일하게
    유지한다 — 둘이 어긋나면 진단이 서로를 반박하게 된다.
    """
    s = get_settings()

    def mark(ok: bool) -> str:
        return "OK  " if ok else "MISSING"

    supabase_ok = bool(s.supabase_url and s.supabase_anon_key)
    logger.info("--- nodi 설정 점검 (environment=%s) ---", s.environment)
    logger.info("  Supabase      : %s (service_role=%s)",
                mark(supabase_ok), mark(bool(s.supabase_service_role_key)))
    logger.info("  EXAONE        : %s (%s)", mark(bool(s.exaone_api_key)),
                "dedicated" if s.exaone_endpoint_id else "serverless")
    logger.info("  Upstage       : %s", mark(bool(s.upstage_api_key)))
    logger.info("  Qdrant        : %s", s.qdrant_url or "MISSING")
    logger.info("  figure 판정   : %s", mark(figure_judge.is_configured()))

    if not supabase_ok:
        logger.warning(
            "SUPABASE_URL/SUPABASE_ANON_KEY 미설정 — 인증·데이터 접근이 전부 "
            "실패한다. 설정 파일 위치는 backend/.env 다(루트 .env 아님)."
        )
    if not s.supabase_service_role_key:
        logger.warning(
            "SUPABASE_SERVICE_ROLE_KEY 미설정 — 파일 업로드·임베딩 워커가 503."
        )
    if not s.exaone_api_key:
        logger.warning("EXAONE_API_KEY 미설정 — 채팅 스트리밍이 503.")
    if not s.upstage_api_key:
        logger.warning(
            "UPSTAGE_API_KEY 미설정 — 임베딩·문서 파싱 불가로 RAG 전체가 동작하지 "
            "않는다."
        )

    missing_judge = figure_judge.missing_config()
    if missing_judge and s.figure_pipeline_enabled:
        logger.warning(
            "figure 판정 미설정(%s) — 교과서(textbook) 업로드가 503으로 거부된다. "
            "교과서 기능을 쓰지 않는 환경이면 정상이다.",
            ", ".join(missing_judge),
        )
