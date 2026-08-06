"""데이터 백업 · 복원 · 초기화 (D114).

운영 콘솔이 서비스 데이터를 통째로 다룰 수 있게 한다. 세 가지가 한 묶음이다 —
**백업 없이 초기화만 있는 건 기능이 아니라 사고다.**

## 무엇을 담는가

스냅샷은 JSON 한 파일이고, 스코프별로 테이블을 담는다:

  conversations  sessions · nodes · ai_logs
  documents      files · file_chunks (**메타데이터만** — 원본 바이트는 없다)
  people         profiles · classes · class_members
  settings       app_settings

`documents`는 **복원할 수 없다.** 원본 파일 바이트와 Qdrant 벡터가 스냅샷에
없기 때문에, 행만 되살리면 본문도 검색도 없는 껍데기가 생긴다. 그래서 백업에는
기록으로 남기되(무엇이 있었는지 감사용) 복원 대상에서는 제외하고, 화면에도
그렇게 쓴다. 되살릴 수 없는 걸 되살릴 수 있는 척하지 않는다.

## 어디에 두는가

`storage_root/backups/`. 웹으로 직접 서빙되지 않는 경로이고, 다운로드는 admin
전용 엔드포인트를 거친다. **스냅샷에는 학생 대화 원문이 들어 있다** — 파일을
그대로 외부에 옮기면 그 내용이 함께 나간다.

## 권한

읽기는 admin RLS 정책, 쓰기(삭제·복원)는 `admin_*` SECURITY DEFINER RPC가
`is_admin()`을 확인한다. 워커(BYPASSRLS) 커넥션으로 우회하지 않는다 —
"권한은 DB가 강제한다"(D104)를 콘솔이라고 예외로 두지 않는다.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from ..db.client import UserClient

logger = logging.getLogger("nodi.admin_backup")
settings = get_settings()

# 스코프 → (테이블, select 컬럼, 정렬). select를 명시하는 이유는 컬럼이 늘어도
# 스냅샷 형식이 조용히 바뀌지 않게 하기 위해서다.
_SCOPE_TABLES: dict[str, list[tuple[str, str, str]]] = {
    "conversations": [
        (
            "sessions",
            "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
            "current_head_id,created_at,updated_at",
            "created_at.asc",
        ),
        (
            "nodes",
            "id,session_id,parent_id,question,answer,label,attachments,"
            "rag_sources,created_at",
            "created_at.asc",
        ),
        (
            "ai_logs",
            "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
            "contexts,skill_calls,errors,token_estimate,tokens,route,model,"
            "duration_ms,created_at",
            "created_at.asc",
        ),
        # D152: **캔버스가 곧 대화 내용이다**(D122). 이게 빠져 있으면 백업을
        # 뜨고 초기화한 뒤 복원해도 세션 껍데기만 돌아온다 — 학생이 읽고
        # 고치고 옮긴 글은 전부 canvas_items에 있다. 백업 파일에도 복원
        # 결과에도 오류가 없어서, 캔버스를 열어 보기 전까지 아무도 모른다.
        (
            "canvas_items",
            "id,session_id,node_id,parent_item_id,kind,source,title,body,tag,"
            "x,y,pinned,seq,data,created_at,updated_at",
            "created_at.asc",
        ),
        (
            "canvas_drawings",
            "session_id,elements,files,updated_at",
            "updated_at.asc",
        ),
        # D193: 개념 연결 배지 (D171). `canvas_items`에 CASCADE라 초기화 때 같이
        # 지워지는데 백업에는 없었다 — 백업→초기화→복원 하면 **링크만 사라진다.**
        # D152가 canvas_items에서 고친 것과 정확히 같은 형태의 구멍이다.
        (
            "item_links",
            "id,owner_id,from_item_id,to_item_id,explanation,distance,"
            "opened_at,created_at",
            "created_at.asc",
        ),
        # 판정 이력 (D172). 없어도 서비스는 돌지만 "왜 이 배지가 떴나"를 되짚을
        # 수 없게 된다. 초기화 후 주인 없는 행이 남는 것도 이걸로 막는다.
        (
            "crosslink_runs",
            "id,owner_id,from_item_id,from_session_id,from_title,from_tag,"
            "from_space_kind,knobs,candidates,outcome,link_id,explanation,"
            "searched_sessions,duration_ms,created_at",
            "created_at.asc",
        ),
    ],
    "documents": [
        (
            "files",
            "id,owner_id,space_kind,space_ref,kind,storage_path,mime,size_bytes,"
            "status,chunk_total,chunk_done,error,name,session_id,context_chars,"
            "created_at,updated_at",
            "created_at.asc",
        ),
        ("file_chunks", "id,file_id,seq,chunk_text,status,created_at", "created_at.asc"),
        # D193: 교과서 도판 행 (D86). 다시 만들려면 **비전 모델을 전 도판에 다시
        # 돌려야 한다** — 캡션 생성이 이 파이프라인에서 제일 비싸다.
        (
            "textbook_figures",
            "id,file_id,seq,page,element_id,bbox,caption,alt,description,"
            "figure_type,heading,candidates,selected_index,judge_reason,"
            "match_kind,embed_text,image_path,status,created_at,page_text",
            "created_at.asc",
        ),
        # 원자 질문 (D129). 청크마다 solar를 다시 돌려야 한다.
        (
            "chunk_atoms",
            "id,chunk_id,file_id,chunk_seq,question,status,created_at",
            "created_at.asc",
        ),
    ],
    "people": [
        (
            "profiles",
            "id,email,role,display_name,avatar_url,onboarded,created_at,updated_at",
            "created_at.asc",
        ),
        ("classes", "id,name,join_code,teacher_id,created_at", "created_at.asc"),
        ("class_members", "class_id,user_id,role_in_class,created_at", "created_at.asc"),
    ],
    # D193: 강의 클립 (D149) + 클립 썸네일 (D190).
    #
    # **시연 시나리오의 핵심이다.** 인제스트를 다시 돌리면 Whisper 전사와 solar
    # 원자 생성이 다시 나간다(느리고 비싸다) — 시연 직전에 그걸 기다릴 수는 없다.
    "lectures": [
        (
            "lecture_packages",
            "id,grade,subject,title,created_by,created_at",
            "created_at.asc",
        ),
        (
            "lecture_videos",
            "id,package_id,source,page_url,subtitle_path,title,status,error,created_at",
            "created_at.asc",
        ),
        (
            "lecture_clips",
            "id,video_id,seq,start_sec,end_sec,title,transcript,status,created_at",
            "created_at.asc",
        ),
        (
            "lecture_clip_atoms",
            "id,clip_id,package_id,question,status,created_at",
            "created_at.asc",
        ),
        ("class_lecture_packages", "class_id,package_id,created_at", "created_at.asc"),
        (
            "clip_thumbnails",
            "id,storage_path,mime,size_bytes,name,created_by,created_at",
            "created_at.asc",
        ),
    ],
    "settings": [
        ("app_settings", "key,value,updated_at,updated_by", "key.asc"),
    ],
}

# ---------------------------------------------------------------------------
# 담지 않는 표와 그 이유 (D193)
#
#   jobs   큐다. 복원하면 **이미 끝난 일을 다시 돌린다** — 임베딩·전사가 다시
#          나가고, 실패한 잡은 다시 실패한다. 상태가 아니라 진행 중인 작업이다.
#   users  비밀번호 해시가 든다. **백업 파일에 자격 증명을 적지 않는다** —
#          파일은 내려받아 옮겨 다니는 물건이고, DB보다 훨씬 쉽게 샌다.
#          계정의 안전한 사본은 `profiles`이고, 시연 계정은 CLI로 만든다.
#
# 이 목록을 여기 적어 두는 이유: 다음 사람이 "왜 이건 빠졌지"를 코드에서
# 못 찾으면 **빠뜨린 것으로 오해하고 넣는다.**
UNBACKED_TABLES = ("jobs", "users")

ALL_SCOPES = tuple(_SCOPE_TABLES)
# 복원 가능한 스코프. documents가 빠진 이유는 모듈 docstring 참고.
#
# D193: `lectures`를 더했다 — 시연 시나리오를 미리 만들어 두고 불러오는 것이
# 이 기능의 목적인데, 강의 없이 대화만 복원하면 클립 카드가 전부 빈다.
RESTORABLE_SCOPES = ("conversations", "settings", "lectures")
# 초기화 가능한 스코프. people은 없다 — 계정을 지우면 그 사람의 모든 것이
# CASCADE로 사라지고 되돌릴 방법이 없다. 계정은 권한 탭에서 하나씩 다룬다.
PURGEABLE_SCOPES = ("conversations", "documents")

_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.json$")
_PAGE = 1000  # 한 번에 읽어 오는 행 수

# 가져오는 백업 파일 상한. 대화가 쌓이면 수십 MB가 되므로 넉넉히 두되,
# 무제한으로 받으면 디스크가 먼저 찬다.
MAX_IMPORT_BYTES = 200 * 1024 * 1024


def _dir() -> Path:
    d = Path(settings.storage_root).resolve() / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(name: str) -> Path:
    """이름 → 실제 경로. **디렉터리 밖으로 나가면 거부한다.**

    이름이 URL로 들어오므로 `../`나 절대 경로가 섞일 수 있다. 화이트리스트
    정규식으로 1차로 막고, 정규화 후 경계를 다시 확인한다(둘 중 하나만으로는
    심볼릭 링크 같은 경우가 남는다).
    """
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 백업 이름입니다."
        )
    root = _dir()
    target = (root / name).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="유효하지 않은 백업 이름입니다."
        )
    return target


async def _dump_table(
    client: UserClient, table: str, select: str, order: str
) -> list[dict[str, Any]]:
    """테이블 전체를 페이지로 나눠 읽는다.

    한 번에 다 읽지 않는 이유: 대화가 쌓이면 nodes·ai_logs가 수만 행이 되고,
    그때 메모리와 응답 시간이 한 번에 튄다. 관리자 화면이라도 서버를 멈추면 안 된다.
    """
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = await client.select(
            table,
            {"select": select, "order": order, "limit": str(_PAGE), "offset": str(offset)},
        )
        rows.extend(page)
        if len(page) < _PAGE:
            return rows
        offset += _PAGE


async def create_backup(
    client: UserClient,
    *,
    scopes: list[str],
    note: str = "",
    actor: str = "",
) -> dict[str, Any]:
    """스냅샷을 만들어 파일로 저장하고 메타데이터를 돌려준다."""
    picked = [s for s in scopes if s in _SCOPE_TABLES] or list(ALL_SCOPES)
    data: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    for scope in picked:
        for table, select, order in _SCOPE_TABLES[scope]:
            rows = await _dump_table(client, table, select, order)
            data[table] = rows
            counts[table] = len(rows)

    now = datetime.now(UTC)
    name = f"nodi-{now.strftime('%Y%m%d-%H%M%S')}.json"
    meta = {
        "version": 1,
        "name": name,
        "created_at": now.isoformat(),
        "created_by": actor,
        "note": note[:500],
        "scopes": picked,
        "counts": counts,
    }
    path = _path(name)
    # 임시 파일에 쓴 뒤 옮긴다 — 쓰다 죽으면 반쪽짜리 스냅샷이 목록에 남는데,
    # 그게 있으면 "백업이 있다"고 믿고 초기화하게 된다.
    tmp = path.with_suffix(".json.part")
    tmp.write_text(
        json.dumps({**meta, "data": data}, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    tmp.replace(path)
    meta["size_bytes"] = path.stat().st_size
    logger.info("백업 생성: %s (%s)", name, counts)
    return meta


def list_backups() -> list[dict[str, Any]]:
    """저장된 스냅샷 목록(최신 순). 깨진 파일은 건너뛰되 로그로 남긴다."""
    out: list[dict[str, Any]] = []
    for path in sorted(_dir().glob("*.json"), reverse=True):
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("읽을 수 없는 백업 파일 무시: %s", path.name)
            continue
        out.append(
            {
                "name": path.name,
                "created_at": body.get("created_at"),
                "created_by": body.get("created_by", ""),
                "note": body.get("note", ""),
                "scopes": body.get("scopes", []),
                "counts": body.get("counts", {}),
                "size_bytes": path.stat().st_size,
            }
        )
    return out


def prune_backups(keep: int) -> list[str]:
    """최신 `keep`개만 남기고 지운다 — 지운 이름 목록 반환 (D119).

    자동 백업을 걸면 스냅샷이 무한히 쌓인다. 대화 원문이 든 파일이라 오래된
    것을 그냥 두는 것도 좋지 않고(유출 시 범위가 넓어진다), 33T NFS라도 언젠가
    찬다. 목록은 이름순 역정렬이고 이름이 타임스탬프라 사전순=시간순이다.

    `keep < 1`은 거부한다 — 전부 지우는 실수를 이 함수로 할 수 있으면 안 된다.
    """
    if keep < 1:
        raise ValueError("keep은 1 이상이어야 합니다.")
    names = [b["name"] for b in list_backups()]
    removed = []
    for name in names[keep:]:
        try:
            _path(name).unlink()
            removed.append(name)
        except OSError:
            logger.warning("백업 삭제 실패: %s", name, exc_info=True)
    if removed:
        logger.info("오래된 백업 %d개 정리: %s", len(removed), ", ".join(removed))
    return removed


def read_backup(name: str) -> dict[str, Any]:
    path = _path(name)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="백업을 찾을 수 없습니다."
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="백업 파일이 손상되었습니다.",
        ) from exc


def backup_path(name: str) -> Path:
    path = _path(name)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="백업을 찾을 수 없습니다."
        )
    return path


def delete_backup(name: str) -> None:
    path = _path(name)
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="백업을 찾을 수 없습니다."
        )
    path.unlink()
    logger.info("백업 삭제: %s", name)


async def purge(
    client: UserClient,
    service: Any,
    *,
    scopes: list[str],
    owner_id: str | None = None,
) -> dict[str, Any]:
    """스코프별 데이터 삭제. 되돌릴 수 없다.

    `conversations`는 RPC 한 번으로 끝난다(순수 SQL).

    `documents`는 파일마다 `files.delete_file`을 부른다 — 느리지만 그래야
    **Storage 원본·도판 크롭·Qdrant 벡터**가 함께 정리된다. 행만 SQL로 지우면
    검색 인덱스에 유령이 남아, 지운 자료가 계속 근거로 붙는다.
    """
    picked = [s for s in scopes if s in PURGEABLE_SCOPES]
    if not picked:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"삭제 가능한 스코프가 없습니다(가능: {', '.join(PURGEABLE_SCOPES)}).",
        )

    deleted: dict[str, Any] = {}
    if "conversations" in picked:
        out = await client.rpc(
            "admin_purge_conversations", {"p_owner": owner_id}
        )
        deleted["conversations"] = out

    if "documents" in picked:
        from . import files as file_svc

        params: dict[str, str] = {"select": "id,owner_id", "order": "created_at.asc"}
        if owner_id:
            params["owner_id"] = f"eq.{owner_id}"
        rows = await client.select("files", params)
        ok = 0
        failed: list[str] = []
        for row in rows:
            try:
                await file_svc.delete_file(
                    service, client, str(row["owner_id"]), str(row["id"]),
                    as_admin=True,
                )
                ok += 1
            except Exception:  # noqa: BLE001 - 한 파일 실패가 나머지를 막지 않는다
                logger.warning("문서 삭제 실패 file=%s", row.get("id"), exc_info=True)
                failed.append(str(row.get("id")))
        # 실패를 숨기지 않는다 — "다 지웠다"고 보고하면 남은 파일을 못 찾는다.
        deleted["documents"] = {"files": ok, "failed": failed}

    logger.warning("데이터 초기화 실행: scopes=%s deleted=%s", picked, deleted)
    return {"scopes": picked, "deleted": deleted}


async def restore_backup(
    client: UserClient, name: str, scopes: list[str]
) -> dict[str, Any]:
    """스냅샷에서 복원. **이미 있는 행은 건너뛴다**(설정 제외).

    덮어쓰지 않는 이유: 복원이 현재 데이터를 조용히 갈아엎으면 "복원했더니 최근
    것이 사라졌다"가 된다. 설정만 예외인데, 설정은 유효한 값이 하나뿐이라
    건너뛰면 복원이 아무 일도 하지 않는 것과 같다.
    """
    body = read_backup(name)
    data = body.get("data") or {}
    picked = [s for s in scopes if s in RESTORABLE_SCOPES]
    if not picked:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"복원 가능한 스코프가 없습니다(가능: {', '.join(RESTORABLE_SCOPES)}).",
        )

    result: dict[str, Any] = {"name": name, "scopes": picked, "restored": {}}
    if "conversations" in picked:
        # 넘길 표 목록을 **백업 스코프에서 파생**한다 (D152). 여기에 이름을
        # 손으로 적어 두면 백업에 표를 더해도 복원은 조용히 옛 목록만 넘긴다 —
        # 실제로 그 상태였다: canvas_items를 백업에 넣었는데 복원은 계속
        # 0개를 돌려줬고, 백업 파일에도 복원 결과에도 오류가 없었다.
        payload = {t: data.get(t, []) for t, _, _ in _SCOPE_TABLES["conversations"]}
        out = await client.rpc("admin_restore_conversations", {"p_data": payload})
        result["restored"]["conversations"] = out
    if "lectures" in picked:
        # 대화와 같은 규약: 표 목록을 **백업 스코프에서 파생**한다. 손으로 적으면
        # 표를 더했을 때 복원만 옛 목록을 넘겨 조용히 빠진다(D152의 교훈).
        payload = {t: data.get(t, []) for t, _, _ in _SCOPE_TABLES["lectures"]}
        out = await client.rpc("admin_restore_lectures", {"p_data": payload})
        result["restored"]["lectures"] = out
    if "settings" in picked:
        out = await client.rpc(
            "admin_restore_settings", {"p_data": {"app_settings": data.get("app_settings", [])}}
        )
        result["restored"]["settings"] = out
    logger.info("복원: %s %s", name, result["restored"])
    return result


# --- 백업 가져오기 (D193) -----------------------------------------------------


async def import_backup(filename: str, data: bytes) -> dict[str, Any]:
    """다른 곳에서 만든 백업 파일을 이 서버의 백업 목록에 넣는다.

    ## 왜 필요한가

    시연에 쓸 상황을 미리 만들어 두고 그때 불러오려면, **백업 파일이 서버를
    건너올 수 있어야** 한다(사용자 지시 2026-08-06). 지금까지는 이 서버에서
    만든 것만 복원할 수 있었다 — 내려받기는 되는데 올리기가 없었다.

    ## 검사부터 한다

    복원은 관리자 권한으로 도는 SECURITY DEFINER RPC다. 아무 JSON이나 받아
    두면 복원 단계에서 알 수 없는 이유로 죽거나, 더 나쁘게는 **일부만 들어간
    상태**가 된다. 그래서 여기서 모양을 본다:

      · JSON이고 `data`가 객체인가
      · `scopes`가 우리가 아는 스코프인가 (모르는 스코프는 복원이 조용히 무시한다)

    행 내용까지는 안 본다 — 그건 RPC의 FK가 판정한다(부모 없는 행은 안 들어간다).

    ## 이름은 우리가 짓는다

    올린 파일 이름을 그대로 쓰면 `../`이나 기존 백업 덮어쓰기가 열린다.
    `_path()`가 막지만, 애초에 **받은 이름을 경로로 쓰지 않는 편**이 안전하다 —
    원래 이름은 note에 남겨 관리자가 알아볼 수 있게 한다.
    """
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"백업 파일이 너무 큽니다({len(data) / 1024 / 1024:.0f}MB). "
                f"{MAX_IMPORT_BYTES // 1024 // 1024}MB까지 올릴 수 있습니다."
            ),
        )
    try:
        body = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="백업 파일이 아닙니다(JSON을 읽지 못했습니다).",
        ) from exc
    if not isinstance(body, dict) or not isinstance(body.get("data"), dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="백업 파일의 모양이 아닙니다(data 항목이 없습니다).",
        )
    scopes = [s for s in (body.get("scopes") or []) if s in _SCOPE_TABLES]
    if not scopes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "이 서버가 아는 스코프가 없습니다"
                f"(가능: {', '.join(ALL_SCOPES)}). 더 오래된 버전의 백업일 수 있습니다."
            ),
        )
    body["scopes"] = scopes
    origin = (filename or "backup.json").strip()[:80]
    body["note"] = f"가져옴: {origin}" + (
        f" — {body['note']}" if body.get("note") else ""
    )

    name = f"import-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.json"
    path = _path(name)
    path.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    counts = {t: len(v) for t, v in body["data"].items() if isinstance(v, list)}
    logger.info("백업 가져오기: %s (%s) rows=%s", name, origin, counts)
    return {
        "name": name,
        "scopes": scopes,
        "note": body["note"],
        "rows": counts,
        "size_bytes": len(data),
    }
