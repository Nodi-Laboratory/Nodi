import { expect, test, type Page } from "@playwright/test";
import { createNote, loginAndOpenCanvas, noteByText, openFreshSession } from "./helpers";

/**
 * D164 E2E — 손글씨 + "써지는" 애니메이션.
 *
 * 이 둘은 순수 함수 테스트로 잡히지 않는다. 폰트는 **실제로 내려받아 적용**돼야
 * 하고(스택에 이름만 적혀 있어도 폴백이면 손글씨가 아니다), 애니메이션은
 * 프레임을 실제로 흘려 봐야 "한 번에 붙었는지 / 한 글자씩 얹혔는지"가 갈린다.
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)이 떠 있어야 한다.
 * 스트리밍 검증은 진짜 LLM 턴을 태운다 — 백엔드에 대화 API 키가 필요하다
 * (`GET /health/config`의 `chat.configured`).
 */
test.describe.configure({ mode: "serial" });

/** 한 프레임씩 뜬 표본. 애니메이션 검증은 "시간에 따른 변화"가 전부다. */
interface Sample {
  t: number;
  /** 지금 써지는 글의 글자 수(없으면 화면 전체 글자 수). */
  len: number;
  /** 글자 단위 잉크 span 수. */
  ink: number;
  /** 펜촉이 떠 있나. */
  nib: number;
  /** 써지는 중인 글이 있나. */
  writing: number;
}

/** 살아 있는 잉크 span에서 실제로 읽은 CSS 애니메이션. */
interface InkStyle {
  name: string;
  duration: string;
  fill: string;
}

interface Recording {
  samples: Sample[];
  /** 녹화 중 처음 만난 잉크 span의 계산된 스타일. 못 만났으면 null. */
  ink: InkStyle | null;
}

/**
 * `ms` 동안 **매 프레임** 표본을 뜬다.
 *
 * 브라우저 안에서 rAF로 돈다 — Playwright에서 폴링하면 왕복 지연 때문에
 * 표본 간격이 100ms를 넘어 "한 글자씩"인지 "뭉텅"인지 구분할 수 없다.
 *
 * 길이는 **처음 잡은 글 하나**를 끝까지 따라가며 잰다. 매 프레임 셀렉터로
 * 다시 찾으면 대상이 도중에 바뀌어 측정 자체가 튄다 — 실측: 스트림이 끝나
 * `data-writing`이 사라지는 프레임에 585자가 한 번에 늘어난 것처럼 보였다
 * (실제로는 "써지는 글 하나" → "화면 전체 글"로 잣대가 바뀐 것이었다).
 */
