from pathlib import Path

from app.services.subtitle_parse import Cue, parse_subtitle, transcript_for

FIX = Path(__file__).parent / "fixtures"

def test_parse_srt():
    cues = parse_subtitle((FIX / "sample.srt").read_bytes(), "sample.srt")
    assert cues[0].start_ms == 12000 and "전시과" in cues[0].text
    assert cues[1].start_ms == 896000

def test_parse_smi_end_is_next_sync():
    cues = parse_subtitle((FIX / "sample.smi").read_bytes(), "sample.smi")
    # &nbsp; 빈 큐는 버리고, end_ms는 다음 SYNC 시작
    texts = [c.text for c in cues]
    assert any("전시과는 관리에게" in t for t in texts)
    assert cues[0].end_ms == 15000

def test_transcript_for_slices_by_range():
    cues = [Cue(12000, 15000, "A"), Cue(896000, 930000, "B고려"), Cue(1318000, 1350000, "C")]
    out = transcript_for(cues, 896, 1318)   # [896s, 1318s)
    assert "B고려" in out and "C" not in out and "A" not in out

def test_empty_when_no_cues_in_range():
    assert transcript_for([Cue(0, 1000, "x")], 896, 1318) == ""
