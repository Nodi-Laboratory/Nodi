"""PostgREST 질의 파라미터 → SQL 변환 (D104-3).

배경: 백엔드 전체가 PostgREST의 필터 문법(`{"id": "eq.…", "order": "…"}`)으로
데이터 계층을 호출한다. Supabase를 걷어내면서 그 호출부 수백 곳을 다시 쓰는
대신, **같은 파라미터를 받아 SQL로 번역**한다. 서비스 코드는 무변경이다.

**지원하지 않는 문법은 즉시 예외를 던진다.** 조용히 무시하면 필터가 빠진 채
질의가 나가 남의 데이터를 반환할 수 있다 — 권한과 직결되므로 소리 나게 실패한다.

지원 범위는 저장소에서 실제로 쓰는 것만(2026-07-27 전수 조사):
  연산자   eq · neq · in · gte · lt
  수식어   select · order · limit · offset · and
  임베디드 `classes(id,name)` 형태 1곳 (class_members → classes)
"""

from __future__ import annotations

import re
from typing import Any

# 파라미터 이름이 아니라 질의 수식어인 키.
MODIFIERS = {"select", "order", "limit", "offset"}

# 지원 연산자 → SQL 조각. 값 바인딩은 호출부가 $n으로 채운다.
_OPS = {
    "eq": "=",
    "neq": "<>",
    "gte": ">=",
    "lt": "<",
    "gt": ">",
    "lte": "<=",
}

# `and=(seq.gte.0,seq.lt.8)` 형태.
_AND_RE = re.compile(r"(\w+)\.(\w+)\.([^,()]*)")

# 임베디드 리소스: `classes(id,name)`
_EMBED_RE = re.compile(r"^(\w+)\(([^)]*)\)$")


class UnsupportedQuery(ValueError):
    """변환기가 모르는 문법 — 조용히 넘어가지 않는다."""


def _ident(name: str) -> str:
    """식별자 화이트리스트. 컬럼·테이블명이 SQL에 직접 들어가므로 엄격히 검사."""
    if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name):
        raise UnsupportedQuery(f"허용되지 않는 식별자: {name!r}")
    return name


def _split_embedded(value: str) -> str:
    """`a,b,classes(id,name)`에서 임베디드 안의 콤마를 보호해 분리 가능한 형태로.

    괄호 깊이를 세어 안쪽 콤마를 임시 토큰으로 바꾼다.
    """
    out: list[str] = []
    depth = 0
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth > 0:
            out.append("\x00")
        else:
            out.append(ch)
    return "".join(out)


def build_where(
    params: dict[str, Any], start_index: int = 1
) -> tuple[str, list[Any], int]:
    """필터 파라미터 → (WHERE 절, 바인딩 값, 다음 인덱스).

    조건이 없으면 빈 문자열을 돌려준다(전체 조회 — RLS가 여전히 스코프한다).
    """
    clauses: list[str] = []
    args: list[Any] = []
    idx = start_index

    for key, raw in params.items():
        if key in MODIFIERS:
            continue
        if key == "on_conflict":
            continue
        if not isinstance(raw, str):
            raise UnsupportedQuery(f"필터 값은 문자열이어야 한다: {key}={raw!r}")

        if key == "and":
            # `(seq.gte.0,seq.lt.8)` — 괄호 안 조건들의 AND.
            inner = raw.strip()
            if not (inner.startswith("(") and inner.endswith(")")):
                raise UnsupportedQuery(f"and 문법이 아니다: {raw!r}")
            found = _AND_RE.findall(inner)
            if not found:
                raise UnsupportedQuery(f"and 안에 조건이 없다: {raw!r}")
            for col, op, val in found:
                if op not in _OPS:
                    raise UnsupportedQuery(f"and 안 미지원 연산자: {op}")
                clauses.append(f"{_ident(col)} {_OPS[op]} ${idx}")
                args.append(val)
                idx += 1
            continue

        col = _ident(key)
        op, _, val = raw.partition(".")

        if op == "before":
            # `before.<초>` — "지금으로부터 N초 전보다 오래된" (D104).
            #
            # PostgREST 시절에는 파이썬이 만든 ISO 문자열을 그냥 넘겼는데,
            # asyncpg는 timestamptz 파라미터에 문자열을 받지 않는다(실측:
            # DataError). 게다가 앱 시계와 DB 시계가 어긋나면 판정도 틀린다 —
            # **시간 계산을 DB에서** 하도록 바꾼다.
            if not val.isdigit():
                raise UnsupportedQuery(f"before는 초 단위 정수여야 한다: {raw!r}")
            clauses.append(f"{col} < now() - make_interval(secs => ${idx})")
            args.append(int(val))
            idx += 1
            continue

        if op == "in":
            # `in.(a,b,c)`
            body = val.strip()
            if not (body.startswith("(") and body.endswith(")")):
                raise UnsupportedQuery(f"in 문법이 아니다: {raw!r}")
            items = [v.strip().strip('"') for v in body[1:-1].split(",") if v.strip()]
            if not items:
                # 빈 IN은 항상 거짓 — 조용히 전체를 반환하면 안 된다.
                clauses.append("false")
                continue
            clauses.append(f"{col} = ANY(${idx})")
            args.append(items)
            idx += 1
            continue

        if op == "ilike":
            # `ilike.<말>` — 대소문자 안 가리고 **부분 일치**. 이름으로 찾기용.
            #
            # 값은 언제나 파라미터로 나간다($n). 다만 `%`·`_`는 LIKE의 와일드카드라
            # 사용자가 치면 그대로 와일드카드가 된다 — 찾기에서는 그게 해로울
            # 것이 없어 굳이 막지 않는다(막으면 제목에 밑줄이 든 대화를 못 찾는다).
            clauses.append(f"{col} ILIKE ${idx}")
            args.append(f"%{val}%")
            idx += 1
            continue

        if op in ("is", "not"):
            # `is.null` / `is.true` / `is.false`, 그리고 그 부정 `not.is.…`.
            #
            # `not`은 **`is`의 부정만** 받는다. 부정을 일반 연산자로 열면
            # (`not.eq.…`, `not.in.…`) 조합이 늘어나는 만큼 변환기를 잘못
            # 읽을 여지도 늘어난다 — 필요한 것 하나만 연다.
            token = val.strip().lower()
            if op == "not":
                if not token.startswith("is."):
                    raise UnsupportedQuery(f"not은 is만 부정한다: {raw!r}")
                token = token[3:]
            negate = op == "not"
            if token == "null":
                clauses.append(f"{col} IS {'NOT ' if negate else ''}NULL")
            elif token in ("true", "false"):
                clauses.append(f"{col} IS {'NOT ' if negate else ''}{token}")
            else:
                raise UnsupportedQuery(f"is 대상이 아니다: {raw!r}")
            continue

        if op not in _OPS:
            raise UnsupportedQuery(f"미지원 연산자: {raw!r} (키 {key})")

        clauses.append(f"{col} {_OPS[op]} ${idx}")
        args.append(val)
        idx += 1

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, args, idx


