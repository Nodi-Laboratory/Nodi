import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas } from "../helpers";

/**
 * 플로우 B11–B20 — 홈·공간 이동 (docs/TEST-FLOWS.md).
 *
 * 학생은 하루에도 공간을 여러 번 오간다. 여기서 세션이 섞이면 **남의 공간에
 * 자기 대화가 열린다**(D148이 막는 것). 로그인은 한 번만 한다.
 */
test.describe.configure({ mode: "serial" });

/**
 * 지금 열린 세션 id를 **네트워크에서** 읽는다.
 *
 * 스토어는 메모리에만 있어(localStorage에 안 남는다) 밖에서 볼 수 없다.
 * 캔버스를 불러오는 요청 주소에 세션 id가 들어 있으므로 그걸 잡는다.
 */
function watchSession(page: import("@playwright/test").Page): () => string {
  let last = "";
  page.on("request", (r) => {
    const m = r.url().match(/\/sessions\/([0-9a-f-]{36})\/canvas/i);
    if (m) last = m[1];
  });
  return () => last;
}

test("B11 홈은 비어 있어도 말이 되게 보인다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/home");
  await expect(page.locator("main")).toBeVisible();
  // 빈 화면이면 안 된다 — 무엇을 하면 되는지 글이 있어야 한다.
  const text = await page.locator("main").innerText();
  expect(text.trim().length).toBeGreaterThan(10);
});

test("B12 사이드바로 개인 공간에 들어간다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/home");
  await page.getByRole("link", { name: /공간 전환: 개인/ }).click();
  await page.waitForURL(/\/space\/personal/);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
});

test("B13·B14 학급 ↔ 개인을 오가도 세션이 안 섞인다 (D148)", async ({ page }) => {
  const session = watchSession(page);
  await loginAndOpenCanvas(page);

  // `hasNot`은 **자손**을 보므로 링크 자신을 거를 수 없다 — href로 고른다.
  const hrefs = await page.locator('nav a[href^="/space/"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("href") ?? "").filter((h) => h !== "/space/personal"),
  );
  if (!hrefs.length) test.skip(true, "가입한 학급이 없다");
  const classHref = hrefs[0];

  await page.goto(classHref);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const classSession = session();

  await page.goto("/space/personal");
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const personalSession = session();

  await page.goto(classHref);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const backSession = session();

  // **공간마다 세션이 따로다** (D148). 개인 세션이 학급 공간에서 열리면
  // 그 캔버스를 편집하고 질문까지 보낼 수 있다.
  expect(classSession).not.toBe("");
  expect(personalSession).not.toBe(classSession);
  expect(backSession).toBe(classSession);
});

test("B15 없는 공간 id로 들어가도 잠기지 않는다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/space/00000000-0000-0000-0000-000000000000");
  await page.waitForTimeout(4000);
  const body = await page.locator("body").innerText();
  // 빈 화면·무한 스피너가 아니라, 안내든 복귀든 **무언가**가 있어야 한다.
  expect(body.trim().length).toBeGreaterThan(10);
});

test("B16 프로필에서 이름을 바꾸면 사이드바가 따라 바뀐다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/profile");
  const input = page.getByPlaceholder("표시 이름");

  const next = `E2E테스트${Date.now() % 1000}`;
  await input.fill(next);
  await page.getByRole("button", { name: /저장|변경/ }).first().click();
  await page.waitForTimeout(1500);

  await page.goto("/home");
  // 사이드바는 이니셜만 보여 준다 — 이름은 라벨에 있다(스크린리더가 읽는다).
  await expect(page.getByRole("link", { name: new RegExp(next) })).toBeVisible({
    timeout: 15_000,
  });

  // 공유 계정이므로 이름을 되돌려 둔다.
  await page.goto("/profile");
  await page.getByPlaceholder("표시 이름").fill("E2E테스트");
  await page.getByRole("button", { name: /저장|변경/ }).first().click();
  await page.waitForTimeout(1200);
});

test("B19 잘못된 학급 코드는 404 안내다 — 502가 아니라 (D169)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/profile");

  const codeInput = page.getByPlaceholder("학급 코드");
  await codeInput.fill("ZZZZZZ");
  const statuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/me/classes") || r.url().includes("join")) statuses.push(r.status());
  });
  await page.getByRole("button", { name: /가입|추가|연결/ }).first().click();
  await page.waitForTimeout(2500);

  // 502가 하나라도 있으면 실패 — 학생 잘못을 서버 고장으로 보고하는 것이다.
  expect(statuses.filter((s) => s >= 500)).toEqual([]);
  await expect(page.locator("body")).toContainText(/유효하지 않은|없는|확인/);
});

test("B18 소문자 학급 코드도 통한다 (D170)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/profile");
  const codeInput = page.getByPlaceholder("학급 코드");
  await codeInput.fill("abc123");
  // 화면이 먼저 대문자로 보여 준다 — 서버도 정규화하지만 학생이 먼저 안다.
  await expect(codeInput).toHaveValue("ABC123");
});

test("B20 학급 목록이 새로고침 뒤에도 남는다 (D169)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/profile");
  await page.waitForTimeout(1500);
  const before = await page.locator("main").innerText();
  await page.reload();
  await page.waitForTimeout(2000);
  const after = await page.locator("main").innerText();
  // 학급 이름이 통째로 사라지는 회귀(D169)를 잡는다.
  const names = before.match(/\d학년\d반/g) ?? [];
  for (const n of names) expect(after).toContain(n);
});
