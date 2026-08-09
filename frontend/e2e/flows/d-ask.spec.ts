import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "../helpers";

/**
 * 플로우 D31–D40 — 질문에서 답까지 (docs/TEST-FLOWS.md).
 *
 * **이 앱의 본체**다. 진짜 LLM 턴을 태우므로 느리다 — 그래서 한 번의 턴에
 * 여러 규칙을 겹쳐 확인한다.
 */
test.describe.configure({ mode: "serial" });

test("D36·D37·D38·D39 입력창의 규칙들 — 턴 없이 확인되는 것들", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const box = page.getByLabel("질문 입력");
  const send = page.getByLabel("보내기");

  // D36 빈 질문은 못 보낸다.
  await expect(send).toBeDisabled();
  await box.fill("   ");
  await expect(send).toBeDisabled();

  // D37 길어지면 늘고, 상한에서 멈춘다.
  //
  // ⚠️ 상한은 **CSS px**인데 `boundingBox()`는 화면 px을 준다. 입력창 상자는
  // `zoom: var(--ui-scale)`으로 커져 있어서(사용자 지시 2026-08-08, 140%)
  // 160 상한이 화면에서는 224로 재진다 — 숫자를 그대로 박아 두면 **배율을
  // 바꿀 때마다 이 줄이 깨진다.** 배율을 읽어 함께 곱한다.
  // 배율은 **상자 자신에게 묻는다**. `--ui-scale` 변수를 어디에 걸어 두었는지에
  // 기대면(지금은 `<html>`이 아니다) 조용히 1로 읽혀 이 줄이 다시 깨진다.
  // `zoom`은 화면 박스만 키우므로 rect/offset 비가 곧 배율이다.
  const scale = await box.evaluate((el) => {
    const h = (el as HTMLElement).offsetHeight;
    return h > 0 ? el.getBoundingClientRect().height / h : 1;
  });
  const h0 = (await box.boundingBox())!.height;
  await box.fill("긴 질문 ".repeat(120));
  await page.waitForTimeout(300);
  const h1 = (await box.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0);
  expect(h1).toBeLessThanOrEqual(160 * scale + 1);

  // D39 Shift+Enter는 줄바꿈, 보내지 않는다.
  await box.fill("첫 줄");
  const before = await page.locator("[data-canvas-item]").count();
  await box.press("Shift+Enter");
  await box.type("둘째 줄");
  await expect(box).toHaveValue(/첫 줄\n둘째 줄/);
  expect(await page.locator("[data-canvas-item]").count()).toBe(before);

  await box.fill("");
});

test("D31·D33·D34 질문을 보내면 곧바로 반응하고, 답이 카드로 놓인다", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const box = page.getByLabel("질문 입력");
  await box.fill("빛의 굴절이 뭐야?");
  await page.getByLabel("보내기").click();

  /**
   * D31: **보내는 순간부터** 무언가 보여야 한다. 도구를 쓰는 턴은 첫 토큰까지
   * 오래 걸리는데, 그 사이가 비면 학생은 렉으로 읽는다(D160).
   */
  await expect(page.getByText(/생각하고 있어요|찾고|읽고/)).toBeVisible({
    timeout: 5000,
  });

  // D33: 답이 카드로 놓인다 — **글이 실제로 있어야** 한다. 껍데기만 생기고
  // 비어 있으면 학생에게는 아무 답도 안 온 것이다.
  await expect(page.locator("[data-canvas-item]")).not.toHaveCount(0, {
    timeout: 120_000,
  });
  await expect
    .poll(
      async () => (await page.locator("[data-canvas-item]").first().innerText()).length,
      { timeout: 120_000 },
    )
    .toBeGreaterThan(50);
  // 턴이 끝나면 생각 중 표시가 사라지고 다시 쓸 수 있다.
  await expect(page.getByText(/생각하고 있어요/)).toBeHidden({ timeout: 120_000 });
  await expect(box).toBeEnabled({ timeout: 120_000 });

  // D34: 카드를 누르면 인용 칩이 붙는다 — 어디에 이어 묻는지 보여야 한다.
  await page.locator("[data-canvas-item]").first().click();
  await page.waitForTimeout(800);
  const quoted = await page.getByLabel("이어 묻기 그만두기").count();
  expect(quoted).toBeGreaterThan(0);
  await page.getByLabel("이어 묻기 그만두기").click();
});

test("D40 답이 도는 동안에는 겹쳐 보낼 수 없다", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const box = page.getByLabel("질문 입력");
  await box.fill("소리는 어떻게 전달돼?");
  await page.getByLabel("보내기").click();
  await page.waitForTimeout(1200);

  // 도는 동안 보내기는 잠긴다 — 두 턴이 겹치면 캔버스가 뒤섞인다.
  await box.fill("또 다른 질문");
  await expect(page.getByLabel("보내기")).toBeDisabled();

  await expect(page.locator("[data-canvas-item]")).not.toHaveCount(0, {
    timeout: 120_000,
  });
  await box.fill("");
});
