"""데이터 접근 클라이언트 — asyncpg 직결 (D104-3).

구 PostgREST HTTP 구현을 대체한다. **메서드 시그니처는 그대로다** —
`select/insert/update/upsert/delete/rpc/count`. 서비스 코드 수백 곳이 이
인터페이스에 의존하므로 구현만 바꾼다.

  UserClient    RLS 적용(nodi_app) + 요청 사용자 컨텍스트
  ServiceClient BYPASSRLS(nodi_worker) — 워커·인증 경로

오류 정책은 기존과 같다: RLS로 막히면 403, 그 외 DB 오류는 502. 테이블명·SQL을
클라이언트에 노출하지 않는다(서버 로그에만).
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import HTTPException, status

from ..config import get_settings
from . import query as Q
from . import storage
from .pool import user_conn, worker_conn

logger = logging.getLogger("nodi.db.client")
settings = get_settings()

# asyncpg는 jsonb를 str로 돌려준다. 서비스 코드는 dict/list를 기대하므로
# 코덱을 걸어 자동 변환한다(커넥션마다 1회).
_JSON_CODEC_TYPES = ("json", "jsonb")

# PostgREST 임베디드(`classes(id,name)`)의 참조 컬럼. 이름 규칙 추측 금지 —
# 실제로 쓰는 관계만 등록하고, 새 임베디드가 생기면 여기에 추가해야 동작한다.
EMBED_FK = {
    "classes": "class_id",  # class_members.class_id -> classes.id
}


async def _prepare(conn: asyncpg.Connection) -> None:
    for t in _JSON_CODEC_TYPES:
        await conn.set_type_codec(
            t, encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
        )


def _jsonable(value: Any) -> Any:
    """asyncpg 반환값 → JSON 호환 원시값 (D104 회귀 방지).

    **왜 필요한가**: PostgREST는 JSON을 돌려줬으므로 uuid·timestamptz가 전부
    **문자열**이었고, 코드베이스 전체가 그 전제로 쓰였다. asyncpg는 `uuid.UUID`·
    `datetime` 객체를 돌려주는데, 파이썬에서 `UUID(...) == "..."`는 **항상 거짓**이다.

    실제로 이 차이가 채팅을 통째로 막았다 — chat.py의
    `session["owner_id"] != user.id`가 UUID vs str 비교라 항상 참이 되어 모든
    질문이 403("세션 소유자만 채팅할 수 있습니다")으로 거부됐다.

    비교·f-string 보간·응답 직렬화가 코드 곳곳에 흩어져 있으므로, 호출부 수십
    곳을 고치는 대신 **경계 한 곳에서** 옛 계약(문자열)으로 되돌린다.
    """
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return value


def _rows(records: list[asyncpg.Record]) -> list[dict[str, Any]]:
    return [{k: _jsonable(v) for k, v in r.items()} for r in records]


def _fail(exc: Exception, op: str) -> None:
    """DB 예외 → HTTP 오류. 세부는 서버 로그에만."""
    logger.error("DB %s 실패: %s", op, exc)
    if isinstance(exc, asyncpg.InsufficientPrivilegeError):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized for this operation.",
        ) from exc
    if isinstance(exc, Q.UnsupportedQuery):
        # 변환기가 모르는 문법 — 코드 버그다. 조용히 넘기지 않는다.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unsupported query.",
        ) from exc
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY, detail="Database request failed."
    ) from exc


def _to_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# Postgres가 알려주는 파라미터 타입 → 파이썬 변환기.
# **문자열로 들어온 값만** 이 표를 탄다(이미 올바른 타입이면 건드리지 않는다).
_COERCE: dict[str, Any] = {
    "int2": int, "int4": int, "int8": int,
    "float4": float, "float8": float,
    "numeric": lambda v: Decimal(str(v)),
    "bool": lambda v: str(v).strip().lower() in ("t", "true", "1", "yes"),
    # D112: 시각 컬럼도 여기서 처리한다. 예전에는 `_encode`가 "ISO처럼 생긴
    # 문자열"을 무조건 datetime으로 바꿨는데, 그러면 **text 컬럼에 저장하려던
    # 값까지 바뀌어** DataError가 났다(파일명이 "2026-07-28T10:00:00"이면 업로드
    # 실패). 컬럼 타입을 아는 이 자리에서만 바꾸는 것이 옳다.
    "timestamptz": _to_datetime,
    "timestamp": _to_datetime,
    "date": lambda v: _to_datetime(v).date(),
}

# SQL 문자열 → 서버가 선언한 파라미터 타입 이름. 같은 질의가 반복되므로 한 번만
# 물어보면 된다. 실측(2026-07-28): 매번 `conn.prepare()`를 부르면 일반 `fetch()`
# 대비 **3.09배** 느렸다(50회 131ms vs 42ms). 커넥션마다 다시 물어볼 필요는
# 없다 — 타입은 스키마가 정하지 커넥션이 정하지 않는다.
_PARAM_TYPES: dict[str, tuple[str, ...]] = {}
_PARAM_TYPES_MAX = 512  # 무한 증가 방지(질의 형태는 유한하다)


async def _param_types(conn: asyncpg.Connection, sql: str) -> tuple[str, ...]:
    cached = _PARAM_TYPES.get(sql)
    if cached is not None:
        return cached
    stmt = await conn.prepare(sql)
    types = tuple(getattr(p, "name", "") for p in stmt.get_parameters())
    if len(_PARAM_TYPES) < _PARAM_TYPES_MAX:
        _PARAM_TYPES[sql] = types
    return types


async def _fetch(
    conn: asyncpg.Connection, sql: str, args: list[Any]
) -> list[asyncpg.Record]:
    """파라미터를 **서버가 기대하는 타입으로 맞춰** 실행한다 (D110).

    PostgREST는 값을 전부 문자열로 받아 컬럼 타입에 맞게 캐스팅해 줬다. asyncpg는
    캐스팅하지 않고 `DataError`를 던진다 — `seq >= $1`에 `'0'`(문자열)을 주면
    "'str' object cannot be interpreted as an integer". 질의 파라미터는 PostgREST
    문법 번역기(db/query.py)가 만들기 때문에 값이 항상 문자열이고, 그래서
    **정수·시각 컬럼을 다루는 모든 질의가 502였다.**

    타입을 추측하지 않는다 — 서버가 선언한 파라미터 타입을 읽어 그대로 변환한다.
    컬럼이 text면 문자열이 그대로 가고, int면 int로, timestamptz면 datetime으로
    바뀐다. 타입 조회는 SQL별로 한 번만 하고 캐시한다.
    """
    if not args:
        return await conn.fetch(sql)
    types = await _param_types(conn, sql)
    if len(types) == len(args):
        coerced: list[Any] = []
        for value, tname in zip(args, types, strict=True):
            fn = _COERCE.get(tname)
            if fn is not None and isinstance(value, str):
                try:
                    value = fn(value)
                except (ValueError, ArithmeticError):
                    pass  # 변환 실패는 그대로 넘겨 서버가 판정하게 둔다
            coerced.append(value)
        args = coerced
    return await conn.fetch(sql, *args)


class _BaseClient:
    """공통 SQL 조립·실행. 커넥션 획득 방식만 하위 클래스가 정한다."""

    def _conn(self):  # pragma: no cover - 하위 클래스가 구현
        raise NotImplementedError

    # --- 읽기 ---------------------------------------------------------------
    async def select(
        self, table: str, params: dict[str, Any]
    ) -> list[dict[str, Any]]:
        try:
            sql, args, embeds = Q.build_select(table, params)
            async with self._conn() as conn:
                await _prepare(conn)
                rows = _rows(await _fetch(conn, sql, args))
                if embeds:
                    await self._fill_embeds(conn, rows, embeds)
                return rows
        except Exception as exc:
            _fail(exc, f"select {table}")

    async def _fill_embeds(
        self,
        conn: asyncpg.Connection,
        rows: list[dict[str, Any]],
        embeds: list[tuple[str, list[str]]],
    ) -> None:
        """PostgREST 임베디드 리소스를 별도 질의로 채운다.

        참조 컬럼을 이름 규칙으로 **추측하지 않는다** — 복수형/단수형 규칙은
        영어에서도 어긋나고(classes→classe_id 같은 오류), 틀리면 조용히 null이
        채워져 화면에서만 티가 난다. 실제로 쓰는 관계만 명시하고, 목록에 없는
        임베디드는 예외로 드러낸다.
        """
        for tname, cols in embeds:
            fk = EMBED_FK.get(tname)
            if fk is None:
                raise Q.UnsupportedQuery(
                    f"임베디드 {tname}: 참조 관계가 EMBED_FK에 없다"
                )
            if rows and fk not in rows[0]:
                raise Q.UnsupportedQuery(
                    f"임베디드 {tname}: 참조 컬럼 {fk}가 결과에 없다"
                    " (select에 포함시켜야 한다)"
                )
            ids = [r[fk] for r in rows if r.get(fk) is not None]
            if not ids:
                for r in rows:
                    r[tname] = None
                continue
            # `id`가 cols에 이미 있으면 두 번 뽑지 않는다(`SELECT id, id, …`).
            extra = [Q._ident(c) for c in cols if c != "id"]
            col_sql = ("id, " + ", ".join(extra)) if extra else "id"
            sub = await conn.fetch(
                f"SELECT {col_sql} FROM {Q._ident(tname)}"
                f" WHERE id = ANY($1::uuid[])",
                ids,
            )
            # **바깥 행과 같은 표현으로 맞춘다** (D169). 바깥 rows는 이미
            # `_rows()`를 거쳐 uuid가 **문자열**인데, 여기서 raw Record를 그대로
            # 쓰면 키가 `UUID` 객체가 되어 `by_id.get("...")`이 **언제나 빗나간다**.
            # 실패가 예외가 아니라 **조용한 null**이라 화면에서만 티가 났다 —
            # 학급 이름이 전부 사라져 사이드바가 "학급"만 여러 개 띄웠다.
            # `_jsonable`의 docstring이 경고한 바로 그 UUID vs str 사고다.
            by_id = {r["id"]: {c: r[c] for c in cols} for r in _rows(sub)}
            for r in rows:
                r[tname] = by_id.get(r.get(fk))

    async def count(self, table: str, params: dict[str, Any]) -> int:
        try:
            where, args, _ = Q.build_where(params)
            sql = f"SELECT count(*) FROM {Q._ident(table)}{where}"
            async with self._conn() as conn:
                return int(await conn.fetchval(sql, *args) or 0)
        except Exception as exc:
            _fail(exc, f"count {table}")

    # --- 쓰기 ---------------------------------------------------------------
    async def insert(
        self, table: str, rows: dict | list[dict], *, returning: bool = True
    ) -> Any:
        single = isinstance(rows, dict)
        rlist = [rows] if single else list(rows)
        if not rlist:
            return [] if not single else None
        try:
            cols = list(rlist[0].keys())
            col_sql = ", ".join(Q._ident(c) for c in cols)
            values_sql = []
            args: list[Any] = []
            i = 1
            for row in rlist:
                ph = []
                for c in cols:
                    ph.append(f"${i}")
                    args.append(_encode(row.get(c)))
                    i += 1
                values_sql.append("(" + ", ".join(ph) + ")")
            sql = (
                f"INSERT INTO {Q._ident(table)} ({col_sql}) "
                f"VALUES {', '.join(values_sql)}"
            )
            if returning:
                sql += " RETURNING *"
            async with self._conn() as conn:
                await _prepare(conn)
                if not returning:
                    await conn.execute(sql, *args)
                    return []
                out = _rows(await _fetch(conn, sql, args))
                if not out:
                    logger.error("insert %s가 행을 반환하지 않았다(RLS?)", table)
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Database request failed.",
                    )
                return out[0] if single else out
        except HTTPException:
            raise
        except Exception as exc:
            _fail(exc, f"insert {table}")

    async def update(
        self, table: str, filters: dict[str, Any], patch: dict[str, Any]
    ) -> list[dict[str, Any]]:
        try:
            sets = []
            args: list[Any] = []
            i = 1
            for col, val in patch.items():
                sets.append(f"{Q._ident(col)} = ${i}")
                args.append(_encode(val))
                i += 1
            where, wargs, _ = Q.build_where(filters, start_index=i)
            sql = (
                f"UPDATE {Q._ident(table)} SET {', '.join(sets)}{where} RETURNING *"
            )
            async with self._conn() as conn:
                await _prepare(conn)
                return _rows(await _fetch(conn, sql, [*args, *wargs]))
        except Exception as exc:
            _fail(exc, f"update {table}")

    async def update_many(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        types: dict[str, str],
        key: str = "id",
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """행마다 **다른 값**으로 갱신 — 왕복 한 번, 트랜잭션 하나 (D183).

        `update()`는 한 filter에 한 patch라 "카드 150장을 각자 다른 좌표로"를
        표현하지 못한다. 그래서 호출부가 `update()`를 150번 부르고, 그것이
        HTTP 요청 150개가 됐다(실측: 로컬에서 842ms — 네트워크 지연이 0인데도).

        ## 왜 jsonb_to_recordset인가

        `VALUES (...), (...)`로 펴면 파라미터가 행×열 개로 늘어나고 asyncpg가
        열마다 타입을 추론해야 한다 — 좌표가 정수로 온 행 하나 때문에 전체
        추론이 흔들린다. jsonb 하나로 넘기고 **컬럼 타입을 SQL에 적어 두면**
        추론이 낄 자리가 없다.

        ## RLS는 그대로다

        UPDATE 정책이 행마다 판정한다(D104). 못 건드리는 행은 조용히 빠지므로
        **호출부가 반환 행 수를 확인해야 한다** — 그 확인이 곧 "저장됐다"의
        근거다. `filters`는 그 위에 얹는 추가 울타리다(예: 한 세션 안으로).

        :param types: 갱신할 컬럼 → SQL 타입. `key`도 반드시 포함해야 한다.
        """
        if not rows:
            return []
        cols = [c for c in types if c != key]
        if not cols:
            raise ValueError("갱신할 컬럼이 없다")
        # `build_where`는 컬럼을 수식 없이 낸다. 그 이름이 v에도 있으면
        # "column reference is ambiguous"로 죽는다 — 조용히 틀리지는 않지만
        # 호출부가 이유를 알기 어려우므로 여기서 막는다.
        clash = set(filters or ()) & set(types)
        if clash:
            raise ValueError(f"필터와 갱신 컬럼이 겹친다: {sorted(clash)}")
        try:
            coldef = ", ".join(f"{Q._ident(c)} {t}" for c, t in types.items())
            sets = ", ".join(f"{Q._ident(c)} = v.{Q._ident(c)}" for c in cols)
            # **직렬화하지 않고 넘긴다.** `_prepare`가 jsonb에 json.dumps 코덱을
            # 걸어 두므로 여기서 문자열로 만들면 한 번 더 감싸여 배열이 아니라
            # 문자열 스칼라가 되고, `jsonb_to_recordset`이 "non-array"로 죽는다
            # (실측 2026-08-06 — mock 테스트로는 절대 안 잡힌다).
            payload = [
                {c: _jsonable(_encode(r.get(c))) for c in types} for r in rows
            ]
            args: list[Any] = [payload]
            where, wargs, _ = Q.build_where(filters or {}, start_index=2)
            # build_where는 `WHERE ...`를 낸다 — 여기서는 이미 조인 조건이
            # 있으므로 AND로 이어 붙인다.
            extra = where.replace(" WHERE ", " AND ", 1) if where else ""
            sql = (
                f"UPDATE {Q._ident(table)} AS t SET {sets} "
                f"FROM jsonb_to_recordset($1::jsonb) AS v({coldef}) "
                f"WHERE t.{Q._ident(key)} = v.{Q._ident(key)}{extra} "
                f"RETURNING t.*"
            )
            async with self._conn() as conn:
                await _prepare(conn)
                return _rows(await _fetch(conn, sql, [*args, *wargs]))
        except Exception as exc:
            _fail(exc, f"update_many {table}")

    async def upsert(
        self, table: str, row: dict[str, Any], on_conflict: str
    ) -> dict[str, Any]:
        try:
            cols = list(row.keys())
            col_sql = ", ".join(Q._ident(c) for c in cols)
            ph = ", ".join(f"${i + 1}" for i in range(len(cols)))
            conflict_cols = ", ".join(
                Q._ident(c.strip()) for c in on_conflict.split(",") if c.strip()
            )
            updates = ", ".join(
                f"{Q._ident(c)} = EXCLUDED.{Q._ident(c)}"
                for c in cols
                if c not in [x.strip() for x in on_conflict.split(",")]
            )
            # 갱신할 비-키 컬럼이 없으면(행 전체가 곧 충돌 키) `DO UPDATE SET`이
            # 빈 문자열이 되어 SQL 문법 오류다. 이 경우 의도는 "행을 보장한다"
            # (멱등 삽입)이므로 `DO NOTHING`을 낸다. 비-키 컬럼이 있는 기존
            # 호출부(app_settings·canvas_drawings 등)는 그대로 DO UPDATE.
            do_update = bool(updates)
            conflict = (
                f"ON CONFLICT ({conflict_cols}) DO UPDATE SET {updates}"
                if do_update
                else f"ON CONFLICT ({conflict_cols}) DO NOTHING"
            )
            sql = (
                f"INSERT INTO {Q._ident(table)} ({col_sql}) VALUES ({ph}) "
                f"{conflict} RETURNING *"
            )
            args = [_encode(row[c]) for c in cols]
            async with self._conn() as conn:
                await _prepare(conn)
                out = _rows(await _fetch(conn, sql, args))
                if not out:
                    if not do_update:
                        # DO NOTHING + 이미 존재하는 행 → RETURNING이 비지만 정상.
                        # 삽입하려던 행이 곧 보장하려는 상태다.
                        return dict(row)
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Database request failed.",
                    )
                return out[0]
        except HTTPException:
            raise
        except Exception as exc:
            _fail(exc, f"upsert {table}")

    async def delete(
        self, table: str, filters: dict[str, Any]
    ) -> list[dict[str, Any]]:
        try:
            where, args, _ = Q.build_where(filters)
            sql = f"DELETE FROM {Q._ident(table)}{where} RETURNING *"
            async with self._conn() as conn:
                await _prepare(conn)
                return _rows(await _fetch(conn, sql, args))
        except Exception as exc:
            _fail(exc, f"delete {table}")

    # --- 함수 호출 ----------------------------------------------------------
    async def rpc(self, fn: str, args: dict[str, Any], *, many: bool = False) -> Any:
        """DB 함수 호출. 이름 있는 인자로 넘겨 순서 의존을 없앤다.

        ## `many`를 왜 호출부가 정하나 (2026-08-07)

        반환 **모양만 보고는** "행 하나짜리 목록"과 "복합 타입 하나"를 가를 수
        없다. 예전에는 행 수로 짐작했는데(`len(out) > 1`이면 목록), 그래서
        행이 **정확히 하나**일 때 목록을 기대하는 호출부가 dict를 받았다.

        그 결과가 이거다: **학급을 하나만 가진 선생님에게 학급 목록이 빈 채로
        보였다.** 라우터가 `isinstance(result, list) else []`로 걸러 버리기
        때문이다. 둘째 학급을 만드는 순간 갑자기 둘 다 나타난다 — 새로 가입한
        선생님은 100% 겪고, 학급 코드조차 볼 수 없어 **학생을 넣을 방법이
        없었다**(실측 2026-08-07, 새 교사 여정).

        짐작은 여기서 끝낸다. 목록을 기대하면 `many=True`라고 적는다.
        """
        try:
            names = list(args.keys())
            call = ", ".join(
                f"{Q._ident(n)} => ${i + 1}" for i, n in enumerate(names)
            )
            sql = f"SELECT * FROM {Q._ident(fn)}({call})"
            values = [_encode(args[n]) for n in names]
            async with self._conn() as conn:
                await _prepare(conn)
                out = _rows(await _fetch(conn, sql, values))
            if many:
                return out
            if not out:
                return None
            # 스칼라 반환(is_admin 등)은 컬럼 1개 행 1개 — 값만 돌려준다.
            if len(out) == 1 and len(out[0]) == 1:
                return next(iter(out[0].values()))
            # TABLE 반환은 목록, 복합 타입 반환은 단일 객체.
            return out if len(out) > 1 else out[0]
        except Exception as exc:
            _fail(exc, f"rpc {fn}")


# ISO 8601 타임스탬프 문자열. 초 단위 이상 + 타임존이 있으면 받아들인다.
def _encode(value: Any) -> Any:
    """쓰기 파라미터 전처리.

    D112: 여기서 하던 "ISO처럼 생긴 문자열 → datetime" 승격을 **없앴다.**
    형태만 보고 바꾸다 보니 text 컬럼에 저장하려던 값까지 바뀌었다 — 파일명이
    "2026-07-28T10:00:00"이면 업로드가 DataError로 죽었다(실측). 시각 변환은
    컬럼 타입을 아는 `_fetch`가 서버 선언 타입을 보고 한다.

    dict/list는 jsonb 코덱이 처리하므로 그대로 넘긴다.
    """
    return value


class UserClient(_BaseClient):
    """요청 사용자 권한으로 접근 — RLS가 모든 읽기·쓰기를 검증한다."""

    def __init__(self, user_id: str | None):
        self._user_id = user_id

    @classmethod
    def from_user(cls, user: Any) -> UserClient:
        return cls(getattr(user, "id", None))

    def _conn(self):
        return user_conn(self._user_id)


class ServiceClient(_BaseClient):
    """워커·인증 경로 — RLS를 우회한다(구 service_role).

    파일 저장 메서드는 시그니처를 그대로 유지한다 — 호출부가
    `svc.storage_upload(bucket, path, data, mime)` 형태로 쓴다.
    """

    def _conn(self):
        return worker_conn()

    # --- 파일 저장 (D104-5) -------------------------------------------------
    async def storage_upload(
        self, bucket: str, path: str, data: bytes, content_type: str
    ) -> None:
        await storage.upload(bucket, path, data, content_type)

    async def storage_download(self, bucket: str, path: str) -> bytes:
        return await storage.download(bucket, path)

    async def storage_delete(self, bucket: str, path: str) -> None:
        await storage.delete(bucket, path)

    async def storage_sign(self, bucket: str, path: str, expires_in: int) -> str:
        return await storage.sign(bucket, path, expires_in)


def get_service_client() -> ServiceClient | None:
    """워커 클라이언트. 워커 DSN이 없으면 None(구 service_role 부재와 동형).

    호출부는 None을 "이 기능 비활성"으로 해석해 503을 낸다 — 그 계약을 유지한다.
    """
    if not settings.database_worker_url:
        return None
    return ServiceClient()
