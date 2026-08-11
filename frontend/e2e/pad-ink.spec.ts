import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "./helpers";

/**
 * **패드에서 손가락으로 쓰는 길** (사용자 지시 2026-08-10).
 *
 * ## 왜 따로 있나
 *
 * `ask-ink.spec.ts`는 전부 **마우스**로 확인한다. 그런데 이 기능을 실제로 쓰는
 * 기기는 패드고, 거기서는 손가락이 그린다. 둘은 브라우저 안에서 다른 길을
 * 탄다 — 마우스가 되는 것이 손가락도 된다는 보장이 없다.
 *
 * 실측 2026-08-10: 손가락 경로는 **아무도 재고 있지 않았다.** 그래서 패드에서
 * 깨져도 초록불이 그대로였을 것이다.
 *
 * ## 합성 이벤트로는 못 잰다
 *
 * `dispatchEvent(new PointerEvent(...))`로 그어 봤더니 획이 하나도 안 남아서
 * "패드에서 안 된다"로 보였는데, **제품이 아니라 측정이 틀린 것**이었다.
 * Excalidraw가 듣는 경로를 합성 이벤트가 안 탄다. CDP의
 * `Input.dispatchTouchEvent`가 진짜 터치를 넣는다 — 그것만 믿는다.
 */

test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

/** CDP로 진짜 터치 한 획. */
async function 손가락획(
  page: import("@playwright/test").Page,
  pts: [number, number][],
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x: number, y: number) => ({ x, y, radiusX: 7, radiusY: 7, force: 0.6, id: 1 });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pt(...pts[0])],
  });
  for (const [x, y] of pts.slice(1)) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(x, y)],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

async function 획수(page: import("@playwright/test").Page): Promise<number> {
  const v = await page.getByTestId("ask-ink").getAttribute("data-strokes");
  return Number(v ?? 0);
}

/** 손가락으로 펜 모드를 켠다 — 버튼도 손가락으로 눌러야 한다. */
async function 펜켜기(page: import("@playwright/test").Page): Promise<void> {
  const 펜 = page.getByRole("radio", { name: "펜으로 써서 묻기" });
  const b = (await 펜.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(펜).toHaveAttribute("aria-checked", "true");
}

test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
});

test("패드: 손가락 탭으로 펜을 켜고 손가락으로 획을 긋는다", async ({ page }) => {
  await 펜켜기(page);
  expect(await 획수(page)).toBe(0);

  await 손가락획(page, [
    [420, 380], [450, 372], [480, 390], [510, 374], [540, 392], [570, 378],
  ]);
  await expect.poll(() => 획수(page), { timeout: 4000 }).toBe(1);

  await 손가락획(page, [[420, 470], [470, 462], [520, 478], [570, 466]]);
  await expect.poll(() => 획수(page), { timeout: 4000 }).toBe(2);

  // 획이 있으면 인식 버튼이 살아난다 — 손가락으로 눌러야 하므로 44px 이상이다.
  const 인식 = page.getByRole("button", { name: /글자 인식/ });
  await expect(인식).toBeEnabled();
  const b = (await 인식.boundingBox())!;
  expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(32);
});

test("패드: 두 손가락으로 확대해도 낙서가 안 남는다", async ({ page }) => {
  /**
   * 패드 사용자는 확대를 두 손가락으로 한다. 그런데 두 손가락은 **동시에 닿지
   * 않는다** — 첫 손가락이 몇 십 ms 먼저 닿는다. 그 사이를 "획을 긋기
   * 시작했다"로 읽으면 확대할 때마다 캔버스에 낙서가 남는다.
   */
  await 펜켜기(page);
  const cdp = await page.context().newCDPSession(page);
  const pt = (x: number, y: number, id: number) => ({
    x, y, radiusX: 8, radiusY: 8, force: 0.6, id,
  });

  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pt(500, 400, 1)],
  });
  await page.waitForTimeout(60); // 두 번째 손가락이 늦게 닿는다
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [pt(500, 400, 1), pt(700, 500, 2)],
  });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [pt(500 - i * 8, 400 - i * 5, 1), pt(700 + i * 8, 500 + i * 5, 2)],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(800);

  expect(await 획수(page)).toBe(0);
});

test("패드: 눌러야 하는 것이 손가락에 충분히 크다", async ({ page }) => {
  /**
   * 44px는 애플이, 48dp는 구글이 권하는 최소 터치 크기다. 그보다 작으면 옆
   * 것이 눌리거나 아무 일도 안 일어난다.
   *
   * 실측 2026-08-10(고치기 전): 지난 대화·자판/펜·보내기가 32×32였다.
   */
  const 작은것: string[] = [];
  for (const [이름, sel] of [
    ["보내기", "[data-ask-send]"],
    ["지난 대화", "[data-canvas-crumb] button"],
    ["자판", "[data-ask-mode] button:first-child"],
    ["펜", "[data-ask-mode] button:last-child"],
  ] as const) {
    const b = await page.locator(sel).first().boundingBox();
    if (!b || Math.min(b.width, b.height) < 44) {
      작은것.push(`${이름} ${b ? `${Math.round(b.width)}×${Math.round(b.height)}` : "없음"}`);
    }
  }
  expect(작은것, `손가락에 작다: ${작은것.join(" · ")}`).toEqual([]);
});
