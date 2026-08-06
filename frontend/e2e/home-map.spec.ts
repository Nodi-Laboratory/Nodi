import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

/**
 * 홈 개념 지도 (D189).
 *
 * 지도는 **캔버스 한 장**이라 DOM으로는 아무것도 안 보인다 — 점이 그려졌는지,
 * 누르면 옮겨 가는지는 실제로 태워 봐야 안다. 순수 계산은
 * `lib/home/conceptLayout.test.ts`가 지키고, 여기는 배선을 확인한다.
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/);
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }
}

test("홈에 개념 지도가 그려지고, 개념을 누르면 그 대화로 간다", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: /개념 지도/ })).toBeVisible();

  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // 힘 배치가 자리를 잡을 시간을 준다.
  await page.waitForTimeout(3000);

  // **빈 캔버스가 아니어야 한다.** 점이 하나도 없으면 회색 판과 구분되지 않고,
  // 그 상태로도 위 단언은 전부 통과한다.
  const painted = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) on++;
    return on;
  });
  expect(painted, "지도가 비어 있다").toBeGreaterThan(500);

  // 개념을 눌러 그 대화로 이동. 어느 점이 있는지 모르므로 가운데에서
  // 나선으로 훑어 실제로 노드가 있는 자리를 찾는다.
  const box = await canvas.boundingBox();
  if (!box) throw new Error("캔버스를 찾지 못했습니다");
  let moved = false;
  for (let i = 0; i < 260 && !moved; i++) {
    const a = i * 0.5;
    const rad = 4 + i * 1.6;
    const x = box.x + box.width / 2 + Math.cos(a) * rad;
    const y = box.y + box.height / 2 + Math.sin(a) * rad;
    if (x < box.x + 4 || x > box.x + box.width - 4) continue;
    if (y < box.y + 4 || y > box.y + box.height - 4) continue;
    await page.mouse.move(x, y);
    // 툴팁이 뜨면 그 자리에 개념이 있다는 뜻이다.
    if (await page.getByText("눌러서 이동").isVisible().catch(() => false)) {
      await page.mouse.click(x, y);
      moved = true;
    }
  }
  expect(moved, "지도에서 개념을 하나도 못 짚었다").toBe(true);
  await page.waitForURL(/\/space\//, { timeout: 30_000 });
});

test("개념이 없으면 무엇을 하면 되는지 말해 준다", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  // 빈 상태는 개념이 0건일 때만 뜬다 — 응답을 비워 그 화면만 확인한다.
  // (계정을 비우면 다른 스펙이 쓰는 데이터가 사라진다.)
  await page.route("**/api/home/concept-map", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [], edges: [], sessions: [] }),
    }),
  );
  await page.goto("/home");
  await expect(page.getByText("아직 지도에 올릴 개념이 없습니다")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "첫 대화 시작하기" })).toBeVisible();
});
