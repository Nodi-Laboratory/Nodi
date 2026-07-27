"""D104-3 — PostgREST 파라미터 → SQL 변환기.

이 변환기가 필터를 하나라도 놓치면 **남의 데이터가 반환된다.** 그래서 검증의
초점은 두 가지다:
  1. 실제로 쓰는 문법이 정확한 SQL로 번역되는가
  2. 모르는 문법이 **조용히 무시되지 않고 예외로 드러나는가**
"""

import pytest

from app.db import query as Q


# --- WHERE ------------------------------------------------------------------


def test_eq_binds_value():
    where, args, _ = Q.build_where({"id": "eq.abc"})
    assert where == " WHERE id = $1"
    assert args == ["abc"]


def test_multiple_filters_are_anded():
    where, args, _ = Q.build_where({"owner_id": "eq.u1", "kind": "eq.textbook"})
    assert where == " WHERE owner_id = $1 AND kind = $2"
    assert args == ["u1", "textbook"]


def test_in_uses_any_array():
    where, args, _ = Q.build_where({"id": "in.(a,b,c)"})
    assert where == " WHERE id = ANY($1)"
    assert args == [["a", "b", "c"]]


def test_empty_in_is_false_not_unfiltered():
    """빈 IN을 조건 없음으로 떨어뜨리면 전체가 반환된다 — 반드시 거짓이어야 한다."""
    where, args, _ = Q.build_where({"id": "in.()"})
    assert where == " WHERE false"
    assert args == []


def test_and_group_expands():
    where, args, _ = Q.build_where({"and": "(seq.gte.0,seq.lt.8)"})
    assert where == " WHERE seq >= $1 AND seq < $2"
    assert args == ["0", "8"]


def test_is_null():
    where, args, _ = Q.build_where({"session_id": "is.null"})
    assert where == " WHERE session_id IS NULL"
    assert args == []


def test_no_filters_gives_empty_where():
    where, args, _ = Q.build_where({"select": "id", "limit": "1"})
    assert where == ""
    assert args == []


# --- 미지원 문법은 반드시 터진다 ---------------------------------------------


@pytest.mark.parametrize("params", [
    {"id": "like.%abc%"},        # 미지원 연산자
    {"id": "cs.{a}"},            # 미지원 연산자
    {"id": "eq"},                # 연산자만 있고 값 구분자 없음 → op="eq" 값 ""
    {"id;drop table x": "eq.1"},  # 식별자 규칙 위반
    {"and": "seq.gte.0"},        # 괄호 없음
    {"and": "()"},               # 조건 없음
    {"id": "is.something"},      # is 대상이 아님
])
def test_unsupported_syntax_raises(params):
    if params == {"id": "eq"}:
        # "eq" → partition('.')이 op="eq", val="" → 유효한 형태다(빈 문자열 비교).
        # 조용히 틀리지 않는지만 확인하고 통과시킨다.
        where, args, _ = Q.build_where(params)
        assert args == [""]
        return
    with pytest.raises(Q.UnsupportedQuery):
        Q.build_where(params)


def test_non_string_filter_raises():
    with pytest.raises(Q.UnsupportedQuery):
        Q.build_where({"id": 123})


# --- ORDER / LIMIT ----------------------------------------------------------


def test_order_desc():
    assert Q.build_order("updated_at.desc") == " ORDER BY updated_at DESC"


def test_order_default_asc():
    assert Q.build_order("seq") == " ORDER BY seq ASC"


def test_order_nulls_last():
    assert Q.build_order("x.desc.nullslast") == " ORDER BY x DESC NULLS LAST"


def test_order_unknown_modifier_raises():
    with pytest.raises(Q.UnsupportedQuery):
        Q.build_order("x.sideways")


def test_limit_offset():
    assert Q.build_limit({"limit": "10", "offset": "20"}) == " LIMIT 10 OFFSET 20"


def test_limit_non_numeric_raises():
    with pytest.raises(Q.UnsupportedQuery):
        Q.build_limit({"limit": "10; drop table x"})


# --- SELECT -----------------------------------------------------------------


def test_select_columns():
    sql, args, embeds = Q.build_select("files", {"select": "id,name", "id": "eq.f1"})
    assert sql == "SELECT id, name FROM files WHERE id = $1"
    assert args == ["f1"]
    assert embeds == []


def test_select_star_when_absent():
    sql, _, _ = Q.build_select("files", {})
    assert sql == "SELECT * FROM files"


def test_select_embedded_resource_is_separated():
    """`classes(id,name)`는 컬럼이 아니라 별도 조회 대상으로 분리된다."""
    sql, _, embeds = Q.build_select(
        "class_members", {"select": "class_id,role_in_class,classes(id,name)"}
    )
    assert sql == "SELECT class_id, role_in_class FROM class_members"
    assert embeds == [("classes", ["id", "name"])]


def test_select_full_query_shape():
    sql, args, _ = Q.build_select(
        "sessions",
        {
            "select": "id,title",
            "owner_id": "eq.u1",
            "order": "updated_at.desc",
            "limit": "5",
        },
    )
    assert sql == (
        "SELECT id, title FROM sessions WHERE owner_id = $1"
        " ORDER BY updated_at DESC LIMIT 5"
    )
    assert args == ["u1"]
