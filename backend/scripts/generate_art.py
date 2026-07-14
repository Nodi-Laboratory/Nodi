"""Offline: SVG 아트 라이브러리 생성(Claude) + Qdrant 인덱싱(Upstage 임베딩).

시드(backend/scripts/art_seeds.json)마다:
  1. Claude에게 단일 <svg> 손그림 일러스트 요청.
  2. frontend/public/art/{slug}.svg 저장(정적 서빙).
  3. "title. description. tags"를 Upstage embedding-passage(4096d)로 임베딩.
  4. Supabase art_assets에 메타데이터 upsert(service-role, embedding 컬럼 제외 —
     pgvector 폐기, 컬럼은 nullable) + Qdrant art_assets 컬렉션에 벡터 업서트
     (포인트 id = art_assets 행 uuid, 폴백 uuid5("art:"+slug)).

채팅 시 GET /art/search 가 개념 제목을 임베딩해 Qdrant를 코사인 매칭한다.

Run (from backend/, with root .env populated: ANTHROPIC_API_KEY, UPSTAGE_API_KEY,
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QDRANT_URL):

    pip install -e ".[art]"          # or: pip install anthropic
    python scripts/generate_art.py                 # skip slugs already indexed
    python scripts/generate_art.py --force         # regenerate all
    python scripts/generate_art.py --model claude-opus-4-8
    python scripts/generate_art.py --seeds scripts/art_seeds.json --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys

# Make `app` importable when run as `python scripts/generate_art.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import get_settings  # noqa: E402
from app.services import qdrant_store, upstage  # noqa: E402

settings = get_settings()

DEFAULT_MODEL = "claude-sonnet-4-6"
# frontend/public/art relative to the repo root (backend/../frontend/...).
ART_DIR = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        "..",
        "frontend",
        "public",
        "art",
    )
)

SVG_RE = re.compile(r"<svg\b.*?</svg>", re.IGNORECASE | re.DOTALL)

SYSTEM_PROMPT = (
    "You produce ONE clean, minimal, hand-drawn-style educational SVG illustration. "
    "Rules: output ONLY a single <svg>...</svg> element and nothing else — no prose, "
    "no markdown fences. Use viewBox=\"0 0 400 300\". No <script>, no external refs "
    "(no <image>, no url(...)), no foreignObject. Warm palette only: strokes #2b2620, "
    "fills from #ffc526 / #f4a259 / #7ec8e3 / #ffe9a8 / #fdfbf2. Stroke width 2.5–3, "
    "round line caps. Prefer simple labeled shapes over dense detail. Korean labels are "
    "welcome via <text>."
)


def _extract_svg(text: str) -> str | None:
    m = SVG_RE.search(text or "")
    if not m:
        return None
    svg = m.group(0).strip()
    # Reject anything with obviously unsafe content.
    low = svg.lower()
    if "<script" in low or "foreignobject" in low or "javascript:" in low:
        return None
    return svg


def _generate_svg(client, model: str, seed: dict) -> str | None:
    prompt = (
        f"Concept: {seed['title']}\n"
        f"Show: {seed.get('description', seed['title'])}\n"
        "Draw a clear diagram a student would understand at a glance."
    )
    resp = client.messages.create(
        model=model,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
    )
    parts = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
    return _extract_svg("\n".join(parts))


async def main() -> int:
    ap = argparse.ArgumentParser(description="Generate the SVG art library.")
    ap.add_argument("--seeds", default=os.path.join(os.path.dirname(__file__), "art_seeds.json"))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--force", action="store_true", help="regenerate existing slugs")
    ap.add_argument("--dry-run", action="store_true", help="generate SVGs, skip DB write")
    args = ap.parse_args()

    # ANTHROPIC 키 검증은 실제 Claude 생성이 필요한 시점(기존 SVG 파일 없음)으로
    # 늦춘다 — SVG를 직접 저작해 frontend/public/art/에 두는 오프라인 워크플로는
    # UPSTAGE/SUPABASE/QDRANT만으로 임베딩+인덱싱이 가능해야 한다.
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not settings.upstage_api_key:
        print("ERROR: UPSTAGE_API_KEY is not set (needed for embeddings).", file=sys.stderr)
        return 2

    sb = None
    existing: set[str] = set()
    if not args.dry_run:
        if not (settings.supabase_url and settings.supabase_service_role_key):
            print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.", file=sys.stderr)
            return 2
        from supabase import create_client

        sb = create_client(settings.supabase_url, settings.supabase_service_role_key)
        if not args.force:
            rows = sb.table("art_assets").select("slug").execute()
            existing = {r["slug"] for r in (rows.data or [])}
        # Qdrant 컬렉션 보장(멱등) — 실패해도 여기선 로그만, upsert에서 드러남.
        await qdrant_store.ensure_collections()

    with open(args.seeds, encoding="utf-8") as f:
        seeds = json.load(f)

    os.makedirs(ART_DIR, exist_ok=True)
    client = None  # Claude 클라이언트는 실제 생성이 필요할 때 지연 초기화.

    made = 0
    skipped = 0
    for seed in seeds:
        slug = seed["slug"]
        if slug in existing and not args.force:
            print(f"skip (indexed): {slug}")
            skipped += 1
            continue

        out_path = os.path.join(ART_DIR, f"{slug}.svg")
        if os.path.exists(out_path):
            # 오프라인 저작분 재사용: 파일이 이미 있으면 Claude 생성을 건너뛰고
            # 안전성 검증(_extract_svg)만 통과시킨다. --force 는 "재인덱싱"이지
            # 파일 재생성이 아니다 — 파일을 다시 만들려면 삭제 후 실행.
            with open(out_path, encoding="utf-8") as f:
                svg = _extract_svg(f.read())
            if not svg:
                print(f"  ! existing {out_path} failed safety check; skipping")
                continue
            print(f"reuse (file): {slug} — {seed['title']}")
        else:
            if client is None:
                if not anthropic_key:
                    print(
                        f"  ! {slug}: no existing SVG and ANTHROPIC_API_KEY unset; skipping",
                        file=sys.stderr,
                    )
                    continue
                # 지연 임포트 — 오프라인(파일 재사용) 경로는 anthropic 미설치여도 동작.
                try:
                    from anthropic import Anthropic
                except ImportError:
                    print("ERROR: `anthropic` not installed. Run: pip install anthropic", file=sys.stderr)
                    return 2
                client = Anthropic(api_key=anthropic_key)
            print(f"generating: {slug} — {seed['title']}")
            svg = _generate_svg(client, args.model, seed)
            if not svg:
                print(f"  ! no valid SVG returned for {slug}; skipping")
                continue
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(svg)
            print(f"  saved {out_path} ({len(svg)} bytes)")

        if args.dry_run:
            made += 1
            continue

        doc = f"{seed['title']}. {seed.get('description', '')}. {', '.join(seed.get('tags', []))}"
        try:
            vecs = await upstage.embed_texts([doc], kind="passage")
        except Exception as exc:  # noqa: BLE001
            print(f"  ! embedding failed for {slug}: {exc}; skipping upsert")
            continue
        if not vecs:
            print(f"  ! embedding failed for {slug}; skipping upsert")
            continue

        # Supabase 메타데이터 upsert — embedding 컬럼 제거(pgvector 폐기, nullable).
        assert sb is not None
        res = sb.table("art_assets").upsert(
            {
                "slug": slug,
                "title": seed["title"],
                "description": seed.get("description"),
                "tags": seed.get("tags", []),
                "storage_path": f"/art/{slug}.svg",
            },
            on_conflict="slug",
        ).execute()
        # 포인트 id: art_assets 행 uuid 우선, 없으면 uuid5("art:"+slug) 결정론적.
        row = (res.data or [{}])[0]
        point_id = str(row.get("id") or qdrant_store.art_point_id(slug))

        await qdrant_store.upsert(
            qdrant_store.COL_ART,
            [
                {
                    "id": point_id,
                    "vector": vecs[0],
                    "payload": {
                        "slug": slug,
                        "title": seed["title"],
                        "tags": seed.get("tags", []),
                        "url": f"/art/{slug}.svg",
                    },
                }
            ],
        )
        print(f"  indexed art_assets (supabase+qdrant): {slug}")
        made += 1

    print(f"\nDone. generated={made} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
