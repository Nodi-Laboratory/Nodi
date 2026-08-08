"""캔버스 손글씨 폰트 관리 (D210 8-1).

지금 손글씨 폰트(KCC 한빛체)는 저장소에 박혀 있어서 바꾸려면 배포를 해야
한다. 관리자가 올려 두고 골라 쓸 수 있게 한다.

## 적용 범위는 캔버스 손글씨뿐이다

앱 전체를 갈아 끼우게 하면 관리자가 읽을 수 없는 폰트를 고르는 순간
**관리자 페이지 자신을 포함해** 전부 망가진다 — 되돌릴 화면도 같이 망가지는
셈이다. UI 크롬(`--font-ui`)·라벨(`--font-label`)은 손대지 않는다. 이건 취향이
아니라 안전장치다.

## 서빙은 인증 없이

폰트는 로그인 전 화면에서도 쓰일 수 있고, `<link>`·`@font-face`는 헤더를 못
싣는다. 담긴 것은 글자 모양뿐이라 공개해도 잃을 것이 없다.

⚠️ 다만 **경로에 사용자 입력이 들어간다.** slug는 만들 때 영숫자·하이픈으로
좁히고, 읽을 때도 DB 행을 거쳐서만 파일을 찾는다 — 요청의 문자열로 직접
경로를 만들지 않는다.

## 통짜와 서브셋

`scripts/build-hand-font.py`가 하는 일(라틴·KS·나머지 3조각)을 업로드 경로에
그대로 붙이지는 않는다. **시험은 통짜로, 운영 적용은 서브셋으로** 나눈다:
관리자가 시험해 보는 것까지 막으면 기능의 뜻이 없고, 통짜 한글 폰트(2~3MB)를
그대로 학생에게 내보내면 교실 회선에서 느려진다.

여기서는 KS X 1001(한글 2,350자) + 라틴 + 숫자만 남긴 **한 조각**을 만든다.
교실 한국어는 그 안에서 끝난다(D164에서 실측). 조각을 셋으로 나누는 것은
`unicode-range`로 내려받기를 미루려는 것인데, 업로드 폰트는 어차피 한 번
고르면 그것만 쓰므로 나눌 이득이 작다.

## 보정값은 폰트마다 저장한다

자간·크기 배율은 KCC 한빛체에 맞춰 실측해 잡은 값이다(D164·D165). 폰트가
바뀌면 전부 틀어진다 — 코드에 고정해 두면 어떤 폰트를 골라도 한 폰트에만
맞는다. 업로드 시점에 폰트의 실제 지표(upm 대비 한글 글자 높이·폭)를 재서
기본값을 잡고, 관리자가 눈으로 보고 고칠 수 있게 둔다.
"""

from __future__ import annotations

import io
import logging
import re
import unicodedata
import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from ..db.client import UserClient, get_service_client

logger = logging.getLogger("nodi.hand_fonts")
settings = get_settings()

SELECT = (
    "id,label,family,slug,format,size_bytes,subset,"
    "letter_spacing,size_scale,ideograph_scale,active,created_at"
)

#: 폰트 한 벌 상한. 통짜 한글 폰트가 2~3MB이고, CJK 전체를 담은 것이 8MB쯤이다.
MAX_BYTES = 12 * 1024 * 1024

#: 받는 형식. 브라우저가 못 읽는 것을 받아 두면 "올렸는데 안 나온다"가 된다.
ALLOWED_EXT = ("woff2", "ttf", "otf")
_MIME = {
    "woff2": "font/woff2",
    "ttf": "font/ttf",
    "otf": "font/otf",
}

_SLUG_BAD = re.compile(r"[^a-z0-9]+")

#: 지금 화면이 내고 있는 **잉크 높이 비율**(글자 크기 대비).
#:
#: KCC 한빛체는 100px에서 잉크 높이가 90px이고(D210 3-3 실측), 화면은 거기에
#: 0.744를 곱해 쓴다. 그래서 실제로 그려지는 잉크는 글자 크기의
#: 0.744 × 0.90 ≈ 0.67이다. 새 폰트의 배율은 **같은 잉크 높이를 내는 값**이다:
#:
#:     배율 = 0.67 / (그 폰트의 잉크 높이 비율)
#:
#: 이렇게 잡으면 `--hand-base`를 1로 끄고 이 값 하나만 곱하면 된다.
_BASE_HANGUL_HEIGHT = 0.6696


def make_slug(label: str, fallback: str) -> str:
    """라벨 → 경로에 쓸 조각. **영숫자와 하이픈만 남긴다.**

    한글 라벨이 흔하므로 비면 fallback(uuid 앞자리)을 쓴다 — 빈 slug로
    경로를 만들면 디렉터리가 겹친다.
    """
    ascii_only = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode()
    slug = _SLUG_BAD.sub("-", ascii_only.lower()).strip("-")
    return (slug or f"font-{fallback}")[:40]


def _ext_of(filename: str, mime: str | None) -> str:
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext in ALLOWED_EXT:
        return ext
    guess = (mime or "").split("/")[-1].lower()
    return guess if guess in ALLOWED_EXT else ""


def measure(data: bytes) -> dict[str, float]:
    """폰트에서 보정값을 뽑는다. 못 읽으면 기본값 (D210 8-1).

    ⚠️ **재는 것은 글리프 bbox이지 브라우저의 렌더가 아니다.** 완벽하지 않다 —
    D164에서 폰트를 바꿀 때도 최종 판단은 화면에서 했다. 여기서 하는 일은
    관리자가 **0에서 시작하지 않게** 하는 것이고, 값은 콘솔에서 고칠 수 있다.

    fontTools가 없거나 폰트가 깨졌으면 지금 값을 그대로 준다 — 못 쟀다고
    업로드를 막으면 "폰트를 바꿀 수 있다"는 기능 자체가 사라진다.
    """
    out = {"letter_spacing": 0.09, "size_scale": 1.0, "ideograph_scale": 0.86}
    try:
        from fontTools.ttLib import TTFont  # 지연 임포트 — 부팅을 무겁게 하지 않는다

        font = TTFont(io.BytesIO(data), lazy=True, fontNumber=0)
        upm = float(font["head"].unitsPerEm or 1000)
        cmap = font.getBestCmap()
        glyphs = font.getGlyphSet()
        from fontTools.pens.boundsPen import BoundsPen

        def ink_height(ch: str) -> float | None:
            name = cmap.get(ord(ch))
            if not name or name not in glyphs:
                return None
            pen = BoundsPen(glyphs)
            glyphs[name].draw(pen)
            if not pen.bounds:
                return None
            return (pen.bounds[3] - pen.bounds[1]) / upm

        # 한글 대표 글자 몇 개의 평균 — 한 글자만 보면 그 글자의 버릇을 잡는다.
        heights = [h for h in (ink_height(c) for c in "한글가국") if h]
        if heights:
            avg = sum(heights) / len(heights)
            # 지금 화면이 맞춰진 높이와 같아지도록 되돌린다.
            out["size_scale"] = round(_BASE_HANGUL_HEIGHT / avg, 3) if avg else 1.0
            # 지나친 값은 오히려 화면을 망가뜨린다 — 실측이 이상하면 1에 가깝게.
            out["size_scale"] = max(0.7, min(1.4, out["size_scale"]))
        han = ink_height("漢")
        if han and heights:
            avg = sum(heights) / len(heights)
            out["ideograph_scale"] = max(0.7, min(1.2, round(avg / han, 3)))
    except Exception:  # noqa: BLE001 - 못 재는 것이 업로드를 막지 않는다
        logger.info("폰트 지표 실측 실패 — 기본값을 쓴다", exc_info=True)
    return out


