from pathlib import Path
from app.services.lecture_parse import parse_ebs_player, fmt_timeline, LectureChapter

FIX = Path(__file__).parent / "fixtures/ebs_player.html"

def test_parses_chapters_sorted_deduped():
    chapters = parse_ebs_player(FIX.read_text(encoding="utf-8"))
    assert [c.start_sec for c in chapters] == [365, 553, 896]     # 중복 896 제거, 정렬
    assert chapters[0].title == "[충모쌤 Pick & 꿀팁]"            # [MM:SS] 라벨 제거
    assert chapters[2].title == "03_고려의 토지 제도와 경제 생활"

def test_no_chapters_returns_empty():
    assert parse_ebs_player("<html><body>no chapters</body></html>") == []

def test_fmt_timeline():
    assert fmt_timeline(896) == "14:56"
    assert fmt_timeline(65) == "1:05"
    assert fmt_timeline(3723) == "1:02:03"


def test_extract_media_url_case_insensitive_wstr():
    from app.services.lecture_parse import extract_media_url
    html = 'var u = "https://WSTR.ebsi.co.kr/M45K2501/S1/S1_500K_100.mp4"; //...'
    assert extract_media_url(html) == "https://WSTR.ebsi.co.kr/M45K2501/S1/S1_500K_100.mp4"
    assert extract_media_url("<html>no media</html>") is None
