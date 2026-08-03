"""태그별 대화 트리 컨텍스트 (D151).

간선 규칙이 프론트(`frontend/src/lib/canvas2/tree.ts`)와 **글자 그대로 같아야**
한다. 한쪽만 고치면 학생이 화면에서 본 트리와 AI가 받는 순서가 갈리는데,
그건 화면에도 로그에도 안 드러난다 — 답이 이상해질 뿐이다. 그래서 테스트로
못 박는다.
"""

from __future__ import annotations

from app.services.canvas_items import _tree_lines


def card(
    id: str,
    tag: str | None,
    parent: str | None = None,
    seq: int = 0,
    *,
    kind: str = "concept",
    source: str = "ai",
    title: str | None = None,
) -> dict:
    return {
        "id": id,
        "parent_item_id": parent,
        "tag": tag,
        "title": title or id,
        "body": f"{id} 본문",
        "kind": kind,
        "source": source,
        "seq": seq,
    }


def flat_ids(trees: dict, tag: str) -> list[str]:
    return [r["id"] for _, r in trees[tag]]


def depths(trees: dict, tag: str) -> list[int]:
    return [d for d, _ in trees[tag]]


def test_사슬은_순서대로_펴진다():
    rows = [card("a", "물리", None, 0), card("b", "물리", "a", 1), card("c", "물리", "b", 2)]
    t = _tree_lines(rows)
    assert flat_ids(t, "물리") == ["a", "b", "c"]
    assert depths(t, "물리") == [0, 1, 2]


def test_가지가_통째로_이어진다():
    # c1의 손자 g1이 형제 c2보다 seq는 크지만 트리 순서로는 먼저다.
    rows = [
        card("r", "물리", None, 0),
        card("c1", "물리", "r", 1),
        card("c2", "물리", "r", 2),
        card("g1", "물리", "c1", 3),
    ]
    assert flat_ids(_tree_lines(rows), "물리") == ["r", "c1", "g1", "c2"]


def test_태그가_다르면_잇지_않는다():
    rows = [card("a", "물리", None, 0), card("b", "화학", "a", 1)]
    t = _tree_lines(rows)
    assert flat_ids(t, "물리") == ["a"]
    assert flat_ids(t, "화학") == ["b"]  # 뿌리가 된다
    assert depths(t, "화학") == [0]


def test_학생_메모와_도판은_트리에_없다():
    rows = [
        card("m", "물리", None, 0, kind="note", source="user"),
        card("f", "물리", None, 1, kind="figure"),
        card("a", "물리", "m", 2),
    ]
    t = _tree_lines(rows)
    # 메모를 부모로 가리켜도 무시되고 a가 뿌리다.
    assert flat_ids(t, "물리") == ["a"]


def test_태그_순서는_첫_등장_순서():
    rows = [card("a", "물리", None, 0), card("x", "생명", None, 1), card("b", "물리", "a", 2)]
    assert list(_tree_lines(rows).keys()) == ["물리", "생명"]


def test_분류_없는_카드는_빠진다():
    rows = [card("a", None, None, 0), card("b", "  ", None, 1)]
    assert _tree_lines(rows) == {}


def test_순환이_있어도_멈추지_않는다():
    rows = [card("a", "물리", "b", 0), card("b", "물리", "a", 1)]
    t = _tree_lines(rows)
    # 뿌리가 없으므로 아무것도 못 펴지만, 무한 루프에 빠지지 않는다.
    assert len(t.get("물리", [])) <= 2


def test_부모가_사라져도_뿌리로_살아남는다():
    rows = [card("b", "물리", "없는-id", 0)]
    assert flat_ids(_tree_lines(rows), "물리") == ["b"]
