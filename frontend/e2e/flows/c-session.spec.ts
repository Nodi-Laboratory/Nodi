import { expect, test, type Page } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "../helpers";

/**
 * 플로우 C21–C30 — 대화 세션 (docs/TEST-FLOWS.md).
 *
 * 세션은 학생의 작업 단위다. 여기서 어긋나면 **쓴 글이 남의 대화에 나타나거나
 * 사라진 것처럼 보인다** — 데이터가 멀쩡해도 학생에게는 잃어버린 것이다.
 */
test.describe.configure({ mode: "serial" });

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "지난 대화" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("C21 새 대화는 빈 캔버스에서 시작한다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
  await expect(page.locator("[data-canvas-item]")).toHaveCount(0);
  await expect(page.getByLabel("질문 입력")).toBeEnabled();
});

test("C22 대화 목록이 열리고 세션들이 보인다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openDrawer(page);
  const rows = page.getByRole("dialog").getByText("새 대화");
  expect(await rows.count()).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("C24 세션 이름을 바꾸면 목록이 따라간다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
  await openDrawer(page);

  // 행 메뉴는 hover에만 보인다 — 먼저 그 행에 마우스를 올린다.
  const row = page.getByRole("dialog").getByRole("button", { name: /메뉴$/ }).first();
  await row.click({ force: true });
  await page.getByRole("dialog").getByRole("button", { name: "이름 변경" }).click();

  const name = `대화${Date.now() % 10000}`;
  // ⚠️ `input`을 순서로 잡으면 안 된다 — 서랍에 **찾기 칸**이 생기면서
  // 첫 input이 그쪽이 됐다(그 상태로 이름을 치면 목록만 걸러진다).
  const box = page.getByRole("dialog").getByLabel("새 대화 이름");
  await box.fill(name);
  await box.press("Enter");
  await expect(page.getByRole("dialog")).toContainText(name, { timeout: 10_000 });

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await openDrawer(page);
  // 새로고침 뒤에도 남아야 한다 — 화면에서만 바뀌었으면 다음에 못 찾는다.
  await expect(page.getByRole("dialog")).toContainText(name);
});

test("C27 세션과 글은 새로고침을 견딘다 (D147)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const before = await page.locator("[data-canvas-item]").count();
  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const after = await page.locator("[data-canvas-item]").count();
  // **줄어들면 안 된다.** 수화가 두 번 돌면 글이 `_legacy` 복사본으로 바뀐다.
  expect(after).toBe(before);
});

test("C27b 새로고침이 글을 복제하지 않는다 (D147)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const first = await page.locator("[data-canvas-item]").count();
  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  // 실측된 회귀: 카드 3개가 9개가 됐다.
  expect(await page.locator("[data-canvas-item]").count()).toBe(first);
});

test("C30 드로어는 Esc로 닫히고 캔버스가 살아 있다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  // 닫은 뒤 곧바로 질문할 수 있어야 한다.
  await page.getByLabel("질문 입력").fill("확인");
  await expect(page.getByLabel("질문 입력")).toHaveValue("확인");
  await page.getByLabel("질문 입력").fill("");
});

/**
 * 세션 수는 **서랍에 그려진 줄이 아니라 서버에 물어서** 센다.
 *
 * 예전에는 목록의 행을 셌는데, 계정에 대화가 쌓이면 그 수가 "지금 몇 줄이
 * 그려졌나"가 되어 버린다 — 실측 2026-08-07: 같은 계정에서 1↔2, 1↔11로
 * 흔들렸고 **줄어들기도** 했다(세션이 줄어들 리는 없다). 재려는 것은 화면이
 * 아니라 "새로고침이 세션을 만들었나"이므로 창구에 직접 묻는다.
 */
async function sessionCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const token = document.cookie
      .split("; ")
      .find((c) => c.startsWith("nodi_token="))
      ?.slice("nodi_token=".length);
    const res = await fetch("/api/sessions?space_kind=personal", {
      headers: { Authorization: `Bearer ${decodeURIComponent(token ?? "")}` },
    });
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) ? rows.length : -1;
  });
}

test("C96 새로고침 연타가 세션을 불리지 않는다 (J96)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const before = await sessionCount(page);
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 3; i++) {
    await page.reload();
    await page.waitForTimeout(800);
  }
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 새로고침마다 세션을 만들면 목록이 쓰레기로 찬다.
  expect(await sessionCount(page)).toBe(before);
});
