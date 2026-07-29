"""LLM 의미 청킹 — resplit 경계 재조정 (D119).

PIKE-RAG의 `LLMPoweredRecursiveSplitter` resplit 단계를 이식한다: 정규식/문단
기반 1차 분할이 잘라 놓은 인접 두 청크를 이어붙여 "창"을 만들고, 그 안에서
**의미가 끊기는 가장 적절한 줄**을 solar가 고르게 해 경계를 재조정한다. 원본의
'요약 전파(propagate summary)'는 v1에서 생략한다 — 요약 품질·비용 검증이 끝나기
전에 도입하면 잘못된 요약이 하류 청크로 번지고, 현재 목표(경계 정확도)에는
불필요하다.

핵심 규약:
- 내부 1차 분할은 `embedding.chunk_text(text, size, 0)` — **오버랩 0**. 인접 청크를
  이어붙여 창을 만들 때 오버랩이 있으면 같은 텍스트가 두 창에 중복되어 경계
  재조정이 꼬인다. 의미 경계가 오버랩(문맥 연속성 보조)의 목적을 대신하므로,
  호출부가 넘긴 `overlap` 인자는 이 경로에서 쓰지 않는다(폴백은 호출부 몫).
- solar 예외·깨진 응답은 **함수 밖으로 내보내지 않는다**. 해당 경계만 정규식
  1차 분할 그대로로 강등하고 계속한다(불변식: RAG는 채팅/인제스트를 막지 않는다).
- 콜 수 상한(`semantic_chunking_max_llm_calls`)·연속 실패 회로차단(5회)으로
  폭주를 막고, 남은 경계는 정규식대로 확정한다.
- 텍스트 유실·중복 금지: 창을 줄 단위로 잘라 `lines[:N]` 확정 / `lines[N:]` 이월만
  하므로, 전 청크를 이어붙이면(공백 정규화 후) 원문이 보존된다.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Awaitable, Callable

from ..config import get_settings
from . import embedding, solar

logger = logging.getLogger("nodi.semantic_chunker")

settings = get_settings()

# figure_judge `_SALVAGE_RE`와 같은 발상 — thinking off에서 응답 JSON이 잘려도
# endline 숫자만 보이면 복구한다(labs 실측: 공백 루프로 꼬리 유실이 간헐 발생).
_SALVAGE_RE = re.compile(r'"endline"\s*:\s*(\d+)')

# 연속 실패 회로차단 임계 — 5회 내리 파싱 실패면 남은 경계를 정규식으로 확정하고
# 나머지 콜을 아낀다(모델이 이 문서에서 endline을 못 내는 상태로 판단).
_MAX_CONSECUTIVE_FAILURES = 5

_SYSTEM_PROMPT = (
    "너는 한국어 문서의 의미 경계를 찾는 도구다. 번호가 매겨진 여러 줄이 주어지면, "
    "앞부분과 뒷부분의 의미가 가장 자연스럽게 끊기는 줄 번호 하나를 고른다. "
    '반드시 {"endline": N} 형식의 JSON 하나만 출력한다. 다른 말·설명·코드블록은 '
    "붙이지 않는다. N은 그 줄까지(포함)를 앞 조각으로 묶는다는 뜻이다."
)


def build_resplit_messages(lined_text: str, max_line: int) -> list[dict]:
    """resplit 질의용 시스템+유저 메시지 구성.

    `lined_text`는 이미 "1: …\\n2: …" 로 번호 매긴 창 텍스트다. 유저 메시지는
    유효 범위(1~max_line)를 못박고, 의미가 끊기는 줄 번호를 JSON으로만 달라고
    한국어로 지시한다.
    """
    user = (
        f"다음은 번호가 매겨진 {max_line}개의 줄이다. 의미가 끊기는 가장 적절한 "
        f'줄 번호를 1부터 {max_line} 사이에서 하나 골라 {{"endline": N}} JSON으로만 '
        "답하라.\n\n"
        f"{lined_text}"
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def parse_endline(content: str, max_line: int) -> int | None:
    """모델 응답 → 검증된 endline. 깨졌거나 범위 밖이면 None.

    `json.loads` 우선, 실패 시 `_SALVAGE_RE`로 숫자만 복구. 최종적으로
    `1 <= N <= max_line`을 강제한다(밖이면 None → 호출부가 정규식 경계로 강등).
    """
    n: int | None = None
    try:
        obj = json.loads(content)
        raw = obj.get("endline") if isinstance(obj, dict) else None
        if isinstance(raw, bool):
            raw = None
        if isinstance(raw, int):
            n = raw
        elif isinstance(raw, str) and raw.strip().isdigit():
            n = int(raw.strip())
    except (json.JSONDecodeError, TypeError):
        n = None
    if n is None:
        m = _SALVAGE_RE.search(content or "")
        if m:
            n = int(m.group(1))
    if n is None or not (1 <= n <= max_line):
        return None
    return n


def _number_lines(lines: list[str]) -> str:
    """창의 줄들을 "1: …\\n2: …" 로 번호 매긴다."""
    return "\n".join(f"{i}: {ln}" for i, ln in enumerate(lines, 1))


async def chunk_text_semantic(
    text: str,
    size: int,
    overlap: int,
    *,
    heartbeat: Callable[[], Awaitable[None]] | None = None,
) -> list[str]:
    """정규식 1차 분할 → solar 경계 재조정 청크 리스트.

    호출부(split.py, Task 6-10)가 전체를 try/except로 감싸 예외 시
    `embedding.chunk_text(text, size, overlap)`로 폴백하지만, 여기서도 solar
    예외·깨진 응답은 해당 경계만 정규식으로 강등해 함수 밖으로 새지 않게 한다.

    `heartbeat`는 10콜마다 await되어 워커 잡이 죽지 않게 심박을 찍는다(D119).
    """
    base = embedding.chunk_text(text, size, 0)
    if len(base) < 2:
        return base

    max_calls = settings.semantic_chunking_max_llm_calls

    # 크기 가드 상한: resplit 창은 인접 두 청크(base[idx]+base[idx+1])이므로
    # 정상 경계는 조각 하나가 창(≈2*size)을 넘을 수 없다. 상수 2는 이 설계에서
    # 자연스러운 상한. 모델이 매 콜 endline=1처럼 극단을 반환하면 remainder가
    # 반복마다 누적돼(파싱 실패가 아니라 회로차단도 안 걸린다) 하나의 초대형
    # 청크로 이월된다 — embedding-passage 벡터 희석·API 절단 위험. 이월/확정
    # 조각이 이 상한을 넘으면 정규식으로 잘라 확정한다(D119, task6-fix3).
    max_chunk = size * 2

    result: list[str] = []

    def _emit(piece: str) -> None:
        """result에 조각을 확정하되, max_chunk 초과 시 정규식으로 강등해 자른다."""
        if len(piece) > max_chunk:
            result.extend(embedding.chunk_text(piece, size, 0))
        else:
            result.append(piece)

    remainder = ""  # 직전 창에서 이월된 꼬리(lines[N:])
    idx = 0
    total_calls = 0
    consecutive_failures = 0
    circuit_broken = False

    while idx < len(base):
        # 가드: 마지막 단일 조각 / 회로차단 / 콜 상한 → 잔여를 정규식대로 확정
        if circuit_broken or total_calls >= max_calls or idx + 1 >= len(base):
            break

        window_parts = [p for p in (remainder, base[idx], base[idx + 1]) if p]
        lines = "\n".join(window_parts).split("\n")
        max_line = len(lines)
        lined = _number_lines(lines)

        n: int | None = None
        try:
            total_calls += 1
            completion = await solar.complete(
                build_resplit_messages(lined, max_line), max_tokens=128
            )
            content = (completion.message or {}).get("content") or ""
            n = parse_endline(content, max_line)
        except Exception:  # noqa: BLE001 — solar 예외는 경계만 정규식으로 강등
            logger.warning("resplit solar 콜 실패 — 이 경계는 정규식 유지", exc_info=True)
            n = None

        if heartbeat is not None and total_calls % 10 == 0:
            await heartbeat()

        if n is None:
            # 경계 결정 실패: base[idx]를 (이월분과 함께) 정규식 경계로 확정
            _emit("\n".join(p for p in (remainder, base[idx]) if p))
            remainder = ""
            idx += 1
            consecutive_failures += 1
            if consecutive_failures >= _MAX_CONSECUTIVE_FAILURES:
                circuit_broken = True
        else:
            _emit("\n".join(lines[:n]))
            remainder = "\n".join(lines[n:])
            idx += 2
            consecutive_failures = 0
            # 이월분이 창 상한을 넘으면(endline=1 반복 등) 정규식으로 잘라 확정,
            # 다음 창으로 초대형 꼬리가 누적 이월되는 것을 끊는다.
            if len(remainder) > max_chunk:
                result.extend(embedding.chunk_text(remainder, size, 0))
                remainder = ""

    # 잔여 확정: 이월분을 첫 잔여 조각에 붙이고 나머지는 정규식 경계 그대로
    tail = list(base[idx:])
    if remainder:
        if tail:
            tail[0] = remainder + "\n" + tail[0]
        else:
            tail = [remainder]
    for t in tail:
        if t:
            _emit(t)

    return [c for c in (c.strip() for c in result) if c]
