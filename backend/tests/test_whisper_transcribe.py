"""whisper_transcribe 단위 — ffmpeg/모델은 mock(실 전사는 E2E에서)."""
from unittest.mock import MagicMock, patch

from app.services import whisper_transcribe
from app.services.subtitle_parse import Cue


def test_transcribe_media_maps_segments_to_cues_ms():
    def seg(s, e, t):
        return MagicMock(start=s, end=e, text=t)
    model = MagicMock()
    model.transcribe.return_value = (
        [seg(0.0, 2.5, " 안녕 "), seg(2.5, 5.0, ""), seg(5.0, 8.0, "전시과")],
        MagicMock(),
    )
    with patch.object(whisper_transcribe, "_extract_audio"), \
         patch.object(whisper_transcribe, "_get_model", return_value=model):
        cues = whisper_transcribe.transcribe_media("http://x/v.mp4")
    assert cues == [Cue(0, 2500, "안녕"), Cue(5000, 8000, "전시과")]  # 빈 세그먼트 제외, ms 변환