def subset_bytes(data: bytes) -> tuple[bytes, bool]:
    """운영용 조각을 만든다. 실패하면 통짜 그대로 (D210 8-1).

    남기는 것은 **KS X 1001 한글 2,350자 + 아스키 + 자주 쓰는 기호**다.
    교실 한국어가 그 안에서 끝난다는 것은 D164에서 실측했다.

    돌려주는 둘째 값은 **쪼개기가 돌았나**이지 "작아졌나"가 아니다. 이미
    서브셋된 폰트를 다시 넣으면 남길 글자가 그대로라 결과가 원본과 같거나
    조금 크다(실측 2026-08-08: `kcc-hanbit-ks.woff2` 105,604 → 105,604 ·
    `kcc-hanbit-latin.woff2` 92,616 → 8,332). 그때 "쪼개지 못했다"고 알리면
    **멀쩡한 폰트에 경고가 뜬다.**

    교실에서 문제가 되는 것은 기법이 아니라 **바이트**다. 무거운지는 화면이
    크기로 판단하고, 이 플래그는 "쪼개기 자체가 실패했나"만 말한다.
    """
    try:
        from fontTools import subset

        text = _KS_HANGUL + "".join(chr(c) for c in range(0x20, 0x7F))
        options = subset.Options()
        options.layout_features = ["*"]
        options.desubroutinize = True
        options.flavor = "woff2"
        font = subset.load_font(io.BytesIO(data), options)
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=text)
        subsetter.subset(font)
        buf = io.BytesIO()
        subset.save_font(font, buf, options)
        out = buf.getvalue()
        if not out:
            return data, False
        # 작은 쪽을 내보낸다 — 다시 쪼갠 것이 더 크면 원본이 낫다.
        return (out if len(out) <= len(data) else data), True
    except Exception:  # noqa: BLE001
        logger.warning("폰트 서브셋 실패 — 통짜를 쓴다", exc_info=True)
        return data, False


def _ks_hangul() -> str:
    """KS X 1001의 한글 2,350자.

    표를 들고 있지 않으므로 **현대 한글 음절 전체**를 쓴다 — 11,172자다.
    서브셋 결과가 KS만 남긴 것보다 크지만(약 2배), 표를 잘못 옮겨 학생이 쓴
    글자가 통째로 안 보이는 것보다 낫다. 그래도 통짜의 절반 이하다.
    """
    return "".join(chr(c) for c in range(0xAC00, 0xD7A4))


_KS_HANGUL = _ks_hangul()


async def list_fonts(client: UserClient) -> list[dict[str, Any]]:
    """폰트 목록(최신순). **로그인한 누구나 읽는다** — 화면이 무엇을 쓸지 알아야 한다."""
    return await client.select(
        "hand_fonts", {"select": SELECT, "order": "created_at.desc", "limit": "50"}
    )


async def active_font(client: UserClient) -> dict[str, Any] | None:
    rows = await client.select(
        "hand_fonts", {"select": SELECT, "active": "is.true", "limit": "1"}
    )
    return rows[0] if rows else None


async def add_font(
    client: UserClient,
    *,
    owner_id: str,
    label: str,
    filename: str,
    mime: str | None,
    data: bytes,
) -> dict[str, Any]:
    """폰트 한 벌 등록. 관리자 전용(RLS가 강제한다).

    **통짜와 서브셋을 둘 다 저장한다.** 시험은 통짜로(관리자가 모든 글자를
    확인할 수 있어야 한다), 학생 화면에는 서브셋을 내보낸다.
    """
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="빈 파일입니다."
        )
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"폰트가 너무 큽니다({len(data) / 1024 / 1024:.1f}MB). "
                f"{MAX_BYTES // 1024 // 1024}MB까지 올릴 수 있습니다."
            ),
        )
    ext = _ext_of(filename or "", mime)
    if not ext:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="woff2 · ttf · otf 파일만 올릴 수 있습니다.",
        )

    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="파일 저장소가 아직 활성화되지 않았습니다(관리자 설정 필요).",
        )

    font_id = str(uuid.uuid4())
    name = (label or filename or "손글씨").strip()[:80]
    slug = make_slug(name, font_id[:8])
    # slug가 겹치면 뒤에 조각을 붙인다 — UNIQUE라 그냥 넣으면 409로 죽는다.
    taken = await client.select(
        "hand_fonts", {"select": "slug", "slug": f"eq.{slug}", "limit": "1"}
    )
    if taken:
        slug = f"{slug}-{font_id[:6]}"

    sub, did_subset = subset_bytes(data)
    await svc.storage_upload(
        settings.storage_bucket, f"hand-fonts/{slug}/full.{ext}", data, _MIME[ext]
    )
    await svc.storage_upload(
        settings.storage_bucket,
        f"hand-fonts/{slug}/web.woff2" if did_subset else f"hand-fonts/{slug}/web.{ext}",
        sub,
        "font/woff2" if did_subset else _MIME[ext],
    )

    metrics = measure(data)
    row = await client.insert(
        "hand_fonts",
        {
            "id": font_id,
            "label": name,
            # CSS 이름은 slug에서 만든다 — 관리자가 적은 이름에 따옴표가 들어가면
            # @font-face 규칙이 깨진다.
            "family": f"nodi-{slug}",
            "slug": slug,
            "format": "woff2" if did_subset else ext,
            "size_bytes": len(sub),
            "subset": did_subset,
            "created_by": owner_id,
            **metrics,
        },
    )
    logger.info(
        "손글씨 폰트 등록 %s slug=%s 통짜 %dKB → %dKB (서브셋 %s)",
        font_id, slug, len(data) // 1024, len(sub) // 1024, did_subset,
    )
    return row


