"""Visual RAG retrieval + chat injection (Stage 3b-2; Upstage+Qdrant 이전).

A file linked to a node applies to that node and its descendant branch. At chat
time we collect the files linked anywhere on the current head's ancestor chain,
embed the question (Upstage query, 4096d), cosine-search those files' chunks
(Qdrant, file_id 페이로드 필터로 스코핑), and inject the top-K chunks as a
SOURCE-LABELLED reference block ("[연결된 자료에서 참고]") distinct from the
live branch and the Stage-3a memory-link block.

Qdrant는 신뢰 경계가 아니다 — 히트한 chunk_id의 본문/메타는 반드시 USER
스코프 클라이언트로 Supabase에서 재조회해 RLS가 접근(소유/클래스 자료)을
재검증한다(교차 유저 유출 불변식 유지).

Best-effort: any failure -> no RAG context, never blocks the turn.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..config import get_settings
from . import app_settings, embedding, qdrant_store
from .supabase_client import UserClient

logger = logging.getLogger("nodi.rag")
settings = get_settings()


def _file_basename(storage_path: str | None) -> str:
    """Filename from a "{owner}/{file_id}/{name}" storage path."""
    return (storage_path or "").split("/")[-1]


async def linked_file_ids(
    client: UserClient, chain: list[dict[str, Any]]
) -> list[str]:
    """File ids linked to any node on the current branch (head -> root)."""
    node_ids = [n["id"] for n in chain]
    if not node_ids:
        return []
    rows = await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": "file_id",
        },
    )
    seen: list[str] = []
    for r in rows:
        fid = r.get("file_id")
        if fid and fid not in seen:
            seen.append(fid)
    return seen


async def search(
    client: UserClient, file_ids: list[str], query: str, k: int | None = None
) -> list[dict[str, Any]]:
    """Qdrant 코사인 top-K -> Supabase 본문 재조회(RLS) -> 구 RPC 호환 rows.

    반환 shape은 폐기된 search_file_chunks RPC와 동일:
    {file_id, chunk_id, seq, chunk_text, distance, meta}.
    Qdrant는 유사도(score, 높을수록 유사)를 주므로 distance = 1 - score로
    변환해 기존 거리 임계값(0.38/0.50 등) 의미를 그대로 유지한다.
    """
    if not file_ids or not query.strip():
        return []
    if k is None:
        # RAG-injection path (suggest_files passes its own search_k). D62: the
        # admin-tunable rag_top_k overrides the config default.
        overlay = await app_settings.get_overlay()
        k = app_settings.as_int(overlay, "rag_top_k", settings.rag_top_k, 1, 50)
    vec = await embedding.embed_texts([query], task_type="RETRIEVAL_QUERY")
    if not vec:
        return []
    hits = await qdrant_store.search(
        qdrant_store.COL_FILE_CHUNKS,
        vec[0],
        k,
        file_ids=[str(f) for f in file_ids],
    )
    if not hits:
        return []
    # 유사도 -> 거리 변환. 포인트 id == 청크 uuid(워커 업서트 규약).
    distances = {h["id"]: 1.0 - float(h["score"]) for h in hits}
    # 본문/메타는 USER 스코프 클라이언트로 재조회 — RLS가 소유/클래스 자료
    # 접근을 재검증한다(Qdrant 페이로드의 본문 없음 + 신뢰 경계 아님).
    rows = await client.select(
        "file_chunks",
        {
            "id": f"in.({','.join(distances)})",
            "status": "eq.embedded",
            "select": "id,file_id,seq,chunk_text,meta",
        },
    )
    by_id = {str(r["id"]): r for r in rows}
    out: list[dict[str, Any]] = []
    for h in hits:  # Qdrant 랭킹 유지; RLS/삭제로 못 읽는 id는 조용히 탈락
        r = by_id.get(h["id"])
        if not r:
            continue
        out.append(
            {
                "file_id": r.get("file_id"),
                "chunk_id": r.get("id"),
                "seq": r.get("seq"),
                "chunk_text": r.get("chunk_text"),
                "distance": distances[h["id"]],
                "meta": r.get("meta"),
            }
        )
    return out


SNIPPET_CHARS = 300


def _source_label(name: str, seq: Any, page: Any) -> str:
    """Inline provenance label for a chunk, e.g. "note.pdf · #12" (+ page)."""
    parts: list[str] = []
    if name:
        parts.append(name)
    if seq is not None:
        parts.append(f"#{seq}")
    if page is not None:
        parts.append(f"p.{page}")
    return " · ".join(parts)


def build_block(chunks: list[dict[str, Any]], names: dict[str, str]) -> str:
    """Render retrieved chunks as a SOURCE-LABELLED reference block (D32).

    Each line carries its provenance inline so the model — and the saved system
    prompt — show which file·chunk a passage came from.
    """
    if not chunks:
        return ""
    lines = ["[연결된 자료에서 참고]"]
    for c in chunks:
        text = (c.get("chunk_text") or "").strip()
        if not text:
            continue
        meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
        label = _source_label(
            names.get(c.get("file_id"), ""),
            c.get("seq"),
            (meta or {}).get("page"),
        )
        prefix = f"[{label}] " if label else ""
        lines.append(f"- {prefix}{text}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_sources(
    chunks: list[dict[str, Any]], names: dict[str, str]
) -> list[dict[str, Any]]:
    """Per-chunk provenance metadata (D32/D35): file·#seq·page·distance·snippet."""
    sources: list[dict[str, Any]] = []
    for c in chunks:
        fid = c.get("file_id")
        if not fid:
            continue
        meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
        sources.append(
            {
                "file_id": fid,
                # D41: keep the chunk id so the "⋯" panel can fetch the full
                # text + neighbours on demand (get_chunk_context). Older nodes
                # saved before this may lack it → frontend treats it as optional.
                "chunk_id": c.get("chunk_id"),
                "name": names.get(fid, ""),
                "seq": c.get("seq"),
                "page": (meta or {}).get("page"),
                "distance": c.get("distance"),
                "snippet": (c.get("chunk_text") or "")[:SNIPPET_CHARS],
            }
        )
    return sources


