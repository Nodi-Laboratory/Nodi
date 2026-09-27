"""데모 시드의 벡터 — 무엇을 임베딩하나 · 파일 형식 (공개판 2026-09-27).

## 왜 벡터를 파일로 들고 다니나

데모는 **API 키 없이** 떠야 한다. 그런데 검색(학급 자료 RAG · 교과서 도판 ·
강의 클립 · 교차 연결 · 홈 개념 지도)은 전부 Qdrant 벡터 위에서 돈다. 벡터가
없으면 방문자가 나중에 자기 Upstage 키를 넣어도 **시드된 자료는 검색되지
않는다** — 행은 `embedded`인데 벡터가 없어 검색이 오류 없이 0건을 돌려준다
(`qdrant_store.count` 머리말의 그 사고와 같은 모양이다).

그래서 개발자가 키로 **한 번** 임베딩해 파일로 커밋하고(`scripts/
build_demo_assets.py --embed`), 시드는 그 파일을 Qdrant에 올리기만 한다.

## 비대칭 규약을 지킨다

여기 담기는 것은 전부 **문서(passage) 벡터**다 — 워커가 적재하는 것과 같은
모델(`embedding-passage`)이다. 질의(query) 벡터는 저장하지 않는다. 질의는
검색하는 순간 방문자의 키로 `embedding-query`가 만든다(불변식).

## 형식

gzip JSON. 벡터는 float16 리틀엔디언을 base64로 담는다 — 1024차원 하나가
2KB다. float16의 상대 오차(약 5e-4)는 코사인 거리 게이트(0.60 등)의 판정을
바꾸지 않는다. 원문의 해시(`h`)를 함께 적어, 글을 고치고 벡터를 다시 안 만든
상태를 테스트가 잡는다.

    {"model": {...}, "dim": 1024,
     "points": {"<point uuid>": {"c": "<collection>", "h": "<sha1 12>", "v": "<b64>"}}}
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import struct
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import content as c

ASSETS = Path(__file__).resolve().parent / "assets"
VECTORS_FILE = ASSETS / "vectors.json.gz"
MANIFEST_FILE = ASSETS / "manifest.json"

DIM = 1024


@dataclass(frozen=True)
class VectorSpec:
    collection: str
    point_id: str
    text: str
    payload: dict[str, Any]


def text_hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def encode(vec: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vec)}e", *vec)).decode("ascii")


def decode(b64: str) -> list[float]:
    raw = base64.b64decode(b64)
    return list(struct.unpack(f"<{len(raw) // 2}e", raw))


def concept_embed_text(title: str | None, body: str) -> str:
    """`crosslink.embed_text`와 같은 규약(제목 + 본문, 2000자 절단).

    그 함수를 부르지 않고 옮겨 적은 이유: 시드는 벡터를 **읽기만** 하는데
    crosslink를 임포트하면 solar·upstage까지 딸려 온다. 규약이 갈리면 테스트가
    잡는다(`test_seed_demo.py`가 두 결과를 비교한다).
    """
    t = (title or "").strip()
    b = (body or "").strip()
    text = f"{t}\n{b}" if t else b
    return text[:2000].strip()


def specs() -> Iterator[VectorSpec]:
    """시드가 Qdrant에 올리는 포인트 전부 — 페이로드 규약은 각 워커와 같다.

    페이로드에는 **식별자만** 넣는다(불변식: Qdrant는 신뢰 경계가 아니다).
    """
    teacher = c.ACCOUNT_BY_KEY["teacher"].id

    # 학급 자료·교과서 청크 (worker/batch.py)
    for f in c.FILES:
        for seq, ch in enumerate(f.chunks()):
            cid = c.chunk_id(f.key, seq)
            yield VectorSpec(
                "file_chunks", cid, ch.text,
                {"chunk_id": cid, "file_id": f.id, "owner_id": teacher},
            )

    # 교과서 도판 — 생성 캡션 단독이 임베딩 텍스트 (worker/figures.py, D134)
    for fig in c.FIGURES.values():
        yield VectorSpec(
            "textbook_figures", fig.id, fig.caption,
            {"figure_id": fig.id, "file_id": c.TEXTBOOK.id, "owner_id": teacher},
        )

    # 강의 클립 + 원자 질문 (worker/lectures.py)
    for pkg in c.PACKAGES:
        for video in pkg.videos:
            for clip in video.clips:
                cid = c.clip_id(video.key, clip.key)
                yield VectorSpec(
                    "lecture_clips", cid, c.clip_embed_text(clip),
                    {"clip_id": cid, "video_id": video.id, "package_id": pkg.id},
                )
                for i, q in enumerate(clip.atoms):
                    aid = c.clip_atom_id(video.key, clip.key, i)
                    yield VectorSpec(
                        "lecture_clip_atoms", aid, q,
                        {"atom_id": aid, "clip_id": cid, "package_id": pkg.id},
                    )

    # 학생의 AI 개념 카드 (crosslink.index_item, D171) — 홈 개념 지도의 선도 여기서 온다
    for s in c.SESSIONS:
        owner = c.ACCOUNT_BY_KEY[s.owner].id
        for t in s.turns:
            title, tag, body = c.card_from_answer(t.answer)
            iid = c.concept_item_id(s.key, t.key)
            yield VectorSpec(
                "canvas_concepts", iid, concept_embed_text(title, body),
                {
                    "item_id": iid,
                    "session_id": s.id,
                    "owner_id": owner,
                    "tag_norm": "".join((tag or "").split()).lower(),
                    "space_kind": s.space,
                },
            )


def load_vectors() -> dict[str, dict[str, Any]]:
    """벡터 파일 → {point_id: {"c","h","v"}}. 파일이 없으면 빈 dict."""
    if not VECTORS_FILE.is_file():
        return {}
    with gzip.open(VECTORS_FILE, "rt", encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("points") or {}


def load_manifest() -> dict[str, Any]:
    """빌드 산출물(도판 위치 · 검색 결과 · 링크 거리). 없으면 빈 dict."""
    if not MANIFEST_FILE.is_file():
        return {}
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
