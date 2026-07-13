import json
import os
import sys

# scripts/는 패키지가 아니므로 경로를 직접 추가해 모듈로 임포트
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "scripts")
)
import ingest_textbook as I  # noqa: E402

from app.services import qdrant_store  # noqa: E402


def test_scan_files_filters_supported_exts(tmp_path):
    (tmp_path / "b.pdf").write_bytes(b"%PDF")
    (tmp_path / "a.txt").write_text("텍스트", encoding="utf-8")
    (tmp_path / "note.md").write_text("# md", encoding="utf-8")
    (tmp_path / "manifest.json").write_text("[]", encoding="utf-8")
    (tmp_path / "README.md.bak").write_text("x", encoding="utf-8")
    (tmp_path / "README.md").write_text("doc", encoding="utf-8")
    # 정렬된 지원 확장자만 (manifest/README.md/기타 제외)
    assert I.scan_files(str(tmp_path)) == ["a.txt", "b.pdf", "note.md"]


def test_load_manifest_missing_returns_empty(tmp_path):
    assert I.load_manifest(str(tmp_path)) == {}


def test_meta_for_merges_manifest_and_falls_back(tmp_path):
    manifest_entries = [
        {
            "filename": "science.pdf",
            "source_name": "중학 과학 2 (2022 개정)",
            "subject": "과학",
            "grade": "중2",
        }
    ]
    (tmp_path / "manifest.json").write_text(
        json.dumps(manifest_entries), encoding="utf-8"
    )
    manifest = I.load_manifest(str(tmp_path))
    m = I.meta_for("science.pdf", manifest)
    assert m == {
        "source_name": "중학 과학 2 (2022 개정)",
        "subject": "과학",
        "grade": "중2",
    }
    # manifest에 없는 파일 → source_name = 파일명 stem, 나머지 빈 값
    m2 = I.meta_for("국어1.txt", manifest)
    assert m2 == {"source_name": "국어1", "subject": "", "grade": ""}


def test_build_points_ids_and_payload():
    meta = {"source_name": "중학 과학 2", "subject": "과학", "grade": "중2"}
    chunks = ["청크 하나", "청크 둘"]
    vectors = [[0.1] * 4, [0.2] * 4]
    points = I.build_points(meta, chunks, vectors)
    assert len(points) == 2
    assert points[0]["id"] == qdrant_store.textbook_point_id("중학 과학 2", 0)
    assert points[1]["id"] == qdrant_store.textbook_point_id("중학 과학 2", 1)
    p = points[1]["payload"]
    assert p["chunk_text"] == "청크 둘"
    assert p["source_name"] == "중학 과학 2"
    assert p["subject"] == "과학"
    assert p["grade"] == "중2"
    assert p["seq"] == 1
    assert points[1]["vector"] == [0.2] * 4
