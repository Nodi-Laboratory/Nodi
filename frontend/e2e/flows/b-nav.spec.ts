import { expect, test } from "@playwright/test";
import { enterSpace, loginAndOpenCanvas } from "../helpers";

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
  /**
   * 빈 화면이면 안 된다 — 무엇을 하면 되는지 글이 있어야 한다.
   *
   * 홈은 개념이 없으면 캔버스로 보내므로(D210 2-1) 둘 중 하나에 도달한다:
   * 인사말이 뜨거나, 대화방으로 옮겨 가거나. **"불러오는 중"에서 재면 안 된다** —
   * 그 문구가 딱 열 글자라 실측에서 경계에 걸렸다.
   */
  await expect
    .poll(async () => (await page.locator("main").innerText()).trim().length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(20);
});

/**
 * 공간으로 들어가는 길이 **세션 선택 페이지**로 바뀌었다 (D217).
 *
 * 예전에는 사이드바에 학급마다 동그라미가 있었다. 학급이 늘수록 서로
 * 구분이 안 돼서 걷어냈고, 지금은 [세션] -> 카드를 고르는 길 하나다.
 */
test("B12 사이드바 -> 세션 선택 -> 개인 세션으로 들어간다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.getByRole("link", { name: "세션" }).click();
  await page.waitForURL(/\/sessions/);
  // 개인 세션은 **언제나 첫 칸**이다(D217) — 자리가 바뀌면 손이 기억 못 한다.
  // 카드는 곧장 안 들어가고 방 목록을 편다(사용자 지시 2026-08-09).
  await enterSpace(page, /개인 세션/);
  await page.waitForURL(/\/space\/personal/);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
});

test("B12b 세션 선택 화면이 학급을 자료·강의·분류와 함께 보여 준다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/sessions");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("세션");
  // 학급 코드로 들어가는 자리 — 칸 여섯 + [추가하기](사용자 지시 2026-08-09).
  await expect(page.getByText("내 학급 추가하기")).toBeVisible();
  await expect(page.getByLabel("학급 코드 1번째 자리")).toBeVisible();
  await expect(page.getByLabel("학급 코드 6번째 자리")).toBeVisible();
  await expect(page.getByRole("button", { name: "추가하기" })).toBeVisible();
  // 카드가 최소 하나(개인 세션)는 늘 있다.
  await expect(page.locator("[data-space-card^='personal']")).toBeVisible();
});

test("B13·B14 학급 ↔ 개인을 오가도 세션이 안 섞인다 (D148)", async ({ page }) => {
  const session = watchSession(page);
  await loginAndOpenCanvas(page);

  /**
   * 학급을 **세션 선택 페이지**에서 찾는다 (D217).
   *
   * 예전에는 사이드바의 space 링크로 골랐는데 그 링크가 없어졌다. 지금
   * 학급으로 들어가는 길은 카드뿐이라, 카드를 눌러 도착한 주소를 쓴다.
   */
  await page.goto("/sessions");
  await expect(page.locator("[data-space-card]").first()).toBeVisible({ timeout: 30_000 });
  const cards = page.locator("main button").filter({ hasText: /자료 \d+개/ });
  if ((await cards.count()) === 0) test.skip(true, "가입한 학급이 없다");
  await cards.first().click();
  // 팝업에서 방을 골라야 들어간다.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.locator("[data-room-row] button").first().click();
  await page.waitForURL(/\/space\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const classHref = new URL(page.url()).pathname;

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
