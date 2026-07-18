"""교과서 figure 캡션 판정(D88·D93) — labs judge.py async 이식.

잘라낸 figure 이미지(base64)와 절대거리 top-K 후보를 OpenAI 호환 비전
엔드포인트(EXAONE-4.5-33B)에 보내 ``{"selected_index", "reason"}`` JSON을 받는다.
selected_index=-1은 "해당 없음".

판정 모델은 플러그형: config의 judge_base_url / judge_model / judge_api_key로
교체 가능(기본값 TTA GPU 프록시의 EXAONE-4.5-33B). judge_api_key 미설정이면
is_configured()가 False.

D93(사용자 결정 2026-07-18): 판정은 **게이트다** — 캡션은 판정이 확정하며
(위치기반 매칭 제거), 미설정이면 교과서 업로드 자체가 거부되고(files.py),
판정 실패·해당없음(-1) figure는 임베딩 없이 failed로 남는다(캡션 없는 figure는
검색에 노출하지 않는다). 개별 실패는 여전히 raise하지 않고 None으로
반환하며(호출부 워커가 failed 처리), 연속 실패가 누적되면 회로차단해 잔여
판정을 생략한다(죽은 엔드포인트에서 connect 대기가 쌓여 잡이 길어지는 사고
방지).

프롬프트 문안·요청 파라미터·salvage 규칙은 labs 실측으로 확정된 값 — 변경 금지.
labs의 judgments.json 파일 캐시는 이식하지 않는다(행 단위 멱등이 대체 — CLI
편의 기능이었음).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.figure_judge")
settings = get_settings()

# 후보 캡션 절단 상한(문자) — labs 실측값. 변경 금지.
CAND_LIMIT = 200

# 확장자(점 없음) → mime. figure_extract가 jpg/png만 산출하나 webp도 매핑 유지.
_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}

# 생성이 오래 걸려도 클라이언트가 먼저 끊지 않게 read는 넉넉히, connect만 짧게 —
# labs 600s에서 워커 배치 리듬에 맞춰 하향(120s), connect 10s가 죽은 엔드포인트를
# 빨리 드러낸다.
JUDGE_TIMEOUT = httpx.Timeout(120.0, connect=10.0)

# 회로차단 임계치 — 연속 이만큼 실패하면 잔여 판정을 생략한다.
CIRCUIT_BREAK_THRESHOLD = 5


def _clean(text: str, limit: int) -> str:
    """연속 공백(탭 포함) 정규화 + 절단 — PDF 추출 텍스트의 탭이 추론형 모델의
    reasoning 폭주를 유발함(labs e15에서 실측)."""
    return " ".join(text.split())[:limit]


def image_data_uri(image_bytes: bytes, ext: str) -> str:
    """이미지 바이트 → data URI (OpenAI 호환 image_url용). ext는 확장자(점 무관)."""
    mime = _MIME.get(ext.lower().lstrip("."), "image/png")
    return f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"


def build_judge_messages(candidates: list[str], image_data_uri: str) -> list[dict]:
    """이미지 + 번호 매긴 후보 → chat messages (단일 user 턴, 비전).

    선택 기준: '이미지를 가장 잘 설명하는 글'. 후보가 도판 캡션 형식
    ('이미지 이름 + 이미지 설명')인지 먼저 판단하게 한다. json_schema 제약 없이
    프롬프트로 JSON 출력을 지시한다 — 깨진 응답은 parse_judgment가 복구.
    """
    numbered = "\n".join(
        f"[{i}] {_clean(c, CAND_LIMIT)}" for i, c in enumerate(candidates)
    )
    prompt = (
        "당신은 교과서 편집자다. 위 이미지는 교과서 페이지에서 잘라낸 그림이고,\n"
        "아래는 그 그림 근처에 있던 텍스트 후보들이다.\n"
        "후보 중에서 이 이미지를 가장 잘 설명하는 글의 번호를 하나 골라라.\n"
        "먼저 각 후보가 이미지 캡션 형식인지 판단하라 — 캡션은 보통\n"
        "'이미지 이름(소장처 등) + 이미지에 대한 설명' 형태의 글이다.\n"
        "캡션 형식이면서 이미지와 공통된 특징(인물의 특징, 사물의 종류·재질·형태·색·구도·고유명사)이 가장 많은 후보가 그 답이다.\n"
        "어떤 후보도 이미지를 설명하지 않으면 -1을 골라라.\n"
        '다른 말 없이 다음 JSON 형식으로만 답하라: {"selected_index": 번호, "reason": "선택 근거 한 문장"}\n\n'
        f"캡션 후보:\n{numbered}"
    )
    return [{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": image_data_uri}},
            {"type": "text", "text": prompt},
        ],
    }]


_SALVAGE_RE = re.compile(r'"selected_index"\s*:\s*(-?\d+)')


def parse_judgment(content: str, n_candidates: int) -> dict:
    """모델 응답 JSON → 검증된 판정 dict. 범위 밖 index는 -1로 강등.

    JSON이 깨졌어도 selected_index가 보이면 복구한다 — thinking off에서 공백
    루프로 응답이 잘리는 사고가 간헐 발생(labs e18/e38에서 실측).
    """
    try:
        out = json.loads(content)
    except json.JSONDecodeError as exc:
        m = _SALVAGE_RE.search(content)
        if m:
            out = {"selected_index": int(m.group(1)),
                   "reason": "(응답 JSON 불완전 — selected_index만 복구)"}
        else:
            raise ValueError(f"판정 응답이 JSON이 아님: {content[:120]!r}") from exc
    idx = out.get("selected_index")
    if not isinstance(idx, int) or not (-1 <= idx < n_candidates):
        out["selected_index"] = -1
    return {
        "selected_index": out["selected_index"],
        "reason": str(out.get("reason") or ""),
    }


def final_embed_text(record: dict, selected_index: int) -> str:
    """판정이 선택한 캡션 → 임베딩 텍스트(D93: 오직 캡션만).

    D93(사용자 결정 2026-07-18): heading·alt·description은 전부 제외하고
    선택된 후보(candidates[selected_index]) 텍스트만 임베딩한다 — 질의는
    캡션 내용과 매칭되므로 다른 텍스트는 벡터를 희석한다(행 저장은 유지 —
    표시·디버그용). selected_index가 -1(해당 없음)·범위 밖이면 임베딩할
    캡션이 없다는 뜻으로 ''를 반환한다 — 워커가 해당 행을 failed 처리해
    검색에 노출하지 않는다.
    """
    candidates = record.get("candidates") or []
    if selected_index is None or not (0 <= selected_index < len(candidates)):
        return ""
    return str(candidates[selected_index]).strip()[:8000]


def is_configured() -> bool:
    """판정 엔드포인트 키가 설정됐는지 — 비어 있으면 판정 생략 신호(False)."""
    return bool(settings.judge_api_key)


async def _call_judge(
    client: httpx.AsyncClient, candidates: list[str], image_bytes: bytes, ext: str
) -> str:
    payload = {
        "model": settings.judge_model,
        "messages": build_judge_messages(candidates, image_data_uri(image_bytes, ext)),
        # EXAONE 4.5 권장 파라미터(labs 실측 — 변경 금지).
        "max_tokens": 512,
        "temperature": 1.0,
        "top_p": 0.95,
        "presence_penalty": 1.5,
        # thinking 비활성 — 형태 매칭 판정이라 reasoning 불필요하고 빠르다.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    resp = await client.post(
        f"{settings.judge_base_url.rstrip('/')}/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {settings.judge_api_key}"},
    )
    resp.raise_for_status()
    choice = resp.json()["choices"][0]
    content = choice["message"].get("content")
    if not content:
        raise ValueError(
            f"판정 응답에 content 없음 (finish_reason={choice.get('finish_reason')!r})"
        )
    return content


async def judge_one(
    client: httpx.AsyncClient, candidates: list[str], image_bytes: bytes, ext: str
) -> dict:
    """판정 1회 — JSON 깨짐/빈 응답(ValueError)이면 1회 재시도 후 raise.

    thinking off에서 공백 루프로 응답이 잘리는 사고가 간헐 발생하므로 1회
    재시도한다(labs _judge_one 규약). 재시도까지 실패하면 예외를 그대로 올린다.
    """
    try:
        content = await _call_judge(client, candidates, image_bytes, ext)
        return parse_judgment(content, len(candidates))
    except ValueError as exc:
        logger.info("판정 실패 — 재시도: %s", exc)
        content = await _call_judge(client, candidates, image_bytes, ext)
        return parse_judgment(content, len(candidates))


async def judge_all(items: list[dict], *, concurrency: int) -> list[dict | None]:
    """figure 레코드 목록을 비전 판정 — 반환 순서는 items 순서 그대로.

    items[i]는 figure_extract 레코드(candidates/image_bytes/ext 포함). 후보 없는
    레코드는 호출 없이 즉시 {"selected_index": -1, "reason": "후보 없음 — 판정
    생략"}. 나머지는 asyncio.Semaphore(concurrency)로 동시 호출을 제한한다.

    개별 실패(재시도 포함 최종 예외)는 raise하지 않고 None을 반환한다 — 호출부
    (워커)가 해당 행을 match_kind='judge-error'로 failed 처리한다(D93: 판정이
    캡션을 확정하는 게이트). 연속 CIRCUIT_BREAK_THRESHOLD회 실패 시 잔여 항목
    판정을 생략하고 전부 None으로 둔다(회로차단) — 죽은 엔드포인트에서 connect
    대기가 누적돼 잡이 길어지는 사고를 막는다.
    """
    results: list[dict | None] = [None] * len(items)
    pending: list[int] = []
    for i, r in enumerate(items):
        if not r.get("candidates"):
            results[i] = {"selected_index": -1, "reason": "후보 없음 — 판정 생략"}
        else:
            pending.append(i)
    if not pending:
        return results

    sem = asyncio.Semaphore(max(1, concurrency))
    # 회로차단 상태 — 세마포어로 직렬화된 임계 구간에서만 갱신되므로 락 불필요.
    state = {"consecutive": 0, "broken": False}

    async def worker(client: httpx.AsyncClient, i: int) -> None:
        r = items[i]
        async with sem:
            if state["broken"]:
                return  # 회로 개방 — 잔여 판정 생략(None 유지)
            try:
                results[i] = await judge_one(
                    client, r["candidates"], r["image_bytes"], r["ext"]
                )
                state["consecutive"] = 0
            except Exception as exc:  # 재시도 포함 최종 실패 — 강등(raise 금지)
                results[i] = None
                state["consecutive"] += 1
                if (
                    state["consecutive"] >= CIRCUIT_BREAK_THRESHOLD
                    and not state["broken"]
                ):
                    state["broken"] = True
                    logger.warning(
                        "figure 판정 연속 %d회 실패 — 잔여 판정 생략(회로차단): %s",
                        CIRCUIT_BREAK_THRESHOLD, exc,
                    )

    async with httpx.AsyncClient(timeout=JUDGE_TIMEOUT) as client:
        await asyncio.gather(*(worker(client, i) for i in pending))
    return results
