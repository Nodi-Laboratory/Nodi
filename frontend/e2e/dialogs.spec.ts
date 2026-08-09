import { expect, test } from "@playwright/test";
import { closeDialog, loginAndOpenCanvas, openSettings } from "./helpers";

/**
 * 설정·도움말 **팝업** (사용자 지시 2026-08-10).
 *
 * 둘 다 페이지였다. 팝업으로 옮긴 이유는 하나다 — 거기서 하는 일이 전부
 * **한 번 하고 돌아가는 일**이라, 하던 대화를 떠날 값이 없다는 것.
 *
 * 그래서 여기서 지키는 약속의 첫째는 **주소가 안 바뀐다**이다. 나머지는
 * 팝업이 팝업답게 구는지다: Esc로 닫히고, 뒤쪽 화면이 키를 안 먹고,
 * 도움말은 좌우로 넘어간다.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
});

test("설정은 화면을 안 바꾸고 그 자리에서 열린다", async ({ page }) => {
  const before = page.url();
  await openSettings(page);
  expect(page.url()).toBe(before);

  const dlg = page.getByRole("dialog", { name: "설정" });
  await expect(dlg.getByPlaceholder("표시 이름")).toBeVisible();
  await expect(dlg.getByPlaceholder("학급 코드")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "로그아웃" })).toBeVisible();

  await closeDialog(page);
  // 캔버스가 그대로 살아 있다 — 팝업이 덮기만 했지 화면을 갈아 치우지 않았다.
  await expect(page.getByLabel("질문 입력")).toBeEnabled();
});

test("도움말은 카드를 넘겨 가며 본다", async ({ page }) => {
  await page.getByLabel("도움말").click();
  const dlg = page.getByRole("dialog", { name: "도움말" });
  await expect(dlg).toBeVisible();

  const title = () => dlg.locator("h3").textContent();
  const first = await title();

  // 화살표 버튼
  await page.getByLabel("다음 설명").click();
  await expect.poll(title).not.toBe(first);
  const second = await title();

  /**
   * 좌우 방향키 — ⚠️ 이게 이 스펙의 핵심이다.
   *
   * 캔버스가 document에 **캡처**로 방향키를 듣고 `stopPropagation`까지 하기
   * 때문에, 팝업이 document에 걸면 이벤트가 아예 안 온다(실측 2026-08-10:
   * 화살표가 한 번도 안 먹었다). 팝업은 창(window)에서 캡처로 듣는다.
   */
  await page.keyboard.press("ArrowLeft");
  await expect.poll(title).toBe(first);
  await page.keyboard.press("ArrowRight");
  await expect.poll(title).toBe(second);

  // 첫 장에서는 이전 버튼이 꺼져 있다 — 끝을 알려 주는 것도 안내다.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByLabel("이전 설명")).toBeDisabled();

  // 점을 눌러 바로 간다.
  const dots = dlg.locator("footer button");
  await expect(dots).toHaveCount(6);
  await dots.last().click();
  await expect(page.getByLabel("다음 설명")).toBeDisabled();

  await closeDialog(page);
});

/**
 * **팝업이 떠 있으면 캔버스는 키를 안 먹는다** (`lib/ui/modalLayer.ts`).
 *
 * 이걸 안 지키면 설정 팝업 밖을 눌러 둔 채 'p'를 쳤을 때 캔버스 도구가 자유선으로
 * 바뀌고, 닫고 나서야 알게 된다.
 */
test("팝업이 열린 동안 캔버스 단축키가 안 듣는다", async ({ page }) => {
  const tool = page.getByRole("button", { name: "선택·이동", exact: true });
  await expect(tool).toHaveAttribute("aria-pressed", "true");

  await openSettings(page);
  await page.keyboard.press("p"); // 평소라면 자유선
  await page.waitForTimeout(400);
  await closeDialog(page);

  await expect(tool).toHaveAttribute("aria-pressed", "true");
});

test("걷어낸 페이지는 주소로도 안 열린다", async ({ page }) => {
  for (const path of ["/help", "/profile"]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path}가 아직 살아 있다`).toBe(404);
  }
});