async def _file_names(
    client: UserClient, file_ids: list[str]
) -> dict[str, str]:
    """Map file_id -> 표시명 in one query. D79: files.name(원본 표시명) 우선,
    구파일(name NULL — 백필 전)은 storage_path basename으로 폴백."""
    if not file_ids:
        return {}
    rows = await client.select(
        "files",
        {
            "id": f"in.({','.join(file_ids)})",
            "select": "id,name,storage_path",
        },
    )
    return {
        r["id"]: (r.get("name") or _file_basename(r.get("storage_path")))
        for r in rows
    }


async def class_material_file_ids(
    client: UserClient, space_ref: str
) -> list[str]:
    """학급 자료(class_material) 중 검색 가능한(indexed/partial) 파일 id들 (D73).

    partial도 임베딩된 청크는 검색 가능. USER 스코프 조회 — RLS(0012)가 학급
    구성원 여부를 재검증한다.
    """
    rows = await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{space_ref}",
            "kind": "eq.class_material",
            "status": "in.(indexed,partial)",
            "select": "id",
        },
    )
    return [r["id"] for r in rows if r.get("id")]


async def build_rag_context(
    client: UserClient,
    chain: list[dict[str, Any]],
    query: str,
    *,
    space_kind: str | None = None,
    space_ref: str | None = None,
) -> dict[str, Any] | None:
    """Best-effort: assemble the linked-file reference block + source metadata.

    D73: 학급 세션(space_kind='class')이면 그 학급의 class_material 파일을
    링크 파일과 **합집합**으로 검색한다. 자동 스코프(비링크) 청크에만 거리
    게이트(class_material_rag_max_distance)를 적용해 인사말·무관 질의 턴의
    프롬프트 오염을 막고, 링크 청크는 기존대로 무게이트(사용자가 명시한 신뢰).

    Returns ``{"block": str, "sources": [ {file_id, name, seq, page, distance,
    snippet} ]}`` or ``None`` when there is nothing to inject. Callers use
    ``block`` for the system prompt and ``sources`` for node/log provenance (D32).
    """
    try:
        linked = await linked_file_ids(client, chain)
        linked_set = set(linked)
        auto_ids: list[str] = []
        max_dist: float | None = None
        if space_kind == "class" and space_ref:
            overlay = await app_settings.get_overlay()
            if app_settings.as_bool(
                overlay,
                "class_material_rag_enabled",
                settings.class_material_rag_enabled,
            ):
                auto_ids = [
                    f
                    for f in await class_material_file_ids(client, space_ref)
                    if f not in linked_set
                ]
                max_dist = app_settings.as_float(
                    overlay,
                    "class_material_rag_max_distance",
                    settings.class_material_rag_max_distance,
                    0.1,
                    0.9,
                )
        file_ids = linked + auto_ids
        if not file_ids:
            return None
        chunks = await search(client, file_ids, query)
        if auto_ids and max_dist is not None:
            # D73: 자동 스코프 청크만 거리 게이트(링크 청크는 무게이트).
            chunks = [
                c
                for c in chunks
                if c.get("file_id") in linked_set
                or (c.get("distance") is not None and c["distance"] <= max_dist)
            ]
        if not chunks:
            return None
        hit_ids = list({c.get("file_id") for c in chunks if c.get("file_id")})
        names = await _file_names(client, hit_ids)
        block = build_block(chunks, names)
        if not block:
            return None
        # D76 부수: 주입 관측성 — 마무리 E2E의 주입 증거(기존 RAG 관측성 0).
        logger.info(
            "RAG 주입: files=%d(링크 %d·자동 %d) chunks=%d",
            len(hit_ids),
            len(linked),
            len(auto_ids),
            len(chunks),
        )
        return {"block": block, "sources": build_sources(chunks, names)}
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("RAG retrieval failed")
        return None


