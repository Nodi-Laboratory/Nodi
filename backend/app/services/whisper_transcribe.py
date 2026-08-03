"""EBS 영상 오디오 → Whisper 자동 전사 (D149 개정 R2).

플레이어 HTML에 노출된 MP4 URL에서 ffmpeg로 16kHz mono 오디오를 뽑아
faster-whisper로 한국어 전사한다. 세그먼트를 `subtitle_parse.Cue`(절대 ms)로
반환하므로, 업로드 자막과 똑같이 `transcript_for`로 챕터 구간에 매핑된다.

- **동기·블로킹**이다(ffmpeg + Whisper). 호출부는 `asyncio.to_thread`로 돌리고,
  긴 전사 동안 스테일 판정을 피하려 별도 하트비트를 친다(worker/lectures.py).
- **ffmpeg는 시스템 의존성**(PATH에 있어야 함). faster-whisper는 파이썬 의존성.
- 어떤 실패든 예외로 던지고, 호출부가 격리한다(본문만 비고 파이프라인은 계속).
- 모델은 지연 로드 싱글턴(로딩이 비싸다). 기본 small/int8(cpu).
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from typing import Any

from ..config import get_settings
from .subtitle_parse import Cue

logger = logging.getLogger("nodi.whisper")
settings = get_settings()

_model: Any = None  # faster_whisper.WhisperModel 지연 싱글턴


def _get_model() -> Any:
    global _model
    if _model is None:
        from faster_whisper import WhisperModel  # 무거운 import — 최초 호출 때만

        _model = WhisperModel(
            settings.lecture_whisper_model, device="cpu", compute_type="int8"
        )
        logger.info("Whisper 모델 로드: %s (cpu/int8)", settings.lecture_whisper_model)
    return _model


def _extract_audio(media_url: str, dst_wav: str) -> None:
    """MP4 URL을 스트림해 16kHz mono wav로. -ss 없이 전체 → 타임스탬프가 절대값."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", media_url,
         "-vn", "-ar", "16000", "-ac", "1", dst_wav],
        check=True, capture_output=True,
        timeout=settings.lecture_whisper_ffmpeg_timeout_seconds,
    )


def transcribe_media(media_url: str, *, language: str | None = None) -> list[Cue]:
    """미디어 URL 전사 → Cue 목록(절대 타임스탬프 ms, 시작 순). 실패는 예외."""
    lang = language or settings.lecture_whisper_language
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        _extract_audio(media_url, wav)
        model = _get_model()
        # vad_filter: 무음 구간을 걸러 속도·정확도↑(onnxruntime 사용).
        segments, _info = model.transcribe(wav, language=lang, vad_filter=True)
        cues: list[Cue] = []
        for s in segments:  # 제너레이터 — 여기서 실제 전사가 진행된다
            text = (s.text or "").strip()
            if text:
                cues.append(Cue(int(s.start * 1000), int(s.end * 1000), text))
        logger.info("Whisper 전사: %d 세그먼트 (%s)", len(cues), media_url[:80])
        return cues
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass
