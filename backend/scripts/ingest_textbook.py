"""Offline: backend/textbooks/ 폴더의 교과서를 Qdrant `textbook` 컬렉션에 인덱싱.

admin 개발자가 폴더에 .pdf/.txt/.md를 넣고 실행하는 운영 파이프라인
(스펙: docs/superpowers/specs/2026-07-13-textbook-rag-design.md).

파일별로:
  1. 텍스트 추출 — PDF는 Upstage Document Parse, .txt/.md는 그대로 읽음.
  2. embedding.chunk_text()로 청킹 (config chunk_size/overlap).
  3. Upstage embedding-passage(4096d) 배치 임베딩.
  4. 같은 source_name 포인트 선삭제 후 Qdrant `textbook` 업서트
     (포인트 id = uuid5("textbook:{source_name}:{seq}") — 결정론적).

메타는 폴더의 manifest.json(선택)에서 읽는다: [{filename, source_name,
subject, grade}]. 항목이 없으면 source_name=파일명 stem, subject/grade 빈 값.

Run (from backend/, with root .env populated: UPSTAGE_API_KEY, QDRANT_URL):

    python scripts/ingest_textbook.py             # backend/textbooks/ 스캔
    python scripts/ingest_textbook.py --dry-run   # 파싱·청킹 미리보기만
    python scripts/ingest_textbook.py --dir /path/to/folder
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

# `python scripts/ingest_textbook.py`로 실행 시 `app` 임포트 가능하도록.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import get_settings  # noqa: E402
from app.services import embedding, qdrant_store, upstage  # noqa: E402

settings = get_settings()

SUPPORTED_EXTS = (".pdf", ".txt", ".md")


def scan_files(dir_path: str) -> list[str]:
    """폴더의 지원 확장자 파일명 목록(정렬). manifest.json 등은 제외."""
    return sorted(
        name
        for name in os.listdir(dir_path)
        if name.lower().endswith(SUPPORTED_EXTS)
        and name != "README.md"
    )


def load_manifest(dir_path: str) -> dict[str, dict]:
    """manifest.json -> {filename: entry}. 없으면 {} (메타 없이도 동작)."""
    path = os.path.join(dir_path, "manifest.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    return {e["filename"]: e for e in entries if e.get("filename")}


def meta_for(filename: str, manifest: dict[str, dict]) -> dict:
    """파일의 인제스트 메타 — manifest 항목 우선, 없으면 파일명 폴백."""
    entry = manifest.get(filename) or {}
    stem = os.path.splitext(filename)[0]
    return {
        "source_name": entry.get("source_name") or stem,
        "subject": entry.get("subject") or "",
        "grade": entry.get("grade") or "",
    }


def find_duplicate_sources(
    files: list[str], manifest: dict[str, dict]
) -> dict[str, list[str]]:
    """같은 source_name으로 해소되는 파일이 둘 이상인 경우를 반환.

    반환: {source_name: [filename, ...]} — 중복 그룹만 포함 (고유한 것은 제외).
    main()이 인제스트 시작 전에 호출해 조용한 데이터 유실을 방지한다.
    """
    by_source: dict[str, list[str]] = {}
    for name in files:
        source = meta_for(name, manifest)["source_name"]
        by_source.setdefault(source, []).append(name)
    return {s: ns for s, ns in by_source.items() if len(ns) > 1}


async def extract_text(path: str) -> str:
    """PDF는 Upstage Document Parse(마크다운), .txt/.md는 그대로."""
    if path.lower().endswith(".pdf"):
        with open(path, "rb") as f:
            data = f.read()
        return await upstage.parse_document(data, os.path.basename(path))
    with open(path, encoding="utf-8") as f:
        return f.read()


def build_points(
    meta: dict, chunks: list[str], vectors: list[list[float]]
) -> list[dict]:
    """청크+벡터 -> Qdrant 포인트 (id는 source_name·seq 결정론 uuid5)."""
    return [
        {
            "id": qdrant_store.textbook_point_id(meta["source_name"], seq),
            "vector": vec,
            "payload": {
                "chunk_text": chunk,
                "source_name": meta["source_name"],
                "subject": meta["subject"],
                "grade": meta["grade"],
                "seq": seq,
            },
        }
        for seq, (chunk, vec) in enumerate(zip(chunks, vectors))
    ]


async def ingest_file(
    dir_path: str, filename: str, manifest: dict[str, dict], dry_run: bool
) -> int:
    """파일 하나 인제스트. 반환: 청크 수. 실패는 raise(호출부가 집계)."""
    meta = meta_for(filename, manifest)
    text = await extract_text(os.path.join(dir_path, filename))
    chunks = embedding.chunk_text(text)
    if not chunks:
        raise RuntimeError("no extractable text")
    if dry_run:
        preview = chunks[0][:80].replace("\n", " ")
        print(
            f"dry-run: {filename} -> source={meta['source_name']!r} "
            f"chunks={len(chunks)}\n  head: {preview}"
        )
        return len(chunks)
    vectors = await upstage.embed_texts(chunks, kind="passage")
    points = build_points(meta, chunks, vectors)
    # 재인제스트 정합성: 청크 수가 줄어든 경우의 옛 tail 포인트 제거.
    await qdrant_store.delete_textbook_source(meta["source_name"])
    await qdrant_store.upsert(qdrant_store.COL_TEXTBOOK, points)
    print(
        f"  upserted: {filename} -> source={meta['source_name']!r} "
        f"chunks={len(points)}"
    )
    return len(points)


async def main() -> int:
    ap = argparse.ArgumentParser(
        description="Ingest textbook files into the Qdrant `textbook` collection."
    )
    default_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "textbooks"
    )
    ap.add_argument("--dir", default=default_dir, help="교과서 폴더 경로")
    ap.add_argument(
        "--dry-run", action="store_true", help="파싱·청킹까지만 (임베딩/업서트 생략)"
    )
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"ERROR: not a directory: {args.dir}", file=sys.stderr)
        return 2
    files = scan_files(args.dir)
    if not files:
        print(f"ERROR: no {SUPPORTED_EXTS} files in {args.dir}", file=sys.stderr)
        return 2
    manifest = load_manifest(args.dir)

    # 중복 source_name 가드 — 같은 소스로 두 파일이 겹치면 나중 파일의
    # 선삭제가 앞 파일 포인트를 지워 조용히 유실된다. 시작 전에 거부한다.
    dups = find_duplicate_sources(files, manifest)
    if dups:
        for s, ns in dups.items():
            print(
                f"ERROR: duplicate source_name {s!r}: {', '.join(ns)}",
                file=sys.stderr,
            )
        return 2

    if not args.dry_run:
        if not settings.upstage_api_key:
            print("ERROR: UPSTAGE_API_KEY is not set (root .env).", file=sys.stderr)
            return 2
        await qdrant_store.ensure_collections()

    ok = 0
    failed: list[str] = []
    for name in files:
        try:
            await ingest_file(args.dir, name, manifest, args.dry_run)
            ok += 1
        except Exception as exc:  # noqa: BLE001 - 파일별 실패는 계속 진행
            failed.append(name)
            print(f"FAILED: {name} — {exc}", file=sys.stderr)

    suffix = " (dry-run)" if args.dry_run else ""
    print(f"\nDone{suffix}. ok={ok} failed={len(failed)}")
    if failed:
        print("failed files: " + ", ".join(failed), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