def _branch_query_text(chain: list[dict[str, Any]]) -> str:
    """Use the tail of the branch (recent Q&A) as the RAG-injection query.

    RAG-INJECTION ONLY (build_rag_context path): it searches files already LINKED
    to the branch, so blending the whole chain is safe (low false-positive risk).
    NOTE: file SUGGESTION no longer uses this — see _suggestion_query_text (D56).
    """
    parts: list[str] = []
    for n in reversed(chain):
        if n.get("is_navigator"):
            continue
        q = (n.get("question") or "").strip()
        a = (n.get("answer") or "").strip()
        if q or a:
            parts.append(f"{q}\n{a}")
        if len("\n".join(parts)) >= settings.file_suggestion_query_chars:
            break
    text = "\n".join(reversed(parts))
    return text[: settings.file_suggestion_query_chars]


# D56: char cap for the focus-centred SUGGESTION query (small on purpose).
# D62: the cap is now admin-tunable (file_suggestion_suggest_query_chars) and
# passed in by suggest_files; this constant is the config fallback default.
SUGGEST_QUERY_CHARS = settings.file_suggestion_suggest_query_chars


def _suggestion_query_text(
    chain: list[dict[str, Any]], cap: int = SUGGEST_QUERY_CHARS
) -> str:
    """Focus-centred query for FILE SUGGESTIONS (D56).

    Root cause of unrelated-branch suggestions: the old query blended the WHOLE
    ancestor chain (root->focus) into one ~1500-char embedding, so a topic touched
    anywhere upstream (whose file exists) sat near that file even after the focus
    moved on. Here we use the FOCUS node's question as the main signal, add only
    the immediate parent's question as weak context, and at most the head 200
    chars of the focus answer — capped small (~450). Distant ancestors are
    dropped, so the query reflects "what's being asked right now", not an average
    of the whole branch.
    """
    reals = [n for n in chain if not n.get("is_navigator")]
    if not reals:
        return ""
    focus = reals[-1]
    parts: list[str] = [
        (focus.get("question") or "").strip(),
        (focus.get("answer") or "").strip()[:200],
    ]
    if len(reals) >= 2:
        # Weak parent context (question only) ahead of the focus signal.
        parts.insert(0, (reals[-2].get("question") or "").strip())
    text = "\n".join(p for p in parts if p)
    return text[:cap]