async function record(page: Page, ms: number): Promise<Recording> {
  return page.evaluate(
    (limit) =>
      new Promise<Recording>((resolve) => {
        const samples: Sample[] = [];
        let ink: InkStyle | null = null;
        const t0 = performance.now();
        // 지금 써지는 글. 없으면(재수화 검증) 화면의 첫 글을 본다.
        const target =
          document.querySelector<HTMLElement>('[data-writing="1"]') ??
          document.querySelector<HTMLElement>("[data-item-text]");
        const tick = () => {
          const t = performance.now() - t0;
          const inkEls = document.querySelectorAll<HTMLElement>("[data-ink]");
          // 스타일은 **살아 있는 동안** 읽어야 한다. 녹화가 끝난 뒤 찾으면
          // 이미 다 써져서 span이 하나도 없다(실측: undefined가 나왔다).
          if (!ink && inkEls.length) {
            const s = getComputedStyle(inkEls[0]);
            ink = {
              name: s.animationName,
              duration: s.animationDuration,
              fill: s.animationFillMode,
            };
          }
          samples.push({
            t,
            len: (target?.textContent ?? "").length,
            ink: inkEls.length,
            nib: document.querySelectorAll("[data-nib]").length,
            writing: document.querySelectorAll('[data-writing="1"]').length,
          });
          if (t < limit) requestAnimationFrame(tick);
          else resolve({ samples, ink });
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/** 프레임 사이 글자 수 증가분(0 이하는 버린다 — 새 글로 갈아탄 프레임). */
function deltas(samples: readonly Sample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].len - samples[i - 1].len;
    if (d > 0) out.push(d);
  }
  return out;
}

/**
 * 캔버스 손글씨 폰트의 CSS family 이름.
 *
 * Gaegu → 나눔손글씨 야근하는 김주임(2026-08-04) → **KCC 한빛체**(D210 3-3)
 * 순으로 바뀌었다. 자체 호스팅이라 이름도 우리가 정한 값이다.
 *
 * ⚠️ 이 상수는 `components/canvas2/hand-font.css`의 `@font-face`와 **같아야
 * 한다.** 폰트를 바꾸면서 여기를 안 고쳐 이 스펙이 한동안 빨갰다 — 폰트 이름은
 * 코드 한 곳에서만 바꾸면 되는 값처럼 보이지만 실은 둘이다.
 */
const HAND_FAMILY = "KCC Hanbit";

test("캔버스 글씨는 손글씨 폰트로 실제 렌더된다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
  const NOTE = `손글씨가 적용되었는가-${Date.now()}`;
  await createNote(page, NOTE);
  const note = noteByText(page, NOTE);

  /**
   * ① 폰트가 브라우저에 실제로 로드됐나. 스택에 이름만 있고 파일이 없으면
   *    computed style은 여전히 그 이름이라서 이 확인이 없으면 무의미하다.
   *
   *    **글자를 지정해 `load`부터 부른다.** 이 폰트는 unicode-range로 세 조각
   *    (라틴 · KS X 1001 한글 · 나머지 음절)이라 `check`만 하면 "그 글자가 든
   *    조각을 아직 안 받았다"는 이유로 false가 나온다 — 화면에 뭐가 떠 있었는지에
   *    따라 결과가 갈리는 불안정한 검사가 된다(실측: 같은 테스트가 한 번은
   *    통과, 한 번은 실패).
   */
  const loaded = await page.evaluate(
    async ([family, text]) => {
      await document.fonts.load(`18px "${family}"`, text);
      await document.fonts.ready;
      return document.fonts.check(`18px "${family}"`, text);
    },
    [HAND_FAMILY, NOTE],
  );
  expect(loaded, `${HAND_FAMILY} 웹폰트가 로드되지 않았다`).toBe(true);

  // ② 그 폰트가 캔버스 본문에 **적용**돼 있나.
  const family = await note
    .locator("[data-item-text]")
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain(HAND_FAMILY);

  // ③ 실제로 그려질 때도 그 폰트가 쓰이나(폴백이 아닌가). **화면에 떠 있는
  //    바로 그 글**을 산세리프로도 재 보고 폭을 비교한다 — 폭이 같으면
  //    브라우저가 폴백으로 그린 것이다.
  const widths = await note.locator("[data-item-text]").evaluate((el, text) => {
    const probe = document.createElement("span");
    probe.textContent = text;
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:18px";
    document.body.appendChild(probe);
    probe.style.fontFamily = getComputedStyle(el).fontFamily;
    const hand = probe.getBoundingClientRect().width;
    probe.style.fontFamily = "sans-serif";
    const plain = probe.getBoundingClientRect().width;
    probe.remove();
    return { hand, plain };
  }, NOTE);
  expect(widths.hand).toBeGreaterThan(0);
  expect(
    Math.abs(widths.hand - widths.plain),
    `손글씨 폭(${widths.hand})이 산세리프 폭(${widths.plain})과 같다 — 폴백이다`,
  ).toBeGreaterThan(1);

  // ④ **앱의 나머지 화면으로 번지지 않았나** (D127의 근거는 아직 유효하다).
  const sidebarFamily = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(sidebarFamily).not.toContain(HAND_FAMILY);
});

test("AI 답이 한 글자씩 써진다 (잉크 애니메이션)", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  await page.getByLabel("질문 입력").fill("무지개가 생기는 이유를 알려줘");
  await page.getByLabel("보내기").click();

  // 첫 글자가 화면에 나올 때까지 기다린다(모델 지연은 우리 관심사가 아니다).
  await expect
    .poll(async () => page.locator("[data-ink]").count(), {
      timeout: 120_000,
      intervals: [150],
    })
    .toBeGreaterThan(0);

  const { samples, ink } = await record(page, 6_000);
  const grew = deltas(samples);
  const maxInk = Math.max(...samples.map((s) => s.ink));
  const sawNib = samples.some((s) => s.nib > 0);

  // ① 글이 자라는 프레임이 여러 번 있어야 한다. 한 번에 붙었다면 1~2번뿐이다.
  expect(grew.length, "글자 수가 늘어난 프레임이 너무 적다 — 뭉텅 붙었다").toBeGreaterThan(10);

  // ② 한 프레임에 얹히는 글자 수 — MAX_PER_FRAME(6)의 여유를 둔 상한.
  //    이걸 넘으면 "쓰는" 게 아니라 문단이 통째로 나타난 것이다.
  expect(Math.max(...grew), "한 프레임에 너무 많은 글자가 나타났다").toBeLessThanOrEqual(12);

  // ③ 잉크 애니메이션이 실제로 붙어 있어야 한다.
  expect(maxInk, "글자 단위 잉크 span이 하나도 없었다").toBeGreaterThan(3);
  //    동시에 애니메이션 중인 글자는 꼬리 창(INK_TAIL=96) 안이어야 한다 —
  //    넘으면 다 못 써진 글자가 완성 상태로 툭 튄다.
  expect(maxInk, "잉크 span이 꼬리 창을 넘었다").toBeLessThanOrEqual(96);
  expect(sawNib, "펜촉이 보이지 않았다").toBe(true);

  // ④ 그 span에 붙은 게 진짜 CSS 애니메이션인가.
  //    `both`가 아니면 애니메이션이 끝난 글자가 시작 상태(clip-path 100%)로
  //    되돌아가 **다 쓴 글이 사라진다.**
  expect(ink?.name).toBe("c2-ink");
  expect(ink?.fill).toBe("both");
  expect(parseFloat(ink?.duration ?? "0")).toBeGreaterThan(0);

  // ⑤ 다 쓰고 나면 잉크 span도 펜촉도 남지 않는다 — 마른 글로 돌아가야 한다.
  await expect
    .poll(async () => page.locator('[data-writing="1"]').count(), { timeout: 120_000 })
    .toBe(0);
  await expect(page.locator("[data-ink]")).toHaveCount(0);
  await expect(page.locator("[data-nib]")).toHaveCount(0);

  // ⑥ 다 써진 글은 온전해야 한다. 애니메이션이 마지막 꼬리를 삼키면
  //    안 된다(clip-path가 `both`로 남으면 정확히 그 사고가 난다).
  const finalLen = await page
    .locator("[data-item-text]")
    .first()
    .evaluate((el) => (el.textContent ?? "").length);
  expect(finalLen).toBeGreaterThan(20);
});

test("새로고침하면 다시 써지지 않는다 (재수화는 즉시 완성)", async ({ page }) => {
  await loginAndOpenCanvas(page);

  // 이미 답이 있는 세션을 다시 연다. 앞 테스트가 남긴 글이 그대로 있다.
  await expect(page.locator("[data-item-text]").first()).toBeVisible({ timeout: 30_000 });

  const { samples } = await record(page, 1_500);
  // 첫 프레임부터 글이 전부 있어야 한다 — 재수화가 타이핑을 다시 돌리면
  // 학생이 이미 읽은 글을 또 기다린다.
  expect(samples[0].len).toBeGreaterThan(0);
  expect(Math.max(...samples.map((s) => s.ink)), "재수화에서 잉크가 돌았다").toBe(0);
  expect(Math.max(...samples.map((s) => s.writing)), "재수화가 타이핑으로 취급됐다").toBe(0);
  expect(samples[samples.length - 1].len).toBe(samples[0].len);
});
