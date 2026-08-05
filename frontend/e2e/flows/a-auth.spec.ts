import { expect, test, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "../helpers";

/**
 * 플로우 A1–A10 — 인증·진입 (docs/TEST-FLOWS.md).
 *
 * 로그인은 **모든 학생이 매일 처음 밟는 길**이라, 여기서 막히면 나머지가 다
 * 무의미하다. 계정을 만들지 않고 기존 e2e 계정으로만 돈다(가입 플로우는
 * 계정을 남기므로 A9만 검증 화면까지 본다).
 */
test.describe.configure({ mode: "serial" });

/**
 * 로그인 한 번.
 *
 * **하이드레이션 전에 채우면 React가 되돌린다** — 값은 DOM에 들어갔는데 state가
 * 비어 버튼이 계속 비활성이고, 누른 적 없는 클릭을 기다리게 된다(실측).
 * 버튼이 살아날 때까지 다시 채운다.
 */
async function login(page: Page, email: string, password: string): Promise<void> {
  const submit = page.getByRole("button", { name: "로그인" });
  await expect(async () => {
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await expect(submit).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await submit.click();
}

test("A1 로그인 화면에 필요한 것이 다 있다", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
  await expect(page.getByRole("link", { name: /회원가입/ })).toBeVisible();
});

test("A2 빈 칸이면 아무 요청도 안 나간다", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/login")) calls.push(r.url());
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "로그인" })).toBeDisabled();
  expect(calls).toEqual([]);
});

test("A3·A4 틀린 자격은 같은 문구로 거절한다 — 계정 존재가 새지 않게", async ({ page }) => {
  await page.goto("/login");
  const alert = page.locator('form [role="alert"]');

  await login(page, "nobody-nowhere@nodi.test", "whatever1!");
  await expect(alert).toContainText(/이메일 또는 비밀번호/);
  const missing = (await alert.textContent())!;

  await page.locator('input[name="password"]').fill("");
  await login(page, E2E_EMAIL, "wrong-password!");
  await expect(alert).toBeVisible();
  const wrong = (await alert.textContent())!;
  // **같은 문구여야 한다.** 다르면 "그 계정은 있다"가 새어 나간다.
  expect(wrong).toBe(missing);
});

test("A5 맞는 계정은 자기 화면으로 보낸다", async ({ page }) => {
  await page.goto("/login");
  await login(page, E2E_EMAIL, E2E_PASSWORD);
  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/, { timeout: 30_000 });
  expect(page.url()).toMatch(/\/(onboarding|home|space)/);
});

test("A6 로그인한 채 /login을 다시 열면 되돌려 보낸다", async ({ page }) => {
  await page.goto("/login");
  await login(page, E2E_EMAIL, E2E_PASSWORD);
  await page.waitForURL(/\/(onboarding|home|space)/, { timeout: 30_000 });

  await page.goto("/login");
  await page.waitForTimeout(2000);
  // 이미 들어온 사람에게 다시 로그인 화면을 보이면, 학생은 자기가 로그아웃된
  // 줄 안다.
  expect(page.url()).not.toContain("/login");
});

test("A8 망가진 토큰이 화면을 잠그지 않는다 (D168)", async ({ page }) => {
  await page.goto("/login");
  await page.evaluate(() => {
    document.cookie = "nodi_token=not-a-real-jwt; path=/";
  });
  await page.goto("/home");
  await page.waitForTimeout(2500);
  // 잠기면 안 된다 — 로그인으로 보내든 홈을 보이든, 멈춰 있으면 실패다.
  const stuck = await page.evaluate(() => document.body.innerText.trim().length === 0);
  expect(stuck).toBe(false);
});

test("A7 로그아웃 뒤 보호된 화면은 안 열린다", async ({ page }) => {
  await page.goto("/login");
  await login(page, E2E_EMAIL, E2E_PASSWORD);
  await page.waitForURL(/\/(onboarding|home|space)/, { timeout: 30_000 });

  await page.evaluate(() => {
    document.cookie = "nodi_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    localStorage.clear();
  });
  await page.goto("/space/personal");
  await page.waitForTimeout(2500);
  expect(page.url()).toContain("/login");
});

test("A9 가입 화면이 약한 비밀번호를 저장 전에 막는다", async ({ page }) => {
  await page.goto("/signup");
  await page.locator('input[name="name"]').fill("테스트");
  await page.locator('input[name="email"]').fill(`x${Date.now()}@nodi.test`);
  await page.locator('input[name="new-password"]').fill("123");
  await page.locator('input[name="confirm-password"]').fill("123");
  const submit = page.getByRole("button", { name: /가입/ });
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/auth/signup")) calls.push(r.url());
  });
  if (await submit.isEnabled()) await submit.click();
  await page.waitForTimeout(1200);
  // 저장까지 갔다가 서버가 거절하는 것도 답이지만, 그때도 **한국어 안내**가
  // 떠야 한다. 아무 반응 없이 머무는 것이 실패다.
  const told = await page.locator('form [role="alert"]').count();
  expect(calls.length === 0 || told > 0).toBe(true);
});