# --- D48: conservative greeting / small-talk stoplist -----------------------
# Intentionally a SMALL KO/EN core subset. Over-listing would re-introduce the
# false-negatives the distance gate (cutoff 0.50 + margin 0.05) already prevents
# — so when in doubt we treat a token as substantive and ALLOW the suggestion.
_GREETING_STOPWORDS: frozenset[str] = frozenset(
    {
        # 한국어 인사·감탄·메타발화
        "안녕", "안녕하세요", "안녕하십니까", "하이", "헬로", "반가워",
        "반가워요", "반갑습니다", "고마워", "고마워요", "고맙습니다", "감사",
        "감사해", "감사해요", "감사합니다", "잘가", "잘자", "바이", "테스트",
        "오케이", "오키", "넵", "응", "음", "누구", "누구야", "누구세요",
        "뭐해", "뭐하니", "심심해",
        # 영어
        "hello", "hi", "hey", "yo", "thanks", "thank", "thx", "ok", "okay",
        "test", "testing", "bye",
    }
)
# Common Korean particle/ending tails — stripped ONLY to re-test against the
# stoplist (e.g. "테스트야" / "누구세요" → "테스트" / "누구"). Conservative.
_KO_PARTICLE_SUFFIXES: tuple[str, ...] = (
    "입니다", "이에요", "예요", "에요", "이야", "야", "요",
)
# Laughter / filler jamo ("ㅋㅋ", "ㅎㅎ", "ㅠㅠ").
_LAUGH_CHARS: frozenset[str] = frozenset("ㅋㅎㅠㅜ")


def _normalize_token(tok: str) -> str:
    """Lowercase + strip surrounding punctuation/space for stoplist matching."""
    return tok.strip().strip(".,!?~…\"'`()[]{}<>:;-").lower()


def _is_greeting_token(tok: str) -> bool:
    """True when a single token is pure greeting/interjection/punctuation."""
    t = _normalize_token(tok)
    if not t:  # punctuation-only token → no substance
        return True
    if t in _GREETING_STOPWORDS:
        return True
    if all(ch in _LAUGH_CHARS for ch in t):  # ㅋㅋ / ㅎㅎ / ㅠㅠ
        return True
    for suf in _KO_PARTICLE_SUFFIXES:  # strip a tail, re-test against stoplist
        if t.endswith(suf) and t[: -len(suf)] in _GREETING_STOPWORDS:
            return True
    return False


def _greeting_only(chain: list[dict[str, Any]]) -> bool:
    """True when the branch's user QUESTIONS are greetings/small-talk only (D48).

    Tokenizes ONLY the question text of non-navigator real nodes (answers are
    ignored), drops the conservative greeting stoplist, and returns True when NO
    substantive token remains. Belt-and-suspenders for greetings whose long
    answer would otherwise slip past the length floor. Ambiguous cases — any
    unknown token, or no question text at all — return False so the suggestion
    is allowed and the distance/margin gate decides (avoids over-blocking).
    """
    saw_token = False
    for n in chain:
        if n.get("is_navigator"):
            continue
        q = (n.get("question") or "").strip()
        if not q:
            continue
        for raw in re.split(r"\s+", q):
            if not raw.strip():
                continue
            saw_token = True
            if not _is_greeting_token(raw):
                return False
    # No question tokens at all → not enough signal to call it a greeting.
    return saw_token


