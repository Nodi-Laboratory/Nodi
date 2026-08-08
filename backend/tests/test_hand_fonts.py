"""손글씨 폰트 관리의 순수 부분 (D210 8-1).

경로 조각 만들기·지표 실측·서브셋은 네트워크도 DB도 없이 돌므로 여기서
지킨다. 나머지(업로드·적용·서빙)는 실물 경로가 있어야 의미가 있다.
"""

from pathlib import Path

import pytest

from app.services import hand_fonts as hf

FONT = (
    Path(__file__).resolve().parents[2]
    / "frontend/public/fonts/kcc-hanbit-ks.woff2"
)
LATIN = (
    Path(__file__).resolve().parents[2]
    / "frontend/public/fonts/kcc-hanbit-latin.woff2"
)


class TestSlug:
    def test_영문_라벨은_그대로_눕는다(self):
        assert hf.make_slug("Hanbit Script", "abcd1234") == "hanbit-script"

    def test_한글_라벨은_되돌아갈_글자가_없다(self):
        """경로에 쓸 수 있는 글자가 하나도 안 남는다 — 빈 slug면 디렉터리가 겹친다."""
        assert hf.make_slug("손글씨", "abcd1234") == "font-abcd1234"

    def test_경로를_벗어날_글자는_안_남는다(self):
        """`..`나 `/`가 남으면 저장소를 걸어 다니는 경로가 만들어진다."""
        slug = hf.make_slug("../../etc/passwd", "abcd1234")
        assert "/" not in slug and ".." not in slug

    def test_길이를_자른다(self):
        assert len(hf.make_slug("a" * 200, "x")) <= 40


class TestExt:
    @pytest.mark.parametrize("name", ["a.woff2", "A.WOFF2", "b.ttf", "c.otf"])
    def test_받는_형식(self, name):
        assert hf._ext_of(name, None) in hf.ALLOWED_EXT

    def test_확장자가_없으면_mime을_본다(self):
        assert hf._ext_of("noext", "font/woff2") == "woff2"

    def test_모르는_형식은_빈_문자열(self):
        """브라우저가 못 읽는 것을 받아 두면 '올렸는데 안 나온다'가 된다."""
        assert hf._ext_of("a.zip", "application/zip") == ""


class TestMeasure:
    def test_깨진_바이트는_기본값을_준다(self):
        """못 쟀다고 업로드를 막으면 기능 자체가 사라진다."""
        out = hf.measure(b"not a font at all")
        assert out["size_scale"] == 1.0
        assert out["letter_spacing"] == 0.09

    @pytest.mark.skipif(not FONT.exists(), reason="폰트 파일이 없다")
    def test_실물_폰트는_지금_화면과_같은_배율을_낸다(self):
        """KCC 한빛체를 재면 지금 쓰는 보정(0.744)이 나와야 한다.

        이 값이 다르면 공식이 틀린 것이다 — 새 폰트에서만 확인하면 무엇과
        견주는지 알 수 없다. **알고 있는 답이 있는 입력**으로 잰다.
        """
        out = hf.measure(FONT.read_bytes())
        assert 0.70 <= out["size_scale"] <= 0.79, out

    def test_배율은_상한_안에_있다(self):
        """읽을 수 없는 크기가 나오면 화면이 통째로 망가진다."""
        out = hf.measure(b"")
        assert 0.6 <= out["size_scale"] <= 1.6


class TestSubset:
    def test_깨진_바이트는_통짜_그대로(self):
        """쪼개지 못한 것을 조용히 쪼갠 척하면 교실에서 느려지는 이유를 아무도 모른다."""
        data = b"broken"
        out, did = hf.subset_bytes(data)
        assert out == data and did is False

    @pytest.mark.skipif(not LATIN.exists(), reason="폰트 파일이 없다")
    def test_필요없는_글자는_덜어낸다(self):
        """라틴 조각에는 안 쓰는 기호가 잔뜩 들어 있다 — 실측 92,616 → 8,332."""
        data = LATIN.read_bytes()
        out, did = hf.subset_bytes(data)
        assert did is True
        assert len(out) < len(data)

    @pytest.mark.skipif(not FONT.exists(), reason="폰트 파일이 없다")
    def test_이미_가벼우면_그대로_두되_실패라고_하지_않는다(self):
        """`subset`은 "작아졌나"가 아니라 "쪼개기가 돌았나"다.

        이미 서브셋된 폰트는 남길 글자가 그대로라 다시 쪼개도 안 줄어든다
        (실측 2026-08-08: 105,604 → 105,604). 거기에 "쪼개지 못했다"를 띄우면
        **멀쩡한 폰트에 경고가 뜬다.**
        """
        data = FONT.read_bytes()
        out, did = hf.subset_bytes(data)
        assert did is True
        assert len(out) <= len(data)

    @pytest.mark.skipif(not FONT.exists(), reason="폰트 파일이 없다")
    def test_한글이_남아_있다(self):
        """교실 한국어가 안 남으면 학생 글자가 통째로 안 보인다."""
        import io

        from fontTools.ttLib import TTFont

        out, _ = hf.subset_bytes(FONT.read_bytes())
        cmap = TTFont(io.BytesIO(out), fontNumber=0).getBestCmap()
        for ch in "판구조론지진화산":
            assert ord(ch) in cmap, ch

    @pytest.mark.skipif(not LATIN.exists(), reason="폰트 파일이 없다")
    def test_라틴과_숫자도_남는다(self):
        """한글만 보면 라틴이 폴백으로 떨어지는 것을 못 잡는다(미리보기 문장과 같은 이유)."""
        import io

        from fontTools.ttLib import TTFont

        out, _ = hf.subset_bytes(LATIN.read_bytes())
        cmap = TTFont(io.BytesIO(out), fontNumber=0).getBestCmap()
        assert ord("A") in cmap and ord("z") in cmap and ord("0") in cmap
