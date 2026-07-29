"""semantic_chunker.chunk_text_semantic 순수부 테스트 (D119, Task 6-9).

전부 mock — solar.complete 대역과 embedding.chunk_text 통제로 경계 재조정
로직만 검증한다(네트워크·키 불필요). 계획서 Step 1의 9케이스를 그대로 옮긴다.
"""

from __future__ import annotations

import re
import types

from app.services import semantic_chunker as sc


# --- 대역 배선 ------------------------------------------------------------


def _wire_solar(monkeypatch, content_fn):
    """`sc.solar.complete`를 기록 fake로 교체.

    content_fn(messages, call_no) -> str | Exception. Exception이면 raise해
    solar 예외 강등 경로를 태운다. 그 외엔 Completion 계약대로
    message={"content": ...}를 돌려준다.
    """
    calls: dict = {"count": 0}

    async def fake_complete(messages, *a, **kw):
        calls["count"] += 1
        out = content_fn(messages, calls["count"])
        if isinstance(out, Exception):
            raise out
        return types.SimpleNamespace(message={"content": out})

    monkeypatch.setattr(sc.solar, "complete", fake_complete)
    return calls


def _fixed_base(monkeypatch, chunks):
    """embedding.chunk_text를 고정 리스트로 대체 — 경계 로직만 결정론적으로 본다."""

    def fake_chunk_text(text, size=None, overlap=None):
        return list(chunks)

    monkeypatch.setattr(sc.embedding, "chunk_text", fake_chunk_text)


def _count_numbered(messages) -> int:
    """유저 메시지의 번호 매긴 줄 수 = max_line."""
    text = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            text = m.get("content", "")
            break
    return len(re.findall(r"(?m)^\s*\d+:", text))


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s)


# --- parse_endline 단위 --------------------------------------------------


def test_parse_endline_정상_json():
    assert sc.parse_endline('{"endline": 3}', 5) == 3


def test_parse_endline_salvage():
    # 깨진 JSON이라도 정규식으로 endline만 복구
    assert sc.parse_endline('쓰레기 {"endline": 2} 꼬리', 5) == 2


def test_parse_endline_범위밖_None():
    assert sc.parse_endline('{"endline": 9}', 5) is None
    assert sc.parse_endline('{"endline": 0}', 5) is None


def test_parse_endline_숫자없음_None():
    assert sc.parse_endline("숫자 없는 응답", 5) is None


# --- chunk_text_semantic 통합 --------------------------------------------


async def test_정상_endline_경계가_3행에서_갈린다(monkeypatch):
    _fixed_base(monkeypatch, ["a1\na2\na3", "b1\nb2\nb3"])
    _wire_solar(monkeypatch, lambda msgs, n: '{"endline": 3}')

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert out == ["a1\na2\na3", "b1\nb2\nb3"]


async def test_깨진_json_salvage로_복구(monkeypatch):
    _fixed_base(monkeypatch, ["a1\na2\na3", "b1\nb2\nb3"])
    _wire_solar(monkeypatch, lambda msgs, n: '노이즈{"endline": 3}노이즈')

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert out == ["a1\na2\na3", "b1\nb2\nb3"]


async def test_salvage_불가면_정규식_경계_유지(monkeypatch):
    base = ["a1\na2\na3", "b1\nb2\nb3"]
    _fixed_base(monkeypatch, base)
    _wire_solar(monkeypatch, lambda msgs, n: "숫자 없음")

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    # 경계를 못 정하면 base 경계 그대로
    assert out == base


async def test_solar_예외면_정규식_경계_유지(monkeypatch):
    base = ["a1\na2\na3", "b1\nb2\nb3"]
    _fixed_base(monkeypatch, base)
    _wire_solar(monkeypatch, lambda msgs, n: RuntimeError("solar 다운"))

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert out == base  # 예외가 함수 밖으로 새지 않고 base와 동일


