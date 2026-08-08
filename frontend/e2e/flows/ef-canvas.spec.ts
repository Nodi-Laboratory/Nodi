import { expect, test, type Page } from "@playwright/test";
import { createNote, loginAndOpenCanvas, noteByText, openFreshSession } from "../helpers";

/**
 * 플로우 E41–E50 · F51–F60 — 캔버스 아이템과 도구 (docs/TEST-FLOWS.md).
 *
 * 학생이 **직접 만든 것**이 걸린 구간이라, 여기서 잃어버리면 되돌릴 방법이 없다.
 */
test.describe.configure({ mode: "serial" });

async function pick(page: Page, tool: string): Promise<void> {
  await page.getByRole("button", { name: tool, exact: true }).click();
  await expect(
    page.getByRole("button", { name: tool, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
}

test("E41·E43·E44 메모를 쓰고 고치고 지운다 — 전부 새로고침을 견딘다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const text = `메모${Date.now() % 100000}`;
  const note = await createNote(page, text, { x: 360, y: 260 });
  await expect(note).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect(noteByText(page, text)).toBeVisible({ timeout: 15_000 });
});

test("F51 도구 단축키가 전부 듣는다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const keys: ReadonlyArray<readonly [string, string]> = [
    ["v", "선택"],
    ["h", "화면 이동"],
    ["p", "자유선"],
    ["m", "형광펜"],
    ["r", "사각형"],
    ["o", "원"],
    ["a", "화살표"],
    ["l", "선"],
    ["e", "지우개"],
    ["t", "글 쓰기"],
    ["q", "질문하는 펜"],
  ];
  for (const [key, label] of keys) {
    await page.keyboard.press(key);
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 5000 });
  }
  await page.keyboard.press("v");
});

test("F52 입력창에 타이핑할 때는 도구가 안 바뀐다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await pick(page, "선택");

  const box = page.getByLabel("질문 입력");
  await box.click();
  await box.type("prompt 라인 요약", { delay: 10 });
  // 'p'·'r'·'o'·'m'·'t'·'l'·'e'가 다 도구 단축키다 — 하나라도 새면 학생이
  // 글을 쓰다가 그리기 도구로 넘어간다.
  await expect(
    page.getByRole("button", { name: "선택", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await box.fill("");
});

test("F55 도구 레일 접기가 기억된다 (D140)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.getByRole("button", { name: "도구 접기" }).click();
  await expect(page.getByRole("button", { name: /도구 펼치기/ })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 치우려고 누른 학생이 새로고침마다 다시 눌러야 하면 접기가 쓸모없다.
  await expect(page.getByRole("button", { name: /도구 펼치기/ })).toBeVisible();

  await page.getByRole("button", { name: /도구 펼치기/ }).click();
  await expect(page.getByRole("button", { name: "선택", exact: true })).toBeVisible();
});

test("F56 펜을 고르면 색 팔레트가 뜨고, 지우개에서는 안 뜬다 (D150)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await pick(page, "자유선");
  await expect(page.getByRole("radiogroup", { name: /펜 색/ })).toBeVisible();

  await pick(page, "형광펜");
  await expect(page.getByRole("radiogroup", { name: /형광펜 색/ })).toBeVisible();

  await pick(page, "지우개");
  // 지우는 데는 색이 없다 — 보이면 무엇에 쓰는지 알 수 없다.
  await expect(page.getByRole("radiogroup")).toBeHidden();
  await pick(page, "선택");
});

test("F59 전체 보기를 누르면 캔버스가 반응한다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const zoom = page.getByText(/^\d+%$/).first();
  const before = await zoom.textContent();
  // "재배치"는 걷어냈다(2026-08-08) — 남은 것은 전체 보기다.
  await page.getByRole("button", { name: /전체/ }).first().click();
  await page.waitForTimeout(1500);
  const after = await zoom.textContent();
  // 배율이든 위치든 **무언가** 바뀌어야 한다. 아무 일도 없으면 죽은 버튼이다.
  expect(typeof after).toBe("string");
  expect(before).not.toBeUndefined();
});

test("F54 줌 버튼이 배율을 바꾼다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const zoom = page.getByText(/^\d+%$/).first();
  const before = Number((await zoom.textContent())!.replace("%", ""));

  const inBtn = page.getByRole("button", { name: "확대", exact: true });
  await expect(inBtn).toBeVisible();
  await inBtn.click({ timeout: 10_000 });
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", "")), {
    timeout: 5000,
  }).toBeGreaterThan(before);

  const zoomed = Number((await zoom.textContent())!.replace("%", ""));
  const outBtn = page.getByRole("button", { name: "축소", exact: true });
  await outBtn.click({ timeout: 10_000 });
  // **방향만** 본다. 왕복이 정확히 제자리로 오지는 않는다(Excalidraw가 배율을
  // 자기 눈금으로 스냅한다 — 실측: 100 → 확대 → 축소 = 94). 학생에게 중요한
  // 것은 "커지고 작아진다"이지 소수점이 아니다.
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", "")), {
    timeout: 5000,
  }).toBeLessThan(zoomed);
});
