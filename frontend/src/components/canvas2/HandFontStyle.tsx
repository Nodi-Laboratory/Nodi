"use client";

/**
 * 관리자가 고른 손글씨 폰트를 캔버스에만 얹는다 (D210 8-1).
 *
 * ## 왜 캔버스에만인가
 *
 * 앱 전체를 갈아 끼우게 하면 관리자가 읽을 수 없는 폰트를 고르는 순간
 * **관리자 페이지 자신을 포함해** 전부 망가진다 — 되돌릴 화면도 같이
 * 망가지는 셈이다. 그래서 `.canvas2` 안에서만 `--font-hand`를 덮는다.
 * UI 크롬(`--font-ui`)·라벨(`--font-label`)은 손대지 않는다.
 *
 * ## 왜 `<style>`을 그리나
 *
 * `@font-face`는 CSS 규칙이라 인라인 style 속성으로는 못 만든다. 폰트가
 * 정해지는 시점이 런타임(서버가 알려 준다)이므로 규칙도 런타임에 만든다.
 * 활성 폰트가 없으면 **아무것도 그리지 않는다** — 저장소에 박힌 기본 폰트가
 * 그대로 돈다(`hand-font.css`).
 *
 * ## 보정값도 함께 온다
 *
 * 자간·크기 배율은 폰트마다 실측한 값이다(D164·D165). 코드에 고정해 두면 어떤
 * 폰트를 골라도 한 폰트에만 맞는다. `--hand-scale`은 크기를 **선언하는 자리**
 * (TextItem)가 곱해 쓴다 — 여기서 `font-size`를 주면 `text-[18px]` 같은 크기
 * 클래스를 통째로 덮어쓴다(D210 3-3에서 실제로 겪었다: 18px이 11.9px이 됐다).
 */

import { useClientSettings } from "@/lib/canvas2/useClientSettings";

/** 폰트 이름에 따옴표·역슬래시가 들어가면 규칙이 깨진다. 서버가 `nodi-<slug>`로 만들지만 한 번 더 막는다. */
function safeFamily(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
}

/** 주소는 우리 백엔드 경로만 받는다 — 남의 주소를 넣으면 외부로 요청이 나간다. */
function safeUrl(raw: string): string | null {
  return /^\/api\/hand-fonts\/[A-Za-z0-9-]+\/(web|full)$/.test(raw) ? raw : null;
}

export function HandFontStyle() {
  const settings = useClientSettings();
  const font = settings.handFont;
  if (!font) return null;
  const family = safeFamily(font.family);
  const url = safeUrl(font.url);
  if (!family || !url) return null;

  const css = `
@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("${url}") format("woff2");
}
.canvas2 {
  --font-hand: "${family}", "KCC Hanbit", "Bradley Hand", cursive, var(--font-sans);
  /* 기본 폰트의 배율(0.744)은 끈다 — sizeScale이 그 자리를 통째로 대신한다.
     둘을 곱하면 글씨가 0.55배가 되어 읽을 수 없다. */
  --hand-base: 1;
  --hand-scale: ${font.sizeScale};
}
.canvas2 .hand {
  letter-spacing: ${font.letterSpacing}em;
}
.canvas2 .c2-tune[data-tune="cjk"] {
  font-size: ${font.ideographScale}em;
}
`;
  return <style data-hand-font={family}>{css}</style>;
}
