from pathlib import Path

MIG = Path(__file__).resolve().parents[2] / "db/migrations/2026-08-03-d149-lecture-clips.sql"
SCHEMA = Path(__file__).resolve().parents[2] / "db/01_schema.sql"


def test_migration_idempotent_and_tables():
    sql = MIG.read_text(encoding="utf-8")
    for t in ("lecture_packages", "lecture_videos", "lecture_clips",
              "lecture_clip_atoms", "class_lecture_packages"):
        assert f"CREATE TABLE IF NOT EXISTS public.{t}" in sql
    assert "subtitle_path" in sql and "transcript" in sql and "end_sec" in sql
    assert "DROP POLICY IF EXISTS" in sql
    for k in ("'lecture_parse'", "'lecture_embed'", "'lecture_atom'"):
        assert k in sql
    assert sql.strip().startswith("-- D149") and "begin;" in sql and "commit;" in sql


def test_schema_mirrors_migration():
    sql = SCHEMA.read_text(encoding="utf-8")
    for t in ("lecture_packages", "lecture_videos", "lecture_clips",
              "lecture_clip_atoms", "class_lecture_packages"):
        assert f"public.{t}" in sql
    for k in ("'lecture_parse'", "'lecture_embed'", "'lecture_atom'"):
        assert k in sql


def test_migration_adds_clip_to_canvas_items_kind():
    """D149: 기 기동 DB의 canvas_items CHECK를 'clip' 포함으로 갱신(멱등)."""
    sql = MIG.read_text(encoding="utf-8")
    assert "canvas_items_kind_check" in sql
    assert "DROP CONSTRAINT IF EXISTS canvas_items_kind_check" in sql
    assert "'clip'" in sql


def test_schema_canvas_items_kind_allows_clip():
    """신규 볼륨 기동 경로(01_schema.sql)도 'clip'을 허용한다."""
    sql = SCHEMA.read_text(encoding="utf-8")
    check_line = next(
        line for line in sql.splitlines()
        if "kind" in line and "CHECK (kind IN" in line
    )
    assert "'clip'" in check_line
