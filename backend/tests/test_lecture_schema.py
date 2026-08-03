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