async def test_연속_5회_실패시_회로차단_이후_미호출(monkeypatch):
    # 항상 파싱 실패 → 5회 후 회로 차단, 잔여는 solar 없이 정규식 확정
    _fixed_base(monkeypatch, [f"c{i}" for i in range(12)])
    calls = _wire_solar(monkeypatch, lambda msgs, n: "실패")

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert calls["count"] == 5
    # 텍스트 유실 없음
    assert _norm("".join(out)) == _norm("".join(f"c{i}" for i in range(12)))


async def test_max_llm_calls_도달시_잔여_미호출(monkeypatch):
    monkeypatch.setattr(sc.settings, "semantic_chunking_max_llm_calls", 3)
    # 모든 콜 유효(endline=max_line → 창 전체 확정, 잉여 remainder 없음)
    _fixed_base(monkeypatch, [f"c{i}" for i in range(40)])
    calls = _wire_solar(
        monkeypatch, lambda msgs, n: f'{{"endline": {_count_numbered(msgs)}}}'
    )

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert calls["count"] == 3
    assert _norm("".join(out)) == _norm("".join(f"c{i}" for i in range(40)))


async def test_하트비트는_10콜마다_한번(monkeypatch):
    _fixed_base(monkeypatch, [f"c{i}" for i in range(22)])
    _wire_solar(
        monkeypatch, lambda msgs, n: f'{{"endline": {_count_numbered(msgs)}}}'
    )

    beats = {"n": 0}

    async def hb():
        beats["n"] += 1

    # 22청크 → idx += 2마다 1콜 = 11콜 → 10콜째에 하트비트 1회
    await sc.chunk_text_semantic("무시됨", 100, 20, heartbeat=hb)

    assert beats["n"] == 1


async def test_청크_1개면_solar_미호출(monkeypatch):
    _fixed_base(monkeypatch, ["단일 청크"])
    calls = _wire_solar(monkeypatch, lambda msgs, n: '{"endline": 1}')

    out = await sc.chunk_text_semantic("무시됨", 100, 20)

    assert out == ["단일 청크"]
    assert calls["count"] == 0


async def test_endline_1_반복이어도_모든_청크_size2_이하_원문보존(monkeypatch):
    # 리뷰어 지적(task6-fix3): 모델이 매 콜 endline=1(유효하나 극단)만 반환하면
    # 파싱 실패가 아니라 회로차단이 안 걸리고 remainder가 반복마다 누적 →
    # max_calls 소진 후 tail로 하나의 초대형 청크가 이월된다. 크기 가드가
    # 이를 정규식으로 잘라 어떤 청크도 size*2를 넘지 않게 하는지 검증한다.
    # 실 chunk_text 사용(가드 강등 경로가 실제로 동작해야 함).
    text = " ".join(f"문장{i}번의내용." for i in range(300))
    _wire_solar(monkeypatch, lambda msgs, n: '{"endline": 1}')

    size = 30
    out = await sc.chunk_text_semantic(text, size, 5)

    assert out  # 비어 있지 않다
    # 어떤 청크도 창 상한(size*2)을 넘지 않는다
    assert all(len(c) <= size * 2 for c in out), [len(c) for c in out]
    # 원문 보존(공백 정규화 후 유실·중복 없음)
    assert _norm("".join(out)) == _norm(text)


async def test_전_청크_이어붙이면_원문_보존(monkeypatch):
    # 실 chunk_text 사용 — 공백 정규화 후 원문과 동일(유실·중복 없음)
    text = (
        "첫째 문단의 내용이 여기 있다.\n\n"
        "둘째 문단은 다른 주제를 다룬다.\n\n"
        "셋째 문단은 결론을 맺는다.\n\n"
        "넷째 문단은 부록이다."
    )
    # 작은 size로 여러 청크가 나오게 한다
    _wire_solar(monkeypatch, lambda msgs, n: '{"endline": 1}')

    out = await sc.chunk_text_semantic(text, 20, 5)

    assert _norm("".join(out)) == _norm(text)
