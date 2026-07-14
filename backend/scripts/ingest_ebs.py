"""Offline: EBS 강의 카탈로그(32개)를 Qdrant `ebs` 컬렉션에 인덱싱.

각 항목(backend/scripts/ebs_catalog.json)마다:
  1. "{title}. {keywords ', '로 연결}"을 Upstage embedding-passage(4096d)로 임베딩.
  2. Qdrant `ebs`에 업서트 — 포인트 id = uuid5(NAMESPACE_URL, "ebs:"+videoId)
     (결정론적 — 재실행 시 중복 없이 덮어씀), payload {"video_id","title"}.

채팅 시 POST /retrieve 가 질의를 임베딩해 이 컬렉션을 코사인 매칭한다
(썸네일 URL은 video_id로 파생 — 페이로드에 저장 안 함).

Run (from backend/, with root .env populated: UPSTAGE_API_KEY, QDRANT_URL):

    python scripts/ingest_ebs.py
    python scripts/ingest_ebs.py --catalog scripts/ebs_catalog.json --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

# `python scripts/ingest_ebs.py`로 실행 시 `app` 임포트 가능하도록.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import get_settings  # noqa: E402
from app.services import qdrant_store, upstage  # noqa: E402

settings = get_settings()


def _doc_text(entry: dict) -> str:
    return f"{entry['title']}. {', '.join(entry.get('keywords', []))}"


async def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest the EBS catalog into Qdrant.")
    ap.add_argument(
        "--catalog",
        default=os.path.join(os.path.dirname(__file__), "ebs_catalog.json"),
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="print entries, skip embed + upsert"
    )
    args = ap.parse_args()

    with open(args.catalog, encoding="utf-8") as f:
        entries = json.load(f)
    if not entries:
        print("ERROR: catalog is empty.", file=sys.stderr)
        return 2

    if args.dry_run:
        for e in entries:
            pid = qdrant_store.ebs_point_id(e["videoId"])
            print(f"dry-run: {e['videoId']} -> {pid}\n  text: {_doc_text(e)}")
        print(f"\nDone (dry-run). entries={len(entries)}")
        return 0

    if not settings.upstage_api_key:
        print("ERROR: UPSTAGE_API_KEY is not set (root .env).", file=sys.stderr)
        return 2

    # 32개 <= 배치 상한(100) — 한 번에 임베딩(입력 순서 보존).
    print(f"embedding {len(entries)} entries (embedding-passage, 4096d)...")
    vecs = await upstage.embed_texts([_doc_text(e) for e in entries], kind="passage")

    await qdrant_store.ensure_collections()
    points = [
        {
            "id": qdrant_store.ebs_point_id(e["videoId"]),
            "vector": vec,
            "payload": {"video_id": e["videoId"], "title": e["title"]},
        }
        for e, vec in zip(entries, vecs)
    ]
    await qdrant_store.upsert(qdrant_store.COL_EBS, points)
    for p in points:
        print(f"  upserted: {p['payload']['video_id']} — {p['payload']['title']}")

    print(f"\nDone. upserted={len(points)} -> collection '{qdrant_store.COL_EBS}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
