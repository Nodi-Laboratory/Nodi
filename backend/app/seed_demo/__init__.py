"""데모 데이터 시드 — `python -m app.cli seed-demo [--if-empty]` (공개판 2026-09-27).

`git clone → docker compose up` 한 번으로 **모든 주요 화면이 채워진 상태**를
보여 주기 위한 것이다. API 키 없이 돈다: 글·그림·PDF·벡터를 전부 미리 만들어
`assets/`에 커밋해 두었고, 여기서는 그것을 DB·저장소·Qdrant에 옮겨 담기만 한다.

## 무엇이 생기나

  · 계정 9개 — demo(학생·김하늘) · teacher(박지현) · admin · 같은 반 학생 6명
    (비밀번호 전부 `demo1234`)
  · 학급 "2학년 3반 과학"(참여 코드 DEMO23) + 학급 사진
  · 교과서 PDF 1권(11쪽, 도판 7장 · 캡션 생성 완료) + 학급 자료 PDF 3개,
    청크 31개(임베딩 완료)
  · 강의 패키지 2개(하나는 학급에 켜짐) · 영상 4개 · 클립 14개 · 썸네일 3장
  · 데모 학생의 대화 3개(학급 2 · 개인 1)와 친구들의 학급 대화 6개 —
    노드 · 캔버스 카드(개념·도판·클립·메모) · 교차 연결 2개
  · 관리자 콘솔용 턴 로그 · 잡 이력 · 교차 연결 판정 로그

## 한 트랜잭션이다

DB 적재는 **통째로 되거나 통째로 안 된다.** 중간에 실패하면 롤백되어 다음
기동 때 처음부터 다시 시도한다 — 반쯤 시드된 DB에서는 `--if-empty`가 "이미
있다"고 판정해 영영 복구되지 않기 때문이다.

Qdrant는 **실패해도 시드를 막지 않는다.** 벡터가 없으면 검색이 빈손일 뿐 화면은
다 뜬다(RAG는 채팅을 막지 않는다 — 불변식). 다음 기동의 `--if-empty`가 벡터가
빠진 것을 보고 다시 채운다(`_ensure_vectors`).

## 권한 경로

워커 커넥션(BYPASSRLS)으로 넣는다. 계정 생성이 이미 그 경로이고(accounts.py),
시드는 여러 사용자의 행을 한꺼번에 만든다 — 사용자별 RLS 커넥션으로 흉내 내면
관리자 전용 표(강의 카탈로그)와 워커 전용 표(item_links·crosslink_runs)를 넣을
길이 없다. 소유자 열(owner_id·teacher_id·space_ref)은 RLS가 읽는 그대로 채운다.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from ..config import get_settings
from ..db import storage
from ..db.pool import worker_conn
from . import content as c
from . import vectors as vec

logger = logging.getLogger("nodi.seed_demo")
settings = get_settings()

KST = timezone(timedelta(hours=9))


def _j(value: Any) -> str:
    """jsonb 파라미터. SQL 쪽에서 `$n::text::jsonb`로 받는다.

    `$n::jsonb`로 받으면 커넥션에 json 코덱이 걸려 있을 때(db/client.py가 건다)
    이미 직렬화한 문자열을 한 번 더 감싸 **JSON 문자열**이 들어간다 —
    accounts.py가 실측으로 겪은 함정이다. text를 거치면 코덱과 무관하다.
    """
    return json.dumps(value, ensure_ascii=False)


def _jitter(key: str, lo: int, hi: int) -> int:
    """키마다 고정된 '무작위' 정수 — 다시 시드해도 같은 값이 나온다."""
    h = int(hashlib.sha1(key.encode()).hexdigest()[:8], 16)
    return lo + h % (hi - lo + 1)


# ---------------------------------------------------------------------------
# 상태 판정
# ---------------------------------------------------------------------------
async def _state() -> str:
    """'fresh' | 'seeded' | 'conflict'.

    conflict = 데모 계정은 없는데 **같은 이메일·아이디가 이미 있다**(개발 DB에
    teacher@nodi.local이 있는 경우 등). 남의 계정을 덮어쓰지 않고 물러난다.
    """
    emails = [a.email for a in c.ACCOUNTS]
    usernames = [a.username for a in c.ACCOUNTS]
    async with worker_conn() as conn:
        marker = await conn.fetchval(
            "select 1 from public.users where username = $1 or email = $2",
            c.MARKER_USERNAME, c.ACCOUNT_BY_KEY["demo"].email,
        )
        if marker:
            return "seeded"
        clash = await conn.fetchval(
            "select count(*) from public.users"
            " where email = any($1::text[]) or username = any($2::text[])",
            emails, usernames,
        )
        clash_class = await conn.fetchval(
            "select 1 from public.classes where id = $1 or join_code = $2",
            c.CLASS_ID, c.JOIN_CODE,
        )
    return "conflict" if (clash or clash_class) else "fresh"


# ---------------------------------------------------------------------------
# 저장소 (그림 · PDF)
# ---------------------------------------------------------------------------
def _asset(name: str) -> bytes:
    return (vec.ASSETS / name).read_bytes()


def _file_path(f: c.DemoFile) -> str:
    # files.py 업로드와 같은 규약: {owner}/{file}/{ASCII 이름}
    return f"{c.ACCOUNT_BY_KEY['teacher'].id}/{f.id}/{f.storage_name}"


def _figure_path(fig: c.Figure, page: int, element_id: int) -> str:
    # worker/split.py와 같은 규약: {owner}/{file}/figures/p{page}_e{element}.{ext}
    return f"{c.ACCOUNT_BY_KEY['teacher'].id}/{c.TEXTBOOK.id}/figures/p{page}_e{element_id}.png"


def _thumb_id(i: int) -> str:
    return c.uid(f"thumb:{i}")


async def _write_blobs() -> None:
    """저장소에 파일을 쓴다. 덮어쓰기라 멱등이다 — DB 트랜잭션 **전에** 한다.

    순서가 반대면 DB는 커밋됐는데 파일이 없는 상태가 생길 수 있다(목록에는
    뜨는데 열면 404). 파일이 먼저 있고 행이 없는 쪽은 아무 데도 안 보인다.
    """
    bucket = settings.storage_bucket
    for f in c.FILES:
        await storage.upload(bucket, _file_path(f), _asset(f.storage_name), "application/pdf")
    pages = c.figure_pages()
    for i, fig in enumerate(c.FIGURES.values()):
        await storage.upload(bucket, _figure_path(fig, pages[fig.key], i), _asset(fig.image),
                             "image/png")
    await storage.upload(bucket, c.CLASS_AVATAR_PATH, _asset("class_avatar.png"), "image/png")
    for i, (name, _) in enumerate(c.CLIP_THUMBNAILS):
        await storage.upload(bucket, f"clip-thumbs/{_thumb_id(i)}.png", _asset(name), "image/png")


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
class _Clock:
    """시드 시점 기준의 상대 시각. '3일 전' 같은 화면 표시가 자연스럽게 나온다."""

    def __init__(self) -> None:
        self.now = datetime.now(UTC)

    def days_ago(self, days: float) -> datetime:
        return self.now - timedelta(days=days)

    def session_start(self, s: c.Session) -> datetime:
        local = (self.now - timedelta(days=s.days_ago)).astimezone(KST)
        return local.replace(hour=s.hour, minute=_jitter(s.key, 0, 40), second=0,
                             microsecond=0).astimezone(UTC)


async def _seed_accounts(conn, clock: _Clock) -> None:
    from ..auth.tokens import hash_password

    # bcrypt는 일부러 느리다(~0.2초). 계정 9개가 같은 비밀번호라 한 번만 계산한다 —
    # 솔트가 같아지지만 공개된 데모 비밀번호라 숨길 것이 없다.
    pw = hash_password(c.DEMO_PASSWORD)
    for a in c.ACCOUNTS:
        joined = clock.days_ago(a.joined_days_ago)
        meta = {"full_name": a.name}
        if a.role in ("student", "teacher"):
            meta["role"] = a.role
        await conn.execute(
            """
            insert into public.users
                (id, email, username, password_hash, raw_user_meta_data, created_at, updated_at)
            values ($1, $2, $3, $4, $5::text::jsonb, $6, $6)
            """,
            a.id, a.email, a.username, pw, _j(meta), joined,
        )
        # 프로필은 트리거(handle_new_user)가 만들었다. 관리자는 화이트리스트에 막혀
        # student로 떨어져 있으므로 여기서 올린다(cli create-user --role admin과 같다).
        await conn.execute(
            """
            update public.profiles
               set role = $2, display_name = $3, onboarded = true,
                   created_at = $4, updated_at = $4
             where id = $1
            """,
            a.id, a.role, a.name, joined,
        )


async def _seed_class(conn, clock: _Clock) -> None:
    teacher = c.ACCOUNT_BY_KEY["teacher"]
    created = clock.days_ago(c.CLASS_CREATED_DAYS_AGO)
    await conn.execute(
        "insert into public.classes (id, name, join_code, teacher_id, created_at, avatar_path)"
        " values ($1, $2, $3, $4, $5, $6)",
        c.CLASS_ID, c.CLASS_NAME, c.JOIN_CODE, teacher.id, created, c.CLASS_AVATAR_PATH,
    )
    # create_class RPC처럼 만든 선생님도 구성원(teacher)으로 넣는다 —
    # is_class_teacher는 둘 중 하나만 봐도 되지만 class_students 등은 구성원을 본다.
    await conn.execute(
        "insert into public.class_members (class_id, user_id, role_in_class, created_at)"
        " values ($1, $2, 'teacher', $3)",
        c.CLASS_ID, teacher.id, created,
    )
    for a in c.ACCOUNTS:
        if a.role != "student":
            continue
        await conn.execute(
            "insert into public.class_members (class_id, user_id, role_in_class, created_at)"
            " values ($1, $2, 'student', $3)",
            c.CLASS_ID, a.id, clock.days_ago(a.joined_days_ago - 0.2),
        )


async def _seed_files(conn, clock: _Clock) -> None:
    teacher = c.ACCOUNT_BY_KEY["teacher"].id
    manifest = vec.load_manifest()
    sizes = {k: m.get("bytes") for k, m in (manifest.get("files") or {}).items()}
    for f in c.FILES:
        at = clock.days_ago(f.uploaded_days_ago)
        chunks = f.chunks()
        size = sizes.get(f.key) or len(_asset(f.storage_name))
        await conn.execute(
            """
            insert into public.files
                (id, owner_id, space_kind, space_ref, kind, storage_path, mime, size_bytes,
                 status, chunk_total, chunk_done, name, created_at, updated_at)
            values ($1, $2, 'class', $3, $4, $5, 'application/pdf', $6,
                    'indexed', $7, $7, $8, $9, $10)
            """,
            f.id, teacher, c.CLASS_ID, f.kind, _file_path(f), size, len(chunks), f.name,
            at, at + timedelta(minutes=2),
        )
        await conn.executemany(
            "insert into public.file_chunks (id, file_id, seq, chunk_text, status, created_at)"
            " values ($1, $2, $3, $4, 'embedded', $5)",
            [(c.chunk_id(f.key, i), f.id, i, ch.text, at) for i, ch in enumerate(chunks)],
        )
        # 인제스트 잡 이력 — 관리자 개요의 잡 집계가 비어 보이지 않게.
        split_job = c.uid(f"job:split:{f.key}")
        await conn.execute(
            "insert into public.jobs (id, owner_id, kind, target_id, status, progress,"
            " attempts, space_ref, created_at, updated_at)"
            " values ($1, $2, 'embedding_split', $3, 'done', 100, 1, $4, $5, $6)",
            split_job, teacher, f.id, c.CLASS_ID, at, at + timedelta(seconds=20),
        )
        await conn.execute(
            "insert into public.jobs (id, owner_id, kind, target_id, parent_job_id, batch_range,"
            " status, progress, attempts, space_ref, created_at, updated_at)"
            " values ($1, $2, 'embedding_batch', $3, $4, $5::text::jsonb, 'done', 100, 1, $6,"
            " $7, $8)",
            c.uid(f"job:batch:{f.key}"), teacher, f.id, split_job,
            _j({"from_seq": 0, "to_seq": len(chunks)}), c.CLASS_ID,
            at + timedelta(seconds=20), at + timedelta(seconds=40),
        )
        if f.kind == "textbook":
            await conn.execute(
                "insert into public.jobs (id, owner_id, kind, target_id, parent_job_id,"
                " batch_range, status, progress, attempts, space_ref, created_at, updated_at)"
                " values ($1, $2, 'figure_batch', $3, $4, $5::text::jsonb, 'done', 100, 1, $6,"
                " $7, $8)",
                c.uid("job:figures:textbook"), teacher, f.id, split_job,
                _j({"from_seq": 0, "to_seq": len(c.FIGURES)}), c.CLASS_ID,
                at + timedelta(seconds=20), at + timedelta(seconds=95),
            )

    # 교과서 도판 — 캡션은 **생성 완료** 상태(D134: match_kind='generated',
    # embed_text = 생성 캡션 = 임베딩 텍스트). caption 열은 파서 라벨 힌트 자리다.
    pages = c.figure_pages()
    boxes = manifest.get("figure_bbox") or {}
    at = clock.days_ago(c.TEXTBOOK.uploaded_days_ago)
    for i, fig in enumerate(c.FIGURES.values()):
        page = pages[fig.key]
        await conn.execute(
            """
            insert into public.textbook_figures
                (id, file_id, seq, page, element_id, bbox, caption, figure_type, heading,
                 match_kind, embed_text, image_path, page_text, status, created_at)
            values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, 'figure', $8,
                    'generated', $9, $10, $11, 'embedded', $12)
            """,
            fig.id, c.TEXTBOOK.id, i, page, i, _j(boxes.get(fig.key)),
            f"그림 {i + 1}. {fig.caption.split('. ')[0].rstrip('.')}",
            c.figure_heading(fig.key), fig.caption, _figure_path(fig, page, i),
            c.page_text(c.TEXTBOOK, page), at,
        )


async def _seed_lectures(conn, clock: _Clock) -> None:
    admin = c.ACCOUNT_BY_KEY["admin"].id
    for pi, pkg in enumerate(c.PACKAGES):
        at = clock.days_ago(12 - pi)
        await conn.execute(
            "insert into public.lecture_packages (id, grade, subject, title, created_by,"
            " created_at) values ($1, $2, $3, $4, $5, $6)",
            pkg.id, pkg.grade, pkg.subject, pkg.title, admin, at,
        )
        for vi, video in enumerate(pkg.videos):
            vat = at + timedelta(minutes=5 + vi)
            await conn.execute(
                "insert into public.lecture_videos (id, package_id, source, page_url, title,"
                " status, created_at) values ($1, $2, 'demo', $3, $4, 'parsed', $5)",
                video.id, pkg.id, video.page_url, video.title, vat,
            )
            for ci, clip in enumerate(video.clips):
                nxt = video.clips[ci + 1].start_sec if ci + 1 < len(video.clips) else None
                cid = c.clip_id(video.key, clip.key)
                await conn.execute(
                    "insert into public.lecture_clips (id, video_id, seq, start_sec, end_sec,"
                    " title, transcript, status, created_at)"
                    " values ($1, $2, $3, $4, $5, $6, $7, 'embedded', $8)",
                    cid, video.id, ci + 1, clip.start_sec, nxt, clip.title, clip.transcript, vat,
                )
                await conn.executemany(
                    "insert into public.lecture_clip_atoms (id, clip_id, package_id, question,"
                    " status, created_at) values ($1, $2, $3, $4, 'embedded', $5)",
                    [(c.clip_atom_id(video.key, clip.key, k), cid, pkg.id, q, vat)
                     for k, q in enumerate(clip.atoms)],
                )
            for kind, sec in (("lecture_embed", 15), ("lecture_atom", 60)):
                await conn.execute(
                    "insert into public.jobs (id, owner_id, kind, target_id, status, progress,"
                    " attempts, created_at, updated_at)"
                    " values ($1, $2, $3, $4, 'done', 100, 1, $5, $6)",
                    c.uid(f"job:{kind}:{video.key}"), admin, kind, video.id,
                    vat, vat + timedelta(seconds=sec),
                )
        if pkg.enabled:
            await conn.execute(
                "insert into public.class_lecture_packages (class_id, package_id, created_at)"
                " values ($1, $2, $3)",
                c.CLASS_ID, pkg.id, clock.days_ago(11),
            )
    for i, (name, label) in enumerate(c.CLIP_THUMBNAILS):
        await conn.execute(
            "insert into public.clip_thumbnails (id, storage_path, mime, size_bytes, name,"
            " created_by, created_at) values ($1, $2, 'image/png', $3, $4, $5, $6)",
            _thumb_id(i), f"clip-thumbs/{_thumb_id(i)}.png", len(_asset(name)), label, admin,
            clock.days_ago(12),
        )


def _turn_retrieval(s: c.Session, t: c.Turn) -> dict[str, Any]:
    """빌드 때 실제 임베딩으로 잰 검색 결과(manifest). 없으면 빈 값."""
    return (vec.load_manifest().get("turns") or {}).get(f"{s.key}:{t.key}") or {}


def _rag_chunks(s: c.Session, t: c.Turn) -> list[dict[str, Any]]:
    out = []
    for fk, seq, dist in _turn_retrieval(s, t).get("rag") or []:
        f = c.FILE_BY_KEY[fk]
        out.append({
            "file_id": f.id,
            "chunk_id": c.chunk_id(fk, seq),
            "seq": seq,
            "chunk_text": f.chunks()[seq].text,
            "distance": dist,
        })
    return out


def _figure_item(fig_key: str, score: float) -> dict[str, Any]:
    fig = c.FIGURES[fig_key]
    return {
        "figure_id": fig.id,
        "file_id": c.TEXTBOOK.id,
        "page": c.figure_pages()[fig_key],
        "caption": fig.caption,
        "score": round(score, 4),
    }


async def _seed_sessions(conn, clock: _Clock) -> None:
    from ..services import gemini, rag, solar
    from ..services.lecture_search import fmt_timeline

    names = {f.id: f.name for f in c.FILES}
    for s in c.SESSIONS:
        owner = c.ACCOUNT_BY_KEY[s.owner].id
        start = clock.session_start(s)
        times = [start + timedelta(minutes=t.minute, seconds=_jitter(t.key, 5, 50))
                 for t in s.turns]
        last = times[-1] + timedelta(seconds=40)
        await conn.execute(
            "insert into public.sessions (id, owner_id, space_kind, space_ref, title, emoji,"
            " created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
            s.id, owner, s.space, c.CLASS_ID if s.space == "class" else owner,
            s.title, s.emoji, start - timedelta(seconds=30), last,
        )

        seq = 0
        prev_node: str | None = None
        last_by_tag: dict[str, str] = {}
        history_chars = 0
        for i, (t, at) in enumerate(zip(s.turns, times, strict=True)):
            nid = c.node_id(s.key, t.key)
            title, tag, body = c.card_from_answer(t.answer)
            got = _turn_retrieval(s, t)
            fig_scores = got.get("figures") or {}
            clip_scores = got.get("clips") or {}
            figures = [_figure_item(k, 1.0 - float(fig_scores.get(k, 0.45))) for k in t.figures]
            chunks = _rag_chunks(s, t) if s.space == "class" else []
            sources = rag.build_sources(chunks, names)

            attachments: dict[str, Any] = {}
            if figures:
                # chat.py `_patch_canvas_unified`와 같은 모양 — url은 영속하지 않는다(D87).
                attachments["canvas"] = {"figures": figures}
            await conn.execute(
                "insert into public.nodes (id, session_id, parent_id, question, answer, label,"
                " attachments, rag_sources, created_at)"
                " values ($1, $2, $3, $4, $5, null, $6::text::jsonb, $7::text::jsonb, $8)",
                nid, s.id, prev_node, t.question, t.answer, _j(attachments), _j(sources), at,
            )
            prev_node = nid

            # ── 캔버스 카드 ──────────────────────────────────────────
            iid = c.concept_item_id(s.key, t.key)
            parent = (
                c.concept_item_id(s.key, t.parent) if t.parent
                else last_by_tag.get(tag or "")
            )
            item_at = at + timedelta(seconds=25)
            await conn.execute(
                "insert into public.canvas_items (id, session_id, node_id, parent_item_id, kind,"
                " source, title, body, tag, x, y, pinned, seq, data, created_at, updated_at)"
                " values ($1, $2, $3, $4, 'concept', 'ai', $5, $6, $7, $8, $9, false, $10,"
                " $11::text::jsonb, $12, $12)",
                iid, s.id, nid, parent, title, body, tag, 0.0, float(i * 460), seq,
                _j({"askedQuestion": t.question}), item_at,
            )
            last_by_tag[tag or ""] = iid
            seq += 1

            # 도판·클립은 개념 카드에 딸린다(D163). 트리 노드가 아니므로 간선은
            # 안 생기고 배치만 카드 옆으로 붙는다. 좌표는 배치 엔진이 정한다(pinned=false).
            for fig in figures:
                await conn.execute(
                    "insert into public.canvas_items (id, session_id, node_id, parent_item_id,"
                    " kind, source, body, tag, x, y, pinned, seq, data, created_at, updated_at)"
                    " values ($1, $2, $3, $4, 'figure', 'ai', '', $5, 620, $6, false, $7,"
                    " $8::text::jsonb, $9, $9)",
                    c.attach_item_id(s.key, t.key, "figure", fig["figure_id"]), s.id, nid, iid,
                    tag, float(i * 460), seq,
                    _j({
                        "askedQuestion": t.question,
                        "figure": {
                            "figureId": fig["figure_id"],
                            "fileId": fig["file_id"],
                            "page": fig["page"],
                            "caption": fig["caption"],
                            "url": "",  # signed URL은 저장하지 않는다(D87)
                            "score": fig["score"],
                        },
                    }),
                    item_at,
                )
                seq += 1
            for ref in t.clips:
                video, clip = c.clip_ref(ref)
                cid = c.clip_id(video.key, clip.key)
                await conn.execute(
                    "insert into public.canvas_items (id, session_id, node_id, parent_item_id,"
                    " kind, source, body, tag, x, y, pinned, seq, data, created_at, updated_at)"
                    " values ($1, $2, $3, $4, 'clip', 'ai', '', $5, 620, $6, false, $7,"
                    " $8::text::jsonb, $9, $9)",
                    c.attach_item_id(s.key, t.key, "clip", cid), s.id, nid, iid, tag,
                    float(i * 460 + 240), seq,
                    _j({
                        "askedQuestion": t.question,
                        "clip": {
                            "clipId": cid,
                            "videoId": video.id,
                            "title": clip.title,
                            "startSec": clip.start_sec,
                            "timelineLabel": fmt_timeline(clip.start_sec),
                            "pageUrl": video.page_url,
                            "videoTitle": video.title,
                            "score": round(1.0 - float(clip_scores.get(ref, 0.45)), 4),
                        },
                    }),
                    item_at,
                )
                seq += 1
            if t.note:
                # 학생 메모(틸 괘선). 부모를 주면 배치가 그 카드 곁에 둔다.
                await conn.execute(
                    "insert into public.canvas_items (id, session_id, node_id, parent_item_id,"
                    " kind, source, body, tag, x, y, pinned, seq, data, created_at, updated_at)"
                    " values ($1, $2, null, $3, 'note', 'user', $4, $5, -420, $6, false, $7,"
                    " '{}'::jsonb, $8, $8)",
                    c.note_item_id(s.key, t.key), s.id, iid, t.note, tag, float(i * 460), seq,
                    item_at + timedelta(minutes=1),
                )
                seq += 1

            # ── 턴 로그 (관리자 콘솔) ────────────────────────────────
            rag_block = rag.build_block(chunks, names) if chunks else None
            system_prompt, blocks = gemini.compose_system_structured(
                rag_block,
                rag_sources=sources if chunks else None,
                base_instruction=solar.CONCEPT_CARD_SYSTEM_PROMPT,
                format_reminder=solar.FORMAT_REMINDER,
            )
            traces = _skill_traces(s, t, chunks, figures)
            prompt_tokens = (len(system_prompt) + history_chars) // 2
            completion = len(t.answer) // 2
            decide = 900 + _jitter(t.key + "d", 0, 400)
            calls = [
                {"stage": "decide", "model": settings.upstage_chat_model,
                 "prompt": decide, "completion": 40, "total": decide + 40},
                {"stage": "answer", "model": settings.upstage_chat_model,
                 "prompt": prompt_tokens, "completion": completion,
                 "total": prompt_tokens + completion},
            ]
            tokens = {
                "prompt": decide + prompt_tokens,
                "completion": 40 + completion,
                "total": decide + prompt_tokens + 40 + completion,
                "cached": 0,
                "calls": calls,
            }
            await conn.execute(
                "insert into public.ai_logs (id, owner_id, session_id, node_id, kind,"
                " system_prompt, question, answer, contexts, skill_calls, errors,"
                " token_estimate, tokens, route, model, duration_ms, created_at)"
                " values ($1, $2, $3, $4, 'chat', $5, $6, $7, $8::text::jsonb, $9::text::jsonb,"
                " '[]'::jsonb, $10, $11::text::jsonb, 'react', $12, $13, $14)",
                c.uid(f"log:{s.key}:{t.key}"), owner, s.id, nid, system_prompt, t.question,
                t.answer,
                _j({"history": {"turns": i, "chars": history_chars}, "blocks": blocks}),
                _j(traces),
                (len(system_prompt) + history_chars + len(t.question) + len(t.answer)) // 4,
                _j(tokens), settings.upstage_chat_model,
                _jitter(t.key, 5200, 11800), at,
            )
            history_chars += len(t.question) + len(t.answer)

        await conn.execute(
            "update public.sessions set root_node_id = $2, current_head_id = $3 where id = $1",
            s.id, c.node_id(s.key, s.turns[0].key), prev_node,
        )


def _skill_traces(s: c.Session, t: c.Turn, chunks: list[dict], figures: list[dict]) -> list[dict]:
    """오케스트레이터가 남겼을 스킬 트레이스(D113). 개인 세션은 도구 없이 답했다."""
    if s.space != "class":
        return []
    traces: list[dict] = [{
        "skill": "search_class_material", "step": 0, "args": {"query": t.question},
        "ok": True, "message": f"학급 자료에서 {len(chunks)}건을 찾았습니다.",
        "error_code": None, "duration_ms": _jitter(t.key + "r", 280, 640),
    }]
    # D163: 개념 카드가 나온 턴이면 곁들이 둘은 시스템이 대신 부른다(step -1, auto).
    traces.append({
        "skill": "search_textbook_figure", "step": -1, "args": {"query": t.question},
        "ok": True, "message": f"교과서 도판 {len(figures)}건",
        "error_code": None, "duration_ms": _jitter(t.key + "f", 180, 420), "auto": True,
    })
    traces.append({
        "skill": "search_lecture_clip", "step": -1, "args": {"query": t.question},
        "ok": True, "message": f"강의 클립 {len(t.clips)}건",
        "error_code": None, "duration_ms": _jitter(t.key + "c", 160, 380), "auto": True,
    })
    return traces


async def _seed_links(conn, clock: _Clock) -> None:
    """교차 연결(D171) + 판정 로그(D172). 워커가 만들었을 행을 그대로 넣는다."""
    manifest = vec.load_manifest()
    dists = manifest.get("links") or {}
    demo = c.ACCOUNT_BY_KEY["demo"].id
    knobs = {"enabled": True, "lo": 0.42, "hi": 0.66, "top_k": 8, "always_on": False,
             "model": "solar-pro2"}
    for link in c.LINKS:
        fs = c.SESSION_BY_KEY[link.from_ref[0]]
        ts = c.SESSION_BY_KEY[link.to_ref[0]]
        from_id = c.concept_item_id(*link.from_ref)
        to_id = c.concept_item_id(*link.to_ref)
        from_turn = next(t for t in fs.turns if t.key == link.from_ref[1])
        to_turn = next(t for t in ts.turns if t.key == link.to_ref[1])
        at = clock.session_start(fs) + timedelta(minutes=from_turn.minute + 1)
        dist = float(dists.get(link.key, 0.55))
        await conn.execute(
            "insert into public.item_links (id, owner_id, from_item_id, to_item_id, explanation,"
            " distance, opened_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)",
            link.id, demo, from_id, to_id, link.explanation, dist,
            at + timedelta(minutes=3) if link.opened else None, at,
        )
        f_title, f_tag, _ = c.card_from_answer(from_turn.answer)
        t_title, t_tag, _ = c.card_from_answer(to_turn.answer)
        await conn.execute(
            "insert into public.crosslink_runs (id, owner_id, from_item_id, from_session_id,"
            " from_title, from_tag, from_space_kind, knobs, candidates, outcome, link_id,"
            " explanation, searched_sessions, duration_ms, created_at)"
            " values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, 'linked',"
            " $10, $11, 2, $12, $13)",
            c.uid(f"crosslink-run:{link.key}"), demo, from_id, fs.id, f_title, f_tag, fs.space,
            _j(knobs),
            _j([{
                "item_id": to_id, "session_id": ts.id,
                "tag": "".join((t_tag or "").split()).lower(), "space_kind": ts.space,
                "distance": round(dist, 4), "verdict": "accepted", "reason": "링크 생성",
                "session_title": ts.title, "title": t_title,
            }]),
            link.id, link.explanation, _jitter(link.key, 1400, 2600), at,
        )


async def _seed_db() -> None:
    clock = _Clock()
    async with worker_conn() as conn:  # 한 트랜잭션 — 실패하면 전부 롤백
        await _seed_accounts(conn, clock)
        await _seed_class(conn, clock)
        await _seed_files(conn, clock)
        await _seed_lectures(conn, clock)
        await _seed_sessions(conn, clock)
        await _seed_links(conn, clock)


# ---------------------------------------------------------------------------
# Qdrant
# ---------------------------------------------------------------------------
async def _upsert_vectors() -> int:
    """벡터 파일을 Qdrant에 올린다. 올린 포인트 수를 돌려준다. **예외를 던진다.**"""
    from ..services import qdrant_store

    stored = vec.load_vectors()
    if not stored:
        logger.warning("벡터 파일이 없다(%s) — 검색은 빈손이 된다", vec.VECTORS_FILE.name)
        return 0
    by_col: dict[str, list[dict]] = {}
    stale = 0
    for spec in vec.specs():
        got = stored.get(spec.point_id)
        if not got or got.get("h") != vec.text_hash(spec.text):
            # 글이 바뀌었는데 벡터를 다시 안 만들었다 — 틀린 벡터를 올리느니 뺀다.
            stale += 1
            continue
        by_col.setdefault(spec.collection, []).append(
            {"id": spec.point_id, "vector": vec.decode(got["v"]), "payload": spec.payload}
        )
    if stale:
        logger.warning("벡터 %d건이 원문과 어긋나 건너뛴다 — build_demo_assets --embed", stale)
    await qdrant_store.ensure_collections()
    n = 0
    for col, points in by_col.items():
        for i in range(0, len(points), 64):
            await qdrant_store.upsert(col, points[i : i + 64])
        n += len(points)
    return n


async def _load_vectors_best_effort() -> None:
    try:
        n = await _upsert_vectors()
        print(f"  Qdrant 벡터 {n}건 적재")
    except Exception as exc:  # noqa: BLE001 - 벡터가 없어도 화면은 뜬다
        logger.warning("Qdrant 적재 실패 — DB 시드는 유지, 다음 기동 때 다시 시도", exc_info=True)
        print(f"  경고: Qdrant 적재 실패({type(exc).__name__}) — 검색은 빈손, 다음 기동 때 재시도")


async def _ensure_vectors() -> None:
    """이미 시드된 DB에서 **벡터만 빠진** 경우를 메운다.

    첫 기동 때 Qdrant가 늦게 떠서 적재가 실패했거나, Qdrant 볼륨만 지워진
    경우다. 행은 `embedded`인데 벡터가 없으면 검색이 조용히 0건이 된다.
    데모 교과서의 도판 벡터 수로 판정한다 — 셀 수 없으면(-1) 건드리지 않는다.
    """
    from ..services import qdrant_store

    async with worker_conn() as conn:
        ours = await conn.fetchval("select 1 from public.files where id = $1", c.TEXTBOOK.id)
    if not ours:
        return  # 데모 계정만 남고 데모 자료는 지워졌다 — 되살리지 않는다
    # 컬렉션부터 보장한다 — 없는 컬렉션을 세면 404라 count가 -1("못 셌다")을
    # 돌려주고, 그러면 **컬렉션이 지워진 경우**(가장 흔한 복구 사유)를 영영
    # 못 메운다(실측으로 잡았다). ensure_collections는 절대 raise하지 않는다.
    await qdrant_store.ensure_collections()
    try:
        have = await qdrant_store.count(
            qdrant_store.COL_TEXTBOOK_FIGURES, file_ids=[c.TEXTBOOK.id]
        )
    except Exception:  # noqa: BLE001
        have = -1
    if have == -1:
        print("  Qdrant에 닿지 않아 벡터 확인을 건너뛴다")
        return
    if have >= len(c.FIGURES):
        return
    print("  Qdrant에 데모 벡터가 없다 — 다시 적재한다")
    await _load_vectors_best_effort()


# ---------------------------------------------------------------------------
# 진입점
# ---------------------------------------------------------------------------
async def run(*, if_empty: bool) -> int:
    state = await _state()
    if state == "seeded":
        print("데모 데이터가 이미 있다 — DB는 건드리지 않는다")
        await _ensure_vectors()
        return 0 if if_empty else 1
    if state == "conflict":
        print(
            "경고: 데모 계정과 같은 이메일·아이디(또는 학급)가 이미 있다 — 시드하지 않는다.\n"
            "  기존 데이터를 덮어쓰지 않기 위해서다. 빈 DB에서 다시 돌린다."
        )
        return 0 if if_empty else 1

    await _write_blobs()
    await _seed_db()
    n_turns = sum(len(s.turns) for s in c.SESSIONS)
    print(f"데모 데이터 시드 완료 — 계정 {len(c.ACCOUNTS)} · 대화 {len(c.SESSIONS)} · 턴 {n_turns}")
    print(f"  로그인: demo / teacher / admin  (비밀번호 {c.DEMO_PASSWORD})")
    await _load_vectors_best_effort()
    return 0
