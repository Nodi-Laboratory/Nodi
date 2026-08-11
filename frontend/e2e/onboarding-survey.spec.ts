import { expect, test } from "@playwright/test";

/**
 * 온보딩 설문 (D222).
 *
 * **가입한 사람만 볼 수 있는 화면**이라 매번 계정을 새로 만든다 — 기존 계정은
 * `onboarded`가 true라 이 화면으로 못 들어간다.
 */

const PW = "onbPass!234";

/** 계정 하나를 만들고 온보딩까지 간다. 이메일은 매번 달라야 한다. */
async function signUp(page: import("@playwright/test").Page): Promise<void> {
  const 이메일 = `onb-e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}@nodi.test`;
  await page.goto("/signup");
  await page.locator('input[name="name"]').fill("김노디");
  await page.locator('input[name="email"]').fill(이메일);
  await page.locator('input[name="new-password"]').fill(PW);
  await page.locator('input[name="confirm-password"]').fill(PW);
  await page.getByRole("button", { name: /가입|회원가입|시작/ }).first().click();
  await page.waitForURL(/\/onboarding/, { timeout: 90_000 });
}

test("네 단계를 넘기면 답이 저장되고 학급 코드 마당으로 간다", async ({ page }) => {
  await signUp(page);
  await expect(page.locator("[data-survey-steps]")).toBeVisible({ timeout: 30_000 });

  await page.locator("input").first().fill("김노디");
  await page.locator("[data-survey-next]").click();

  await page.getByRole("button", { name: "중학교 2학년" }).click();
  await page.locator("[data-survey-next]").click();

  await page.getByRole("button", { name: "시험 준비 중" }).click();
  await page.locator("[data-survey-next]").click();

  // 마지막 단계에서만 글자가 바뀐다 — 다음에 무엇이 오는지 버튼이 말해야 한다.
  await expect(page.locator("[data-survey-next]")).toContainText("시작하기");
  await page.getByRole("button", { name: "기초를 탄탄히" }).click();
  await page.locator("[data-survey-next]").click();

  await expect(page.getByText("연결할 학급이 있습니까?")).toBeVisible({ timeout: 30_000 });

  // **DB까지 확인한다.** 화면이 넘어간 것과 값이 남은 것은 다른 사실이다.
  const saved = await page.evaluate(async () => {
    const tok = decodeURIComponent(
      (document.cookie.split("; ").find((c) => c.startsWith("nodi_token=")) ?? "=").split("=")[1],
    );
    const r = await fetch("/api/auth/onboarding-answers", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return r.ok ? await r.json() : null;
  });
  expect(saved).toMatchObject({
    display_name: "김노디",
    grade: "중학교 2학년",
    stage: "시험 준비 중",
    goal: "기초를 탄탄히",
  });
});

test("아무것도 안 적어도 넘어간다", async ({ page }) => {
  /**
   * 형식상 받아 두는 값이라 **막지 않는 것이 설계다**(사용자 확인 2026-08-11).
   * 필수로 바뀌면 여기서 깨진다 — 그때는 이 결정을 다시 확인해야 한다.
   */
  await signUp(page);
  await expect(page.locator("[data-survey-steps]")).toBeVisible({ timeout: 30_000 });

  for (let i = 0; i < 4; i++) {
    await expect(page.locator("[data-survey-next]")).toBeEnabled();
    await page.locator("[data-survey-next]").click();
    await page.waitForTimeout(200);
  }
  await expect(page.getByText("연결할 학급이 있습니까?")).toBeVisible({ timeout: 30_000 });
});
