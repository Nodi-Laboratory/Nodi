"""데모 시드 자산의 무결성 (공개판 2026-09-27).

DB 없이 도는 검사만 둔다. 지키는 것은 셋이다:

  · 벡터 파일이 **지금 원고와 맞는가** — 글을 고치고 `build_demo_assets --embed`를
    안 돌리면 시드는 그 벡터를 건너뛰고, 검색이 조용히 빈손이 된다.
  · 원고가 화면이 읽는 형식을 지키는가 — 개념 카드 봉투·분류 태그.
  · 시드가 기대는 파일(그림·PDF·manifest)이 전부 있는가.
"""

from __future__ import annotations

import math

from app.cli import build_parser
from app.seed_demo import content as c
from app.seed_demo import vectors as v
from app.services import crosslink


def test_every_point_has_a_fresh_1024d_vector() -> None:
    stored = v.load_vectors()
    specs = list(v.specs())
    assert stored, "assets/vectors.json.gz가 없다 — build_demo_assets --embed"
    missing = [s.point_id for s in specs if s.point_id not in stored]
    stale = [
        s.point_id for s in specs
        if s.point_id in stored and stored[s.point_id]["h"] != v.text_hash(s.text)
    ]
    assert not missing, f"벡터 없는 포인트 {len(missing)}개 — build_demo_assets --embed"
    assert not stale, f"원문이 바뀐 포인트 {len(stale)}개 — build_demo_assets --embed"
    # 원고에서 사라진 포인트가 파일에 남아 있으면 안 된다(유령 벡터).
    assert set(stored) == {s.point_id for s in specs}
    for s in specs:
        got = stored[s.point_id]
        assert got["c"] == s.collection
        vec = v.decode(got["v"])
        assert len(vec) == v.DIM
        # 워커가 넣는 벡터는 L2 정규화돼 있다 — float16 반올림 오차만 허용한다.
        assert abs(math.sqrt(sum(x * x for x in vec)) - 1.0) < 1e-2


def test_point_ids_are_unique() -> None:
    ids = [s.point_id for s in v.specs()]
    assert len(ids) == len(set(ids))


def test_payloads_carry_identifiers_only() -> None:
    """Qdrant는 신뢰 경계가 아니다 — 본문·제목을 페이로드에 넣지 않는다(불변식)."""
    allowed = {
        "file_chunks": {"chunk_id", "file_id", "owner_id"},
        "textbook_figures": {"figure_id", "file_id", "owner_id"},
        "lecture_clips": {"clip_id", "video_id", "package_id"},
        "lecture_clip_atoms": {"atom_id", "clip_id", "package_id"},
        "canvas_concepts": {"item_id", "session_id", "owner_id", "tag_norm", "space_kind"},
    }
    for s in v.specs():
        assert set(s.payload) == allowed[s.collection], s.collection


def test_concept_embed_text_matches_crosslink() -> None:
    """시드가 옮겨 적은 규약이 워커(crosslink.embed_text)와 같아야 한다."""
    for s in c.SESSIONS:
        for t in s.turns:
            title, _, body = c.card_from_answer(t.answer)
            assert v.concept_embed_text(title, body) == crosslink.embed_text(
                {"title": title, "body": body}
            )
            assert crosslink.norm_tag(c.card_from_answer(t.answer)[1]) == next(
                sp.payload["tag_norm"] for sp in v.specs()
                if sp.point_id == c.concept_item_id(s.key, t.key)
            )


def test_answers_follow_concept_card_format() -> None:
    for s in c.SESSIONS:
        for t in s.turns:
            assert t.answer.startswith("CHAT: ")
            assert t.answer.count("@concept:") == 1
            assert t.answer.rstrip().endswith("@end")
            title, tag, body = c.card_from_answer(t.answer)
            assert title and tag and body
            assert "@related" not in body and "@end" not in body
            # 개인 세션에는 학급 도구(도판·클립)가 노출되지 않는다(ai/catalog.py).
            if s.space == "personal":
                assert not t.figures and not t.clips


def test_references_resolve() -> None:
    for s in c.SESSIONS:
        keys = [t.key for t in s.turns]
        assert len(keys) == len(set(keys))
        for t in s.turns:
            assert t.parent is None or keys.index(t.parent) < keys.index(t.key)
            for fk in t.figures:
                assert fk in c.FIGURES
            for ref in t.clips:
                video, _ = c.clip_ref(ref)
                assert c.PACKAGE_OF_VIDEO[video.key].enabled, "학급에 꺼진 패키지의 클립"
    for link in c.LINKS:
        fs = c.SESSION_BY_KEY[link.from_ref[0]]
        ts = c.SESSION_BY_KEY[link.to_ref[0]]
        # 방향 규칙: 학급 카드가 개인 카드를 가리키면 안 된다(crosslink.allowed_space_kinds).
        assert ts.space in crosslink.allowed_space_kinds(fs.space)
        assert fs.owner == ts.owner


def test_manifest_covers_turns_figures_and_links() -> None:
    m = v.load_manifest()
    assert set(m["figure_bbox"]) == set(c.FIGURES)
    for s in c.SESSIONS:
        if s.space != "class":
            continue
        for t in s.turns:
            got = m["turns"][f"{s.key}:{t.key}"]
            assert set(got["figures"]) == set(t.figures)
            assert set(got["clips"]) == set(t.clips)
            for fk, seq, dist in got["rag"]:
                assert 0 <= seq < len(c.FILE_BY_KEY[fk].chunks())
                assert 0.0 <= dist <= 0.60
    assert set(m["links"]) == {lk.key for lk in c.LINKS}


def test_assets_exist() -> None:
    names = [f.storage_name for f in c.FILES]
    names += [fig.image for fig in c.FIGURES.values()]
    names += [n for n, _ in c.CLIP_THUMBNAILS] + ["class_avatar.png"]
    for n in names:
        data = (v.ASSETS / n).read_bytes()
        assert data[:4] in (b"%PDF", b"\x89PNG"), n
    # 쪽 번호는 실제 PDF 쪽 수 안에 있어야 한다(도판 page).
    pages = v.load_manifest()["files"]["textbook"]["pages"]
    assert max(c.figure_pages().values()) <= pages == len(c.TEXTBOOK.pages)


def test_cli_parses_seed_demo() -> None:
    args = build_parser().parse_args(["seed-demo", "--if-empty"])
    assert args.if_empty is True
    assert build_parser().parse_args(["seed-demo"]).if_empty is False
