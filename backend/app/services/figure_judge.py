"""교과서 figure 비전 계열 공용 설정·유틸 (D88·D97·D134).

원래 이 모듈은 "절대거리 top-K 후보 중 선택" 판정(D93/D103)의 소유자였다.
D134(사용자 결정 2026-07-30)로 캡션이 **비전 생성 단독**(figure_caption)이 되면서
선택 로직(build_judge_messages·parse_judgment·final_embed_text·judge_all)은
제거됐다 — 남은 것은 비전 엔드포인트 계열의 공용 인프라다:

  - 설정 게이트: judge_base_url / judge_model / judge_api_key (OpenAI 호환 비전
    엔드포인트면 무엇이든 플러그형, 기본 EXAONE-4.5). **셋 중 하나라도 비면
    is_configured()가 False** — figure 캡션 생성이 불가하므로 워커가 전 행을
    no-caption failed로 처리한다(텍스트 RAG는 무관, D88).
  - image_data_uri: 크롭 이미지 → OpenAI 호환 image_url 페이로드.
  - JUDGE_TIMEOUT · CIRCUIT_BREAK_THRESHOLD: 호출 타임아웃·회로차단 임계
    (figure_caption이 임포트해 재사용 — 복제 금지).

env 이름(judge_*)은 유지한다 — 배포·문서·admin 진단(/health의 judge 블록)이
이 이름을 계약으로 쓰고 있고, "생성도 같은 판정 계열 엔드포인트를 쓴다"는
D131 결정도 이 이름 위에 서 있다.
"""
from __future__ import annotations

import base64
import logging

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.figure_judge")
settings = get_settings()

# 확장자(점 없음) → mime. figure_extract가 jpg/png만 산출하나 webp도 매핑 유지.
_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}

# 생성이 오래 걸려도 클라이언트가 먼저 끊지 않게 read는 넉넉히, connect만 짧게 —
# labs 600s에서 워커 배치 리듬에 맞춰 하향(120s), connect 10s가 죽은 엔드포인트를
# 빨리 드러낸다.
JUDGE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# 회로차단 임계치 — 연속 이만큼 실패하면 잔여 호출을 생략한다(figure_caption 소비).
CIRCUIT_BREAK_THRESHOLD = 5


def image_data_uri(image_bytes: bytes, ext: str) -> str:
    """이미지 바이트 → data URI (OpenAI 호환 image_url용). ext는 확장자(점 무관)."""
    mime = _MIME.get(ext.lower().lstrip("."), "image/png")
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


def missing_config() -> list[str]:
    """비전 호출에 필요한데 비어 있는 설정 키 이름 목록 (없으면 빈 리스트).

    D97: 진단용 — /health와 부팅 경고가 "무엇이" 빠졌는지 그대로 보여준다.
    """
    missing = []
    if not settings.judge_api_key.strip():
        missing.append("JUDGE_API_KEY")
    if not settings.judge_base_url.strip():
        missing.append("JUDGE_BASE_URL")
    if not settings.judge_model.strip():
        missing.append("JUDGE_MODEL")
    return missing


def is_configured() -> bool:
    """비전 엔드포인트가 호출 가능한 형태로 설정됐는지.

    D97: 과거에는 ``bool(judge_api_key)`` 하나만 봤다. 그 결과 **아무 문자열이나
    키 자리에 넣으면** 게이트가 열렸고, base_url이 비었거나 죽은 주소여도 업로드가
    통과한 뒤 비전 호출만 전량 실패했다 — figure 실패는 D88로 files.status와
    격리돼 있어 교사 화면에는 'indexed'로 보이고, 회로차단까지 겹쳐 잡이 빨리
    끝나므로 정상처럼 보이는 **조용한 전멸**이 된다. 세 값을 모두 요구해
    게이트를 실질화한다.

    도달성(네트워크)까지는 보지 않는다 — 부팅·업로드 경로에 외부 호출을 넣지
    않는다는 기존 방침 유지. 도달성 확인은 운영자가 /health의 judge 블록과
    부팅 경고 로그로 판단한다.
    """
    return not missing_config()
