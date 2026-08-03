"""자막 파서 (D149, 개정 R1) — SRT/VTT/SMI → 큐, 구간 슬라이스.

클립 경계는 EBS 챕터가 정하고, 이 파서는 그 구간의 본문 컨텍스트만 만든다.
무의존성(stdlib re/html.parser). 어떤 형식 실패도 빈 리스트로 강등한다.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser

logger = logging.getLogger("nodi.subtitle_parse")

# SRT/VTT 타임코드: 00:00:12,000 또는 00:00:12.000 (시간 생략 가능)
_TS = r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_RANGE_RE = re.compile(_TS + r"\s*-->\s*" + _TS)
_SYNC_RE = re.compile(r"<SYNC\s+Start\s*=\s*(\d+)", re.IGNORECASE)


@dataclass
class Cue:
    start_ms: int
    end_ms: int
    text: str


def _to_ms(h: str | None, m: str, s: str, frac: str) -> int:
    ms = int((frac + "000")[:3])
    return ((int(h or 0) * 3600) + int(m) * 60 + int(s)) * 1000 + ms


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)          # 태그 제거
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", text).strip()


def _parse_srt_vtt(raw: str) -> list[Cue]:
    cues: list[Cue] = []
    blocks = re.split(r"\n\s*\n", raw.replace("\r\n", "\n").replace("﻿", ""))
    for block in blocks:
        m = _RANGE_RE.search(block)
        if not m:
            continue
        start = _to_ms(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _to_ms(m.group(5), m.group(6), m.group(7), m.group(8))
        text = _clean(block[m.end():])
        if text:
            cues.append(Cue(start, end, text))
    return cues


class _SmiParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.syncs: list[tuple[int, list[str]]] = []
        self._cur: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "sync":
            start = dict((k.lower(), v) for k, v in attrs).get("start")
            if start and start.isdigit():
                self._cur = []
                self.syncs.append((int(start), self._cur))

    def handle_data(self, data: str) -> None:
        if self._cur is not None:
            s = data.strip()
            if s:
                self._cur.append(s)


def _parse_smi(raw: str) -> list[Cue]:
    p = _SmiParser()
    p.feed(raw)
    cues: list[Cue] = []
    syncs = p.syncs
    for i, (start, parts) in enumerate(syncs):
        text = _clean(" ".join(parts))
        end = syncs[i + 1][0] if i + 1 < len(syncs) else start + 5000
        if text:
            cues.append(Cue(start, end, text))
    return cues


def parse_subtitle(data: bytes, filename: str) -> list[Cue]:
    """SRT/VTT/SMI 자막 → 큐. 실패는 빈 리스트."""
    try:
        raw = data.decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        return []
    name = (filename or "").lower()
    try:
        if name.endswith(".smi") or "<sync" in raw[:2000].lower():
            return _parse_smi(raw)
        return _parse_srt_vtt(raw)     # .srt / .vtt 공통(VTT는 WEBVTT 헤더만 다름)
    except Exception:  # noqa: BLE001
        logger.warning("자막 파싱 예외 — 빈 큐", exc_info=True)
        return []


def transcript_for(cues: list[Cue], start_sec: int, end_sec: int | None) -> str:
    """[start_sec, end_sec) 구간에 시작하는 큐 텍스트를 순서대로 이어붙인다.
    end_sec=None이면 start_sec 이후 전부."""
    lo = start_sec * 1000
    hi = end_sec * 1000 if end_sec is not None else None
    picked = [c.text for c in cues if c.start_ms >= lo and (hi is None or c.start_ms < hi)]
    return " ".join(picked).strip()