async def suggest_files(
    client: UserClient,
    chain: list[dict[str, Any]],
    space_kind: str,
    space_ref: str,
) -> list[dict[str, Any]]:
    """Propose files to link when the current branch has NONE linked yet.

    Returns top-N files (grouped by best chunk distance) with a sample chunk.
    Empty if the branch already has linked files or the space has no indexed
    files. Best-effort.
    """
    try:
        # D62/D63: resolve the suggestion gate from the admin overlay (falling
        # back to config). All knobs read here so an admin slider change takes
        # live effect on the next turn.
        overlay = await app_settings.get_overlay()
        # Global on/off: admin can disable file suggestions entirely.
        if not app_settings.as_bool(overlay, "file_suggestion_enabled", True):
            return []
        # Already has linked files on this branch -> no suggestion.
        if await linked_file_ids(client, chain):
            return []
        # Indexed files available in this space (own + class_material via RLS).
        files = await client.select(
            "files",
            {
                "space_kind": f"eq.{space_kind}",
                "space_ref": f"eq.{space_ref}",
                "status": "eq.indexed",
                "select": "id,storage_path,mime,kind,name",
            },
        )
        if not files:
            return []
        by_id = {f["id"]: f for f in files}
        # D56: focus-centred query (NOT the whole-chain _branch_query_text) so
        # unrelated ancestor topics no longer pull in their files. D62: the cap
        # is admin-tunable.
        suggest_query_chars = app_settings.as_int(
            overlay,
            "file_suggestion_suggest_query_chars",
            settings.file_suggestion_suggest_query_chars,
            100,
            1500,
        )
        query = _suggestion_query_text(chain, suggest_query_chars)
        # D48 content gate (relaxed). Two cheap, conservative pre-filters only;
        # PRECISION is owned by the suggestion-only distance cutoff + margin below.
        #  1) hard floor: skip empty / whitespace-only branch queries (min 10).
        #  2) greeting stoplist: skip when the branch's QUESTIONS are pure
        #     greetings/small-talk (covers greetings whose long answer would
        #     slip past the floor). Short-but-real questions ("미분이 뭐야?") now
        #     reach search and are judged by relevance, not length.
        min_query_chars = app_settings.as_int(
            overlay,
            "file_suggestion_min_query_chars",
            settings.file_suggestion_min_query_chars,
            0,
            500,
        )
        if len(query.strip()) < min_query_chars:
            return []
        if _greeting_only(chain):
            return []
        search_k = app_settings.as_int(
            overlay,
            "file_suggestion_search_k",
            settings.file_suggestion_search_k,
            1,
            100,
        )
        chunks = await search(client, list(by_id), query, k=search_k)
        # Group chunks by file, keep best (smallest) distance + a sample.
        best: dict[str, dict[str, Any]] = {}
        for c in chunks:
            fid = c.get("file_id")
            if fid not in by_id:
                continue
            dist = c.get("distance")
            cur = best.get(fid)
            if cur is None or (dist is not None and dist < cur["distance"]):
                best[fid] = {
                    "file_id": fid,
                    "distance": dist if dist is not None else 1.0,
                    # D79: 표시명은 files.name 우선, 구파일은 storage_path
                    # "{owner}/{file_id}/{name}" basename으로 폴백(_file_names와 동일).
                    "name": by_id[fid].get("name")
                    or _file_basename(by_id[fid].get("storage_path")),
                    "sample": (c.get("chunk_text") or "")[:300],
                    "kind": by_id[fid].get("kind"),
                }
        # Only suggest genuinely-related files. D56: use the SUGGESTION-ONLY
        # cutoff/margin (config, default 0.38/0.05) — STRICTER and decoupled from
        # the older shared 0.50 cutoff, so proposals require a clearly-related top
        # match. Borderline candidates are not proposed.
        max_distance = app_settings.as_float(
            overlay,
            "file_suggestion_suggest_max_distance",
            settings.file_suggestion_suggest_max_distance,
            0.1,
            0.9,
        )
        margin = app_settings.as_float(
            overlay,
            "file_suggestion_suggest_margin",
            settings.file_suggestion_suggest_margin,
            0.0,
            0.5,
        )
        top_n = app_settings.as_int(
            overlay, "file_suggestion_top_n", settings.file_suggestion_top_n, 1, 5
        )
        ranked = sorted(
            (b for b in best.values() if b["distance"] <= max_distance),
            key=lambda x: x["distance"],
        )
        # Margin gate: the best candidate must be clearly inside the cutoff,
        # else propose nothing (borderline matches are not "관련 있어 보여요").
        if not ranked or ranked[0]["distance"] > (max_distance - margin):
            return []
        return ranked[:top_n]
    except Exception:  # noqa: BLE001 - suggestions are optional
        logger.exception("File suggestion failed")
        return []
