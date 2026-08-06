import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

/**
 * **이미 저장돼 있던** 클립 카드도 새 모양으로 뜬다 (D190).
 *
 * 썸네일은 카드에 저장되지 않고 clip id로 고르므로(`lib/canvas2/clipThumb.ts`)
 * 옛 카드도 되어야 맞다 — 그런데 "되어야 맞다"와 "된다"는 다른 말이라 실제로
 * 태운다. 새 대화에서만 되고 지난 대화는 옛 모양인 채 남는 일이 흔하다.
 *
 * ⚠️ 이 스펙은 지난 대화에 클립 카드가 있는 계정을 전제한다. 없으면 건너뛴다 —
 * 조용히 통과하지 않고 건너뛴 사실을 남긴다.
 */
test("지난 대화의 클립 카드도 정사각형 + 썸네일로 뜬다", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|space)/);
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }

  await page.goto("/space/personal");
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });

  // 지난 대화 중 클립이 있는 것을 찾는다.
  await page.getByLabel("대화 목록 열기").click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  const row = drawer.getByText("[확인] 옛 클립 카드");
  /**
   * **목록이 뜨기를 기다린 뒤에** 없는지 본다.
   *
   * 처음에는 클릭하자마자 `count()`로 셌는데 목록이 아직 안 와서 0이었고,
   * 그대로 skip해 **아무것도 확인하지 않은 채 초록**이었다. `figure.spec.ts`가
   * 조용한 skip 때문에 결함을 못 잡은 것과 같은 함정이다.
   */
  const found = await row
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "클립이 있는 지난 대화가 없다");

  await row.first().click();
  await page.keyboard.press("Escape");

  const clip = page.locator("[data-canvas-clip]").first();
  await expect(clip).toBeVisible({ timeout: 30_000 });

  // 1) 정사각형이다.
  const box = await clip.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);

  // 2) 썸네일이 **실제로 그려졌다.** 태그만 있고 픽셀이 없으면 깨진 그림이다.
  const img = clip.locator("img");
  await expect(img).toBeVisible({ timeout: 20_000 });
  const painted = await img.evaluate(
    (el) => (el as HTMLImageElement).naturalWidth > 0,
  );
  expect(painted, "썸네일이 안 그려졌다").toBe(true);

  // 3) 링크가 썸네일 **아래**에 있다(사용자 지시: 제목 — 그림 — 이어 보기).
  const link = clip.getByText("EBS에서 이어 보기");
  const imgBox = await img.boundingBox();
  const linkBox = await link.boundingBox();
  expect(linkBox!.y).toBeGreaterThan(imgBox!.y);
});
