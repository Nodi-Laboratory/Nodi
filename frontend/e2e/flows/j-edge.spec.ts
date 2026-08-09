import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, setAskPen } from "../helpers";

/**
 * 플로우 J91–J100 — 경계·회복·접근성 (docs/TEST-FLOWS.md).
 *
 * 여기서 깨지는 것들은 **교실에서만** 드러난다: 좁은 노트북, 태블릿, 느린 망,
 * 마우스를 못 쓰는 학생. 개발자 화면에서는 전부 멀쩡해 보인다.
 */
test.describe.configure({ mode: "serial" });

test("J91 백엔드가 죽어도 화면이 잠기지 않는다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  // 이 시점부터 채팅 창구만 끊는다 — 학생이 겪는 그대로.
  await page.route("**/api/chat/**", (route) => route.abort("failed"));

  await page.getByLabel("질문 입력").fill("서버가 죽었을 때");
  await page.getByLabel("보내기").click();
  await page.waitForTimeout(6000);

  // 입력창이 영영 잠기면 학생은 아무것도 못 한다 — 되살아나야 한다.
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 20_000 });
  const body = await page.locator("body").innerText();
  expect(body.trim().length).toBeGreaterThan(10);
  await page.getByLabel("질문 입력").fill("");
});

test("J93 교실 노트북(1366×768)에서 UI가 서로 안 겹친다", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await loginAndOpenCanvas(page);

  const bar = (await page.getByLabel("질문 입력").boundingBox())!;
  const rail = (await page
    .getByRole("button", { name: "선택·이동", exact: true })
    .boundingBox())!;
  // 입력창과 도구 레일이 겹치면 둘 중 하나를 못 쓴다.
  expect(bar.x + bar.width).toBeLessThan(rail.x + rail.width);

  const vp = page.viewportSize()!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(vp.height);
  expect(rail.x + rail.width).toBeLessThanOrEqual(vp.width);
});

test("J94 태블릿 세로(768×1024)에서도 마찬가지다", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await loginAndOpenCanvas(page);

  const bar = (await page.getByLabel("질문 입력").boundingBox())!;
  const vp = page.viewportSize()!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(vp.width);
  expect(bar.y + bar.height).toBeLessThanOrEqual(vp.height);
});

test("J97 뒤로/앞으로가 상태를 어긋내지 않는다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/home");
  await page.goto("/profile");
  await page.goBack();
  await page.goBack();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.goForward();
  await page.waitForTimeout(1500);
  const body = await page.locator("body").innerText();
  expect(body.trim().length).toBeGreaterThan(10);
});

test("J98 주요 흐름에서 콘솔 오류가 0건이다", async ({ page }) => {
  const errs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));

  await loginAndOpenCanvas(page);
  await setAskPen(page, true);
  await page.getByRole("button", { name: "선택·이동", exact: true }).click();
  await page.getByRole("button", { name: "지난 대화" }).click();
  await page.keyboard.press("Escape");
  // 설정은 **팝업**이다(사용자 지시 2026-08-10) — `/profile`은 더 없다.
  await page.getByLabel(/^설정/).click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.getByLabel("도움말").click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.goto("/home");
  await page.waitForTimeout(1500);

  expect(errs.join("\n")).toBe("");
});

test("J99 키보드만으로 질문을 보낼 수 있다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const box = page.getByLabel("질문 입력");
  await box.focus();
  await page.keyboard.type("키보드로 쓴 질문");
  await expect(box).toHaveValue("키보드로 쓴 질문");

  // Shift+Enter는 줄바꿈이고 보내지 않는다.
  await page.keyboard.press("Shift+Enter");
  await expect(box).toHaveValue(/\n/);
  await box.fill("");
});

/** 화면에 보이는데 이름이 없는 버튼들. */
async function namelessButtons(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const b of Array.from(document.querySelectorAll("button"))) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // 안 보이는 것은 제외
      const name =
        b.getAttribute("aria-label") ||
        b.getAttribute("title") ||
        (b.textContent ?? "").trim();
      if (!name) out.push(b.className.toString().slice(0, 60) || "(무명 버튼)");
    }
    return out;
  });
}

test("J100 어느 화면에서도 버튼에 이름이 있다", async ({ page }) => {
  /**
   * 이름 없는 버튼은 스크린리더에 "버튼"으로만 읽힌다 — 무엇을 하는지 알 수
   * 없다. 실제로 여기서 대화 목록의 ⋯ 버튼이 잡혔다(2026-08-05).
   */
  await loginAndOpenCanvas(page);
  expect(await namelessButtons(page)).toEqual([]);

  // 열어야 보이는 것들 — 서랍 안이 특히 잘 빠진다.
  await page.getByRole("button", { name: "지난 대화" }).click();
  await page.waitForTimeout(500);
  expect(await namelessButtons(page)).toEqual([]);
  await page.keyboard.press("Escape");

  for (const path of ["/home", "/profile"]) {
    await page.goto(path);
    await page.waitForTimeout(1200);
    expect(await namelessButtons(page)).toEqual([]);
  }
});