def build_order(value: str | None) -> str:
    """`updated_at.desc` / `seq.asc` / `x.desc.nullslast` → ORDER BY 절."""
    if not value:
        return ""
    parts: list[str] = []
    for raw in value.split(","):
        seg = raw.strip()
        if not seg:
            continue
        bits = seg.split(".")
        col = _ident(bits[0])
        direction = "ASC"
        nulls = ""
        for b in bits[1:]:
            low = b.lower()
            if low in ("asc", "desc"):
                direction = low.upper()
            elif low == "nullsfirst":
                nulls = " NULLS FIRST"
            elif low == "nullslast":
                nulls = " NULLS LAST"
            else:
                raise UnsupportedQuery(f"order 수식어를 모른다: {b!r}")
        parts.append(f"{col} {direction}{nulls}")
    return (" ORDER BY " + ", ".join(parts)) if parts else ""


def build_limit(params: dict[str, Any]) -> str:
    out = ""
    limit = params.get("limit")
    offset = params.get("offset")
    if limit is not None:
        if not str(limit).isdigit():
            raise UnsupportedQuery(f"limit이 숫자가 아니다: {limit!r}")
        out += f" LIMIT {int(limit)}"
    if offset is not None:
        if not str(offset).isdigit():
            raise UnsupportedQuery(f"offset이 숫자가 아니다: {offset!r}")
        out += f" OFFSET {int(offset)}"
    return out


def build_select(
    table: str, params: dict[str, Any]
) -> tuple[str, list[Any], list[tuple[str, list[str]]]]:
    """select 호출 → (SQL, 바인딩, 임베디드 목록)."""
    raw_select = params.get("select")
    if raw_select and raw_select.strip() != "*":
        cols, embeds = _parse_protected(_split_embedded(raw_select))
    else:
        cols, embeds = "*", []

    where, args, _ = build_where(params)
    sql = (
        f"SELECT {cols} FROM {_ident(table)}"
        + where
        + build_order(params.get("order"))
        + build_limit(params)
    )
    return sql, args, embeds


def _parse_protected(protected: str) -> tuple[str, list[tuple[str, list[str]]]]:
    """임베디드 내부 콤마가 \\x00으로 보호된 문자열을 파싱."""
    cols: list[str] = []
    embeds: list[tuple[str, list[str]]] = []
    for raw in protected.split(","):
        part = raw.replace("\x00", ",").strip()
        if not part:
            continue
        m = _EMBED_RE.match(part)
        if m:
            embeds.append((
                _ident(m.group(1)),
                [_ident(c.strip()) for c in m.group(2).split(",") if c.strip()],
            ))
            continue
        cols.append(_ident(part))
    return (", ".join(cols) if cols else "*"), embeds
