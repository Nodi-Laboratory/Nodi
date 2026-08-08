"""캔버스 손글씨 폰트 빌드 — TTF → woff2 3조각 + @font-face CSS (D164).

    uv run --no-project --with "fonttools[woff]" python scripts/build-hand-font.py \
        KCC-Hanbit.otf public/fonts src/components/canvas2/hand-font.css \
        --family "KCC Hanbit" --slug kcc-hanbit

폰트 이름과 파일 접두사를 **인자로 받는다** (D210 3-3). 예전에는 코드에 박혀
있었는데, 폰트를 갈아 끼울 때마다 스크립트를 고쳐야 했다 — 그러면 "무엇으로
만든 조각인가"가 파일명과 어긋나기 시작한다.

생성된 CSS는 **CanvasStage가 임포트한다** — globals.css에 넣으면 unicode-range
목록(gzip 13KB)이 로그인·홈·관리자 화면까지 따라간다. 캔버스에만 쓰는 폰트이니
캔버스 라우트의 CSS 청크에만 있으면 된다(ExcalidrawLayer가 번들을 가두는 것과
같은 이유).

한 덩어리로 올리면(이 폰트는 woff2 단일 파일이 2.9MB) 캔버스를 여는 학생이
매번 그걸 받는다. 그래서 **브라우저가 실제로 그린 글자가 든 조각만** 받도록
unicode-range로 쪼갠다. Google Fonts가 한글에 하는 것과 같은 수법이고, D164에서
Gaegu를 next/font 대신 CDN `<link>`로 둔 이유도 이것이었다 — 자체 호스팅으로
옮기는 이상 그 쪼개기를 우리가 해야 한다.

  latin  한글 아닌 것 전부 (라틴·문장부호)          ~20KB
  ks     KS X 1001 완성형 한글 2,350자              ~500KB  ← 교실 한국어는 여기서 끝난다
  ext    나머지 음절 8,822자                        ~2.4MB  ← 희귀 음절이 나올 때만

unicode-range에는 **파일에 실제로 든 글자만** 적는다(cmap과 교집합). 없는 글자를
적어 두면 브라우저가 그 조각을 다 받고 나서야 폴백으로 떨어진다 — 가장 느린 길.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HANGUL = range(0xAC00, 0xD7A4)


def ks_x_1001() -> set[int]:
    """KS X 1001 완성형 한글(정확히 2,350자).

    euc-kr 코덱은 UHC 확장까지 받아 11,172자를 전부 통과시키므로 쓸 수 없다 —
    iso2022_kr이 표준 완성형 집합과 일치한다(실측: 2,350 / 8,822로 갈린다).
    """
    out = set()
    for cp in HANGUL:
        try:
            chr(cp).encode("iso2022_kr")
        except UnicodeEncodeError:
            continue
        out.add(cp)
    return out


def to_ranges(cps: list[int]) -> str:
    """정렬된 코드포인트 목록 → CSS unicode-range 문자열."""
    out: list[tuple[int, int]] = []
    start = prev = cps[0]
    for c in cps[1:]:
        if c == prev + 1:
            prev = c
            continue
        out.append((start, prev))
        start = prev = c
    out.append((start, prev))
    return ", ".join(f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in out)


def main() -> None:
    from fontTools.ttLib import TTFont

    args = sys.argv[1:]
    def opt(name: str, default: str) -> str:
        return args[args.index(name) + 1] if name in args else default

    src, font_dir, css_path = (Path(a) for a in args[:3])
    family = opt("--family", "Nanum YaGeunHaNeunGimJuIm")
    slug = opt("--slug", "nanum-yageun")
    note = opt("--note", family)
    cmap = set(TTFont(src).getBestCmap())
    ks = ks_x_1001()
    groups = {
        "latin": sorted(c for c in cmap if c not in HANGUL),
        "ks": sorted(c for c in cmap if c in ks),
        "ext": sorted(c for c in cmap if c in HANGUL and c not in ks),
    }

    font_dir.mkdir(parents=True, exist_ok=True)
    faces: list[tuple[str, str]] = []
    for name, cps in groups.items():
        dst = font_dir / f"{slug}-{name}.woff2"
        # ⚠️ 코드포인트를 **명령줄에 나열하면 안 된다.** 한글 조각은 2,350~8,822
        # 자라 Windows의 명령줄 상한(32KB)을 넘겨 `WinError 206`으로 죽는다.
        # fonttools가 파일로 받는 길을 열어 두었으니 그걸 쓴다.
        listing = font_dir / f".{slug}-{name}.unicodes"
        listing.write_text("\n".join(f"U+{c:04X}" for c in cps), encoding="utf-8")
        try:
            subprocess.run(
                [
                    "fonttools", "subset", str(src),
                    f"--unicodes-file={listing}",
                    "--layout-features=*",
                    "--flavor=woff2",
                    f"--output-file={dst}",
                ],
                check=True,
                capture_output=True,
            )
        finally:
            listing.unlink(missing_ok=True)
        print(f"{dst.name:26s} {len(cps):6,}자  {dst.stat().st_size / 1024:7,.0f} KB")
        faces.append((name, to_ranges(cps)))

    css = [
        "/* 자동 생성 — scripts/build-hand-font.py. 직접 고치지 말 것. */",
        f"/* {note} — 캔버스 전용(D164). */",
        "",
    ]
    for name, ranges in faces:
        css += [
            "@font-face {",
            f'  font-family: "{family}";',
            "  font-style: normal;",
            "  font-weight: 400;",
            "  font-display: swap;",
            f'  src: url("/fonts/{slug}-{name}.woff2") format("woff2");',
            f"  unicode-range: {ranges};",
            "}",
            "",
        ]
    css_path.write_text("\n".join(css), encoding="utf-8")
    print(f"→ {css_path}")


main()
