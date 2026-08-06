"""E2E가 기대는 학급 시드를 **재현 가능하게** 만든다 (D200).

## 왜 필요한가

`lecture-clip.spec.ts`·`figure-url.spec.ts`는 특정 학급 id와 그 학급의 교과서
도판·강의 클립을 전제로 한다. 그런데 그 데이터는 **누군가의 기계에서 손으로
만든 것**이라 다른 기계에서는 스펙이 그냥 실패한다(실측 2026-08-07: 4건).
`figure.spec.ts`는 같은 상황에서 조용히 skip하는데, 그게 더 나쁘다 —
초록으로 보이면서 아무것도 안 본다(그래서 D167 결함을 놓쳤다).

전제를 코드로 적어 두면 그 둘이 사라진다. 시드가 없으면 못 도는 스펙은
**시드를 만들면 되는 스펙**이 된다.

## 무엇을 심나

  · 학급 하나(고정 id) + e2e 학생 등록
  · 교과서 파일 하나 + 도판 둘 (그림 파일까지 실제로 저장한다)
  · 강의 패키지 하나 + 영상 하나 + 클립 둘, 학급에 연결
  · 위 넷의 임베딩을 **진짜 Upstage로** 만들어 Qdrant에 넣는다

임베딩만 진짜인 이유: 검색 게이트(거리 0.60)가 실제 벡터 공간에서만 뜻이
있다. 가짜 벡터를 넣으면 스펙이 초록이어도 검색이 도는지는 모른다.

## 멱등이다

같은 id로 다시 만든다(`ON CONFLICT DO UPDATE`). 두 번 돌려도 결과가 같고,
학생 대화나 다른 학급은 건드리지 않는다.

## 쓰는 법

    cd backend && uv run python -m scripts.seed_e2e
    (또는) .venv/Scripts/python -m scripts.seed_e2e --check
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import struct
import sys
import zlib
from pathlib import Path

# 윈도우 콘솔은 cp949라 한국어 안내가 그대로면 터진다(줄표 하나에 UnicodeEncodeError).
# 시드 스크립트가 자기 출력 때문에 죽으면 안 된다.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db import storage  # noqa: E402
from app.db.pool import worker_conn  # noqa: E402
from app.services import qdrant_store, upstage  # noqa: E402

settings = get_settings()

# e2e 스펙이 하드코딩한 값들 — 여기가 그 계약의 소유자다.
CLASS_ID = "94f21035-f19e-4b0f-91bd-84aa69d65330"
CLASS_NAME = "3학년 1반"
JOIN_CODE = "E2E001"
STUDENT_EMAIL = "e2e-student@nodi.test"
TEACHER_EMAIL = "teacher@nodi.local"

TEXTBOOK_ID = "94f21035-0000-4000-8000-000000000001"
PACKAGE_ID = "94f21035-0000-4000-8000-000000000002"
VIDEO_ID = "94f21035-0000-4000-8000-000000000003"

FIGURES = [
    {
        "id": "94f21035-0000-4000-8000-000000000101",
        "page": 12,
        "caption": "실험실 안전 수칙 그림 — 보안경과 실험복을 착용한 모습",
        "text": "실험실에서 지켜야 할 안전 수칙을 그림으로 정리했다. "
                "보안경과 실험복을 착용하고, 약품은 반드시 지정된 자리에 둔다.",
    },
    {
        "id": "94f21035-0000-4000-8000-000000000102",
        "page": 48,
        "caption": "지진파 P파와 S파의 전달 경로",
        "text": "지진파가 지구 내부를 지나는 경로. P파는 고체와 액체를 모두 "
                "지나고 S파는 고체만 지난다.",
    },
    {
        # `figure-url.spec.ts`가 묻는 문장이 "미터원기가 뭐야?"다 — 실제
        # 사용자 신고에서 온 질문이라(D167) 스펙을 고치는 대신 시드가 맞춘다.
        "id": "94f21035-0000-4000-8000-000000000103",
        "page": 21,
        "caption": "국제 미터원기 — 백금·이리듐 합금 막대",
        "text": "미터원기는 1미터의 길이를 정하기 위해 만든 백금과 이리듐 합금 "
                "막대다. 국제도량형국이 보관했고, 지금은 빛이 일정 시간 동안 "
                "지나간 거리로 미터를 정의한다.",
    },
]

CLIPS = [
    {
        "id": "94f21035-0000-4000-8000-000000000201",
        "seq": 1,
        "start": 0,
        "title": "실험실 안전 규칙 한눈에 보기",
        "text": "실험실에서 안전하게 실험하려면 무엇을 지켜야 하는지 알아봅니다. "
                "보안경 착용, 약품 취급, 사고가 났을 때의 대처까지 차례로 살펴봅니다.",
    },
    {
        "id": "94f21035-0000-4000-8000-000000000202",
        "seq": 2,
        "start": 420,
        "title": "지진파로 지구 속을 들여다보기",
        "text": "P파와 S파가 어떻게 다른지, 그 차이로 지구 내부의 층 구조를 "
                "어떻게 알아냈는지 설명합니다.",
    },
]


def _png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """단색 PNG를 손으로 만든다.

    Pillow를 새로 들이지 않는 이유: 시드 하나 때문에 배포 의존성이 늘어난다.
    도판 스펙이 보는 것은 "그림 바이트가 오는가"이지 그림의 내용이 아니다.
    """
    raw = b"".join(
        b"\x00" + bytes(rgb) * width for _ in range(height)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


async def _user_id(conn, email: str, role: str, password: str) -> str:
    """계정을 찾는다. 없으면 **만들지 않고 만드는 법을 알려 준다.**

    시드가 계정을 만들면 비밀번호가 스크립트에 박히고, 그 파일이 저장소에
    들어간다. 계정은 CLI로 만드는 것이 이 저장소의 규약이다.
    """
    row = await conn.fetchrow("SELECT id FROM users WHERE email = $1", email)
    if not row:
        raise SystemExit(
            f"{email} 계정이 없다. 먼저 만들어라:\n"
            f"  uv run python -m app.cli create-user {email} '{password}' --role {role}"
        )
    return str(row["id"])


async def seed() -> None:
    async with worker_conn() as conn:
        student = await _user_id(conn, STUDENT_EMAIL, "student", "e2ePass!234")
        # **학급의 교사는 교사여야 한다.** 학생을 teacher_id에 앉히면 그 학생이
        # `is_class_teacher`를 통과해, 스펙이 학생 화면이라고 믿는 곳에서 교사
        # 권한이 섞인다.
        teacher = await _user_id(conn, TEACHER_EMAIL, "teacher", "teacherPass!234")

        # ── 학급 + 등록 ────────────────────────────────────────────────
        await conn.execute(
            """
            INSERT INTO classes (id, name, join_code, teacher_id)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
            """,
            CLASS_ID, CLASS_NAME, JOIN_CODE, teacher,
        )
        await conn.execute(
            """
            INSERT INTO class_members (class_id, user_id, role_in_class)
            VALUES ($1, $2, 'student'), ($1, $3, 'teacher')
            ON CONFLICT (class_id, user_id) DO NOTHING
            """,
            CLASS_ID, student, teacher,
        )

        # ── 교과서 파일 + 도판 ─────────────────────────────────────────
        await conn.execute(
            """
            INSERT INTO files (id, owner_id, name, kind, status, space_kind, space_ref,
                               storage_path, mime, size_bytes)
            VALUES ($1, $2, 'e2e-통합과학.pdf', 'textbook', 'indexed', 'class', $3,
                    $4, 'application/pdf', 1024)
            ON CONFLICT (id) DO UPDATE SET status = 'indexed'
            """,
            TEXTBOOK_ID, teacher, CLASS_ID, f"files/{teacher}/{TEXTBOOK_ID}/e2e.pdf",
        )

        vectors = await upstage.embed_texts(
            [f["text"] for f in FIGURES] + [c["text"] for c in CLIPS],
            kind="passage",
        )
        fig_vecs = vectors[: len(FIGURES)]
        clip_vecs = vectors[len(FIGURES):]

        points = []
        for i, fig in enumerate(FIGURES):
            # **버킷은 `files` 하나다.** `image_path`가 곧 그 버킷 안의 경로이고,
            # 서명·다운로드가 그대로 그 값을 쓴다(figures.py). 여기서 다른 버킷에
            # 넣으면 행은 멀쩡한데 그림만 404가 된다 — 실측 2026-08-07에 그랬다.
            path = f"figures/{teacher}/{TEXTBOOK_ID}/{fig['id']}.png"
            await storage.upload(
                settings.storage_bucket, path, _png(160, 120, (220, 200, 150)),
                "image/png",
            )
            await conn.execute(
                """
                INSERT INTO textbook_figures
                    (id, file_id, seq, page, caption, embed_text, image_path,
                     match_kind, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'generated', 'embedded')
                ON CONFLICT (id) DO UPDATE
                    SET caption = EXCLUDED.caption,
                        embed_text = EXCLUDED.embed_text,
                        image_path = EXCLUDED.image_path,
                        status = 'embedded'
                """,
                fig["id"], TEXTBOOK_ID, i, fig["page"], fig["caption"],
                fig["text"], path,
            )
            points.append(
                {
                    "id": fig["id"],
                    "vector": fig_vecs[i],
                    # 페이로드는 최소 셋만 — Qdrant는 신뢰 경계가 아니다(불변식).
                    "payload": {"figure_id": fig["id"], "file_id": TEXTBOOK_ID,
                                "owner_id": teacher},
                }
            )
        await qdrant_store.upsert(qdrant_store.COL_TEXTBOOK_FIGURES, points)

        # ── 강의 패키지 + 클립 ─────────────────────────────────────────
        await conn.execute(
            """
            INSERT INTO lecture_packages (id, grade, subject, title, created_by)
            VALUES ($1, '중3', '과학', 'E2E 통합과학 강의', $2)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
            """,
            PACKAGE_ID, teacher,
        )
        await conn.execute(
            """
            INSERT INTO lecture_videos (id, package_id, source, page_url, title, status)
            VALUES ($1, $2, 'ebs', 'https://www.ebsi.co.kr/ebs/lms/lmsx/e2e', 'E2E 강의', 'parsed')
            ON CONFLICT (id) DO UPDATE SET status = 'parsed'
            """,
            VIDEO_ID, PACKAGE_ID,
        )
        await conn.execute(
            """
            INSERT INTO class_lecture_packages (class_id, package_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING
            """,
            CLASS_ID, PACKAGE_ID,
        )

        # ── 학생 개인 세션의 도판 카드 ─────────────────────────────────
        #
        # `figure.spec.ts`가 보는 것: **url 없이 저장된 도판**이 화면에서
        # signed URL을 받아 실제로 그려지는가(D167). 그래서 `url`은 일부러
        # 비워 둔다 — 채워 넣으면 그 스펙이 아무것도 안 보게 된다.
        session_id = "94f21035-0000-4000-8000-000000000301"
        await conn.execute(
            """
            INSERT INTO sessions (id, owner_id, title, space_kind)
            VALUES ($1, $2, 'E2E 도판 세션', 'personal')
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
            """,
            session_id, student,
        )
        await conn.execute(
            """
            INSERT INTO canvas_items
                (id, session_id, kind, source, title, body, seq, x, y, data)
            VALUES ($1, $2, 'figure', 'ai', NULL, '', 0, 0, 0, $3::jsonb)
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
            """,
            "94f21035-0000-4000-8000-000000000302", session_id,
            json.dumps(
                {
                    "figure": {
                        "figureId": FIGURES[0]["id"],
                        "fileId": TEXTBOOK_ID,
                        "page": 9,
                        "caption": "E2E도판",
                        "url": "",
                    }
                },
                ensure_ascii=False,
            ),
        )

        clip_points = []
        for i, clip in enumerate(CLIPS):
            await conn.execute(
                """
                INSERT INTO lecture_clips
                    (id, video_id, seq, start_sec, title, transcript, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'embedded')
                ON CONFLICT (id) DO UPDATE
                    SET title = EXCLUDED.title,
                        transcript = EXCLUDED.transcript,
                        status = 'embedded'
                """,
                clip["id"], VIDEO_ID, clip["seq"], clip["start"], clip["title"],
                clip["text"],
            )
            clip_points.append(
                {
                    "id": clip["id"],
                    "vector": clip_vecs[i],
                    "payload": {"clip_id": clip["id"], "package_id": PACKAGE_ID},
                }
            )
        await qdrant_store.upsert(qdrant_store.COL_LECTURE_CLIPS, clip_points)

        # ── 클립 썸네일 두 장 (D190) ───────────────────────────────────
        #
        # 관리자가 올린 사진 중 하나가 클립 카드에 랜덤으로 붙는다. 한 장도
        # 없으면 카드에 그림이 없는 것이 **정상**이라, 시드가 없으면 "썸네일이
        # 안 뜬다"와 "기능이 깨졌다"를 구분할 수 없다.
        for i, rgb in enumerate([(120, 160, 200), (200, 150, 120)], start=1):
            tid = f"94f21035-0000-4000-8000-00000000040{i}"
            tpath = f"clip-thumbs/{tid}.png"
            await storage.upload(settings.storage_bucket, tpath, _png(320, 320, rgb), "image/png")
            await conn.execute(
                """
                INSERT INTO clip_thumbnails (id, storage_path, mime, size_bytes, name,
                                             created_by)
                VALUES ($1, $2, 'image/png', 1024, $3, $4)
                ON CONFLICT (id) DO UPDATE SET storage_path = EXCLUDED.storage_path
                """,
                tid, tpath, f"E2E 썸네일 {i}", teacher,
            )

    print(f"학급 {CLASS_ID} ({CLASS_NAME}, 코드 {JOIN_CODE})")
    print(f"  학생 {STUDENT_EMAIL} 등록")
    print(f"  교과서 도판 {len(FIGURES)}장 · 강의 클립 {len(CLIPS)}개 (임베딩 완료)")
    print("  클립 썸네일 2장 · 학생 개인 세션에 도판 카드 1장")


async def check() -> int:
    """시드가 살아 있는지만 본다 — CI·사람이 빨리 확인하는 용도."""
    async with worker_conn() as conn:
        cls = await conn.fetchval("SELECT count(*) FROM classes WHERE id = $1", CLASS_ID)
        figs = await conn.fetchval(
            "SELECT count(*) FROM textbook_figures WHERE file_id = $1", TEXTBOOK_ID
        )
        clips = await conn.fetchval(
            "SELECT count(*) FROM lecture_clips WHERE video_id = $1", VIDEO_ID
        )
    print(f"학급 {cls} · 도판 {figs} · 클립 {clips}")
    ok = cls == 1 and figs == len(FIGURES) and clips == len(CLIPS)
    print("시드 정상" if ok else "시드 없음 — `python -m scripts.seed_e2e`를 돌려라")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="심지 않고 상태만 본다")
    args = ap.parse_args()
    if args.check:
        raise SystemExit(asyncio.run(check()))
    asyncio.run(seed())


if __name__ == "__main__":
    main()
