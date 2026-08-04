from pathlib import Path

from app.config import get_settings
from app.services import admin_console


def test_config_defaults():
    s = get_settings()
    assert s.lecture_pipeline_enabled is True
    # 0.55 → 0.60 (D163). 청크·도판과 같은 게이트다 — 실측에서 관련 있는
    # 클립("측정 표준" 0.588)이 0.55에 걸려 떨어졌다.
    assert s.lecture_retrieve_max_distance == 0.60
    assert s.lecture_atom_enabled is True
    assert s.lecture_atom_max_distance == 0.45
    assert s.lecture_atoms_per_clip == 4
    assert s.lecture_atom_concurrency == 4
    assert s.lecture_atom_model == "solar-pro3"
    assert s.lecture_retrieve_top_k == 3
    assert s.lecture_batch_size == 16


def test_app_settings_seed_has_lecture_knobs():
    sql = (Path(__file__).resolve().parents[2] / "db/03_app_settings.sql").read_text(
        # 인코딩을 안 주면 OS 기본을 쓴다 — 한글 Windows(cp949)에서 UTF-8 SQL을
        # 읽다 UnicodeDecodeError로 죽는다. CI(리눅스)에서는 안 드러난다.
        encoding="utf-8"
    )
    for k in ("'lecture_pipeline_enabled'", "'lecture_retrieve_max_distance'",
              "'lecture_atom_enabled'", "'lecture_atom_max_distance'",
              "'lecture_atoms_per_clip'", "'lecture_atom_concurrency'"):
        assert k in sql


def test_admin_console_widgets_present():
    keys = {s["key"] for s in admin_console._SPECS}
    for k in ("lecture_pipeline_enabled", "lecture_retrieve_max_distance",
              "lecture_atom_enabled", "lecture_atom_max_distance",
              "lecture_atoms_per_clip", "lecture_atom_concurrency"):
        assert k in keys