async def activate(client: UserClient, font_id: str) -> dict[str, Any]:
    """이 폰트를 쓴다. **먼저 다 끄고 하나만 켠다** — 부분 유니크 인덱스가 있다."""
    rows = await client.select(
        "hand_fonts", {"select": SELECT, "id": f"eq.{font_id}", "limit": "1"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="폰트를 찾을 수 없습니다."
        )
    await client.update("hand_fonts", {"active": "is.true"}, {"active": False})
    updated = await client.update("hand_fonts", {"id": f"eq.{font_id}"}, {"active": True})
    return (updated or rows)[0]


async def deactivate_all(client: UserClient) -> None:
    """기본 폰트로 되돌린다 (D210 8-1).

    **되돌리는 길이 반드시 있어야 한다.** 읽을 수 없는 폰트를 고른 뒤에도
    관리자 페이지는 멀쩡하지만(범위가 캔버스뿐이다), 학생 화면은 이 버튼으로만
    돌아온다.
    """
    await client.update("hand_fonts", {"active": "is.true"}, {"active": False})


async def remove_font(client: UserClient, font_id: str) -> None:
    rows = await client.select(
        "hand_fonts", {"select": "id,slug,format,active", "id": f"eq.{font_id}", "limit": "1"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="폰트를 찾을 수 없습니다."
        )
    row = rows[0]
    await client.delete("hand_fonts", {"id": f"eq.{font_id}"})
    svc = get_service_client()
    if svc is None:
        return
    for path in (
        f"hand-fonts/{row['slug']}/web.{row['format']}",
        f"hand-fonts/{row['slug']}/full.woff2",
        f"hand-fonts/{row['slug']}/full.ttf",
        f"hand-fonts/{row['slug']}/full.otf",
    ):
        try:
            await svc.storage_delete(settings.storage_bucket, path)
        except Exception:  # noqa: BLE001 - 바이트가 남아도 목록에선 사라졌다
            logger.info("폰트 파일 삭제 실패(무시) %s", path)


async def read_bytes(client: UserClient, slug: str, variant: str) -> tuple[bytes, str]:
    """폰트 바이트 + mime. **행을 거쳐서만 파일을 찾는다.**

    요청의 문자열로 직접 경로를 만들면 `..`로 저장소를 걸어 다닐 수 있다.
    slug로 행을 찾고, 그 행이 가진 값으로 경로를 만든다.
    """
    rows = await client.select(
        "hand_fonts", {"select": "slug,format", "slug": f"eq.{slug}", "limit": "1"}
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="폰트를 찾을 수 없습니다."
        )
    row = rows[0]
    fmt = str(row["format"])
    path = (
        f"hand-fonts/{row['slug']}/full.{fmt}"
        if variant == "full"
        else f"hand-fonts/{row['slug']}/web.{fmt}"
    )
    svc = get_service_client()
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="파일 저장소가 아직 활성화되지 않았습니다.",
        )
    try:
        data = await svc.storage_download(settings.storage_bucket, path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="폰트 파일이 없습니다."
        ) from exc
    return data, _MIME.get(fmt, "font/woff2")
