import { expect, test, type Page, type Locator } from "@playwright/test";
import { createNote, loginAndOpenCanvas, noteByText, openCanvas } from "./helpers";

/**
 * 카드 태그 조작 E2E (D147) — 지정·이름변경·detach·삭제 + 새로고침 영속.
 *
 * 카드의 현재 태그는 DOM에 직접 드러나지 않으므로(열 라벨은 배치에 흔들린다),
 * TagPicker를 다시 열어 그 태그 행의 aria-checked로 확인한다 — 안정적이다.
 *
 * 두 카드가 한 태그를 공유하게 해서 **detach(이 카드만)** 와 **삭제(세션 전역)** 를
 * 구분해 검증한다.
 */
test.describe.configure({ mode: "serial" });

/** 이 노트의 분류 선택창(TagPicker)을 연다. */
async function openTagPicker(page: Page, note: Locator): Promise<void> {
  await note.hover();
  await note.getByLabel("이 글의 메뉴").click();
  await page.getByRole("menuitem", { name: "분류 변경" }).click();
}

/** 열려 있는 TagPicker에서 새 태그를 지정한다. */
async function assignNewTag(page: Page, note: Locator, tag: string): Promise<void> {
  await openTagPicker(page, note);
  await page.getByRole("button", { name: "새 분류 추가" }).click();
  await page.getByPlaceholder("새 분류 이름").fill(tag);
  await page.getByLabel("분류 추가").click();
}

/** 열려 있는 TagPicker에서 기존 태그를 고른다. */
async function pickTag(page: Page, note: Locator, tag: string): Promise<void> {
  await openTagPicker(page, note);
  await page.getByRole("menuitemradio", { name: tag }).click();
}

async function expectChecked(page: Page, note: Locator, tag: string): Promise<void> {
  await openTagPicker(page, note);
  await expect(page.getByRole("menuitemradio", { name: tag })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
}

test("태그 지정·이름변경·detach·삭제가 되고 새로고침에도 유지된다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const ts = Date.now();
  const A = `태그A-${ts}`;
  const B = `태그B-${ts}`;
  const TAG = `역사${ts}`;
  const RENAMED = `세계사${ts}`;

  const noteA = await createNote(page, A, { x: 340, y: 240 });
  const noteB = await createNote(page, B, { x: 340, y: 460 });

  await test.step("두 카드에 같은 태그를 지정한다", async () => {
    await assignNewTag(page, noteA, TAG);
    await pickTag(page, noteB, TAG); // 기존 태그 재사용
    await expectChecked(page, noteA, TAG);
    await expectChecked(page, noteB, TAG);
  });

  await test.step("태그 이름을 바꾸면 두 카드 모두 반영된다(세션 전역)", async () => {
    await openTagPicker(page, noteA);
    await page.getByLabel(`${TAG} 이름 변경`).click();
    await page.getByLabel("새 분류 이름").fill(RENAMED);
    await page.getByLabel("이름 변경 확정").click();

    await expectChecked(page, noteA, RENAMED);
    await expectChecked(page, noteB, RENAMED); // B도 함께 바뀌었다
  });

  await test.step("새로고침해도 바뀐 이름이 남는다", async () => {
    await page.reload();
    await openCanvas(page);
    await expectChecked(page, noteByText(page, A), RENAMED);
  });

  await test.step("detach — A만 태그를 뗀다, B는 유지", async () => {
    const a = noteByText(page, A);
    await openTagPicker(page, a);
    await page.getByRole("menuitemradio", { name: "분류 없음" }).click();

    await expectChecked(page, a, "분류 없음"); // A는 분류 없음
    await expectChecked(page, noteByText(page, B), RENAMED); // B는 그대로
  });

  await test.step("삭제 — 세션에서 태그를 없앤다(B도 분류 없음)", async () => {
    const b = noteByText(page, B);
    await openTagPicker(page, b);
    await page.getByLabel(`${RENAMED} 삭제`).click();

    // 태그가 목록에서 사라진다.
    await openTagPicker(page, b);
    await expect(page.getByRole("menuitemradio", { name: RENAMED })).toHaveCount(0);
    await expect(page.getByRole("menuitemradio", { name: "분류 없음" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
  });

  await test.step("정리 — 만든 노트를 지운다(세션 누적 방지)", async () => {
    for (const t of [A, B]) {
      const n = noteByText(page, t);
      if ((await n.count()) === 0) continue;
      await n.first().hover();
      await n.first().getByLabel("이 글의 메뉴").click();
      await page.getByRole("menuitem", { name: "삭제" }).click();
      await expect(noteByText(page, t)).toHaveCount(0);
    }
  });
});
