import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas } from "./helpers";

/**
 * 세션 선택 화면의 **대화방 팝업 · 최근 대화** (사용자 지시 2026-08-09).
 *
 * 이 화면이 하는 일은 "어느 방으로 갈까"를 **한 화면에서** 끝내는 것이다.
 * 여기서 지키는 약속은 셋이다:
 *
 *  1. 카드는 **곧장 안 들어간다** — 그 공간의 방 목록을 편다.
 *  2. 방 이름 옆의 개념 칩은 **지도와 같은 색**이다(`lib/ui/pastel.ts`).
 *  3. ⋮는 **팝업에만** 있다 — 최근 목록은 가는 길이지 관리하는 자리가 아니다.
 */
test.describe.configure({ mode: "serial" });

/**
 * ⚠️ `serial`은 **순서만** 정한다. 테스트마다 컨텍스트가 새것이라 로그인도
 * 매번 해야 한다 — 첫 테스트에서만 하면 두 번째부터 로그인 화면에서 멈춘다.
 */
test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
});

test("카드를 누르면 들어가지 않고 방 목록이 펼쳐진다", async ({ page }) => {
  await page.goto("/sessions");

  // 카드를 글자로 잡으면 "최근 대화"의 줄이 먼저 걸린다(helpers.enterSpace 주석).
  const card = page.locator("[data-space-card^='personal']").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // 눌렀는데 화면이 통째로 바뀌면 팝업을 만든 뜻이 없다.
  expect(page.url()).toContain("/sessions");

  // Esc로 닫힌다 — 갇히면 바깥을 누를 곳을 찾아다니게 된다.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test("방 줄의 ⋮에 이름 변경·삭제가 있다", async ({ page }) => {
  await page.goto("/sessions");
  await page.locator("[data-space-card^='personal']").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  await dialog.locator("button[aria-label$='메뉴']").first().click();
  await expect(page.getByRole("menuitem", { name: "이름 변경" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "삭제" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("최근 대화는 팝업으로 열리고 ⋮가 없다", async ({ page }) => {
  /**
   * **화면 하단 목록에서 팝업으로 옮겼다** (UI 개편 2026-08-11, 요구사항 4-1).
   *
   * 그 목록은 "어디로 갈까"(세션 카드)와 "하던 것 잇기"를 한 화면에 나란히
   * 두고 있어서, 카드를 고르러 온 사람에게도 늘 자리를 차지했다.
   */
  await page.goto("/sessions");
  await expect(page.locator("[data-space-card]").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /최근 대화/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // ⋮가 여기 있으면 "어디 것을 지웠는지" 되짚을 자리가 없다(사용자 지시).
  await expect(dialog.locator("button[aria-label$='메뉴']")).toHaveCount(0);

  // 팝업이 키의 주인이다(`lib/ui/modalLayer.ts`) — ESC로 닫힌다.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 10_000 });
});

test("개념 칩은 지도와 같은 색이고, 넘치면 …로 접힌다", async ({ page }) => {
  await page.goto("/sessions");
  await expect(page.locator("[data-space-card]").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  const 색 = await page.evaluate(() => {
    // `lib/ui/pastel.ts`의 그 여섯 색. 칩이 이 밖의 색을 쓰면 지도와 갈린다.
    const PASTEL = ["#a8c8e8", "#b8b0e0", "#d0a8d8", "#e8b8b0", "#e0cba0", "#a8d0c0"];
    const hex = (rgb: string) => {
      const m = rgb.match(/\d+/g);
      if (!m) return "";
      return (
        "#" +
        m
          .slice(0, 3)
          .map((v) => Number(v).toString(16).padStart(2, "0"))
          .join("")
      );
    };
    const chips = [...document.querySelectorAll("main span[style*='border']")];
    const 색들 = chips.map((c) => hex(getComputedStyle(c).borderTopColor));
    return {
      개수: chips.length,
      파스텔밖: 색들.filter((c) => c && !PASTEL.includes(c)),
      접힘: [...document.querySelectorAll("main span")].some(
        (s) => s.textContent?.trim() === "…",
      ),
    };
  });

  expect(색.개수).toBeGreaterThan(0);
  expect(색.파스텔밖).toEqual([]);
  // 개인 공간에는 분류가 넉넉히 쌓여 있어 카드에서 반드시 접힌다.
  expect(색.접힘).toBe(true);
});
