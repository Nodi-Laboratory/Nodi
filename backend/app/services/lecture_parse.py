"""EBS 강의 플레이어 페이지 파싱 (D149).

EBS는 챕터 목차를 초기 HTML에 서버렌더한다 — 각 항목의 onclick에
`player.Command.seek(<초>)`, 텍스트에 `[MM:SS] 제목`. 무의존성(stdlib html.parser)
으로 (시작초, 제목)만 뽑는다. 딥링크 seek은 하지 않으므로 MP4·헤드리스 불필요.
영상 제목(강의명)은 admin이 입력한다 — 여기서는 챕터만 다룬다.

EBS HTML 구조 변화에 대비해 파싱을 이 파일에 격리한다. 어떤 파싱 실패도
빈 리스트/failed로 떨어지고 추측하지 않는다.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from html.parser import HTMLParser

import httpx

from ..config import get_settings

logger = logging.getLogger("nodi.lecture_parse")
settings = get_settings()

_SEEK_RE = re.compile(r"player\.Command\.seek\((\d+)\)")
# MP4 URL은 플레이어 HTML에 노출된다 — 호스트 표기가 대문자 `WSTR`이라 대소문자
# 무시로 잡는다(개정 R2, 자동 전사용 오디오 소스). 로그인·헤드리스 불필요.
_MEDIA_RE = re.compile(r"https?://[^\"'\s]*wstr\.ebsi\.co\.kr/[^\"'\s]+\.mp4", re.IGNORECASE)
_LABEL_RE = re.compile(r"^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*")
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")


@dataclass
class LectureChapter:
    start_sec: int
    title: str


class _ChapterParser(HTMLParser):
    """onclick에 seek(N)이 있는 요소를 만나면 그 요소가 닫힐 때까지 텍스트를 모은다."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[tuple[int, str]] = []
        self._tag: str | None = None
        self._depth = 0
        self._sec: int | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._tag is not None:
            if tag == self._tag:
                self._depth += 1
            return
        onclick = dict(attrs).get("onclick") or ""
        m = _SEEK_RE.search(onclick)
        if m:
            self._tag, self._depth, self._sec, self._buf = tag, 1, int(m.group(1)), []

    def handle_endtag(self, tag: str) -> None:
        if self._tag is None or tag != self._tag:
            return
        self._depth -= 1
        if self._depth == 0:
            title = _LABEL_RE.sub("", " ".join(self._buf).strip()).strip()
            if self._sec is not None:
                self.rows.append((self._sec, title))
            self._tag, self._sec, self._buf = None, None, []

    def handle_data(self, data: str) -> None:
        if self._tag is not None:
            s = data.strip()
            if s:
                self._buf.append(s)


def parse_ebs_player(html: str) -> list[LectureChapter]:
    """(시작초, 제목) 챕터 목록. start_sec 기준 정렬 + 중복 제거, 빈 제목 제외."""
    p = _ChapterParser()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - 깨진 HTML도 빈 결과로 강등
        logger.warning("EBS HTML 파싱 예외 — 빈 챕터", exc_info=True)
        return []
    seen: set[int] = set()
    out: list[LectureChapter] = []
    for sec, title in sorted(p.rows, key=lambda r: r[0]):
        if sec in seen or not title:
            continue
        seen.add(sec)
        out.append(LectureChapter(start_sec=sec, title=title[:300]))
    return out


def extract_media_url(html: str) -> str | None:
    """플레이어 HTML에서 EBS MP4 URL을 뽑는다(자동 전사 오디오 소스). 없으면 None."""
    m = _MEDIA_RE.search(html or "")
    return m.group(0) if m else None


def fmt_timeline(sec: int) -> str:
    """초 → 사람이 읽는 타임라인. 1시간 미만은 M:SS, 이상은 H:MM:SS."""
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


async def fetch_ebs_html(url: str) -> str:
    """EBS 플레이어 페이지 GET(브라우저 UA). 챕터는 초기 HTML에 있어 헤드리스 불필요.

    프로덕션 서버 IP가 EBS WAF에 막힐 수 있다(로컬은 통과 확인). 막히면 예외로
    떨어지고 호출부(워커)가 video status='failed'로 격리한다.
    """
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True,
                                 headers={"User-Agent": _UA}) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.text
