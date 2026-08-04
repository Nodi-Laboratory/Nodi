import { expect, test } from "@playwright/test";
import {
  createNote,
  dragBy,
  itemPos,
  loginAndOpenCanvas,
  noteByText,
  openCanvas,
  openFreshSession,
} from "./helpers";

/**
 * 캔버스 카드 조작 + 새로고침 영속 E2E (D147).
 *
 * 핵심 수용 기준: **새로고침해도 옮긴 자리·고친 내용·지운 사실이 유지된다.**
 * 순수 단위 테스트로는 못 잡는 서버 왕복·재수화를 실제 브라우저로 확인한다.
 *
 * 한 세션 상태를 이어 가며 검증하므로 serial(직렬)로 돌린다.
 */
test.describe.configure({ mode: "serial" });

test.describe("카드 드래그·수정·삭제·영속", () => {
  // 실행마다 유일한 본문 — 지난 실행이 남긴 노트와 섞이지 않게 한다.
  const NOTE = `E2E노트-${Date.now()}`;
  const EDITED = `${NOTE}-수정됨`;

  test("드래그하면 새로고침 후에도 옮긴 자리에 있다", async ({ page }) => {
    await loginAndOpenCanvas(page);
    // 빈 대화에서 시작한다 — 지난 실행이 남긴 카드가 `createNote`의 클릭
    // 자리를 덮고 있으면 편집기가 뜨지 않는다(helpers.openFreshSession 참조).
    // 뒤따르는 테스트들은 이 세션을 다시 열어 이어 간다.
    await openFreshSession(page);

    const note = await createNote(page, NOTE);
    const before = await itemPos(note);

    await test.step("드래그로 옮긴다", async () => {
      await dragBy(page, note, 220, 140);
      // 좌표가 갱신될 시간을 준다(드래그 종료 → PATCH → 재렌더).
      await expect
        .poll(async () => (await itemPos(note)).x, { timeout: 10_000 })
        .toBeGreaterThan(before.x + 100);
    });

    const moved = await itemPos(note);
    expect(moved.y).toBeGreaterThan(before.y + 80);

    await test.step("새로고침해도 옮긴 자리가 유지된다", async () => {
      await page.reload();
      await openCanvas(page);
      const reopened = noteByText(page, NOTE);
      await expect(reopened).toBeVisible();
      const after = await itemPos(reopened);
      // 저장된 좌표는 그대로 복원돼야 한다(픽셀 몇 개 오차 허용).
      expect(Math.abs(after.x - moved.x)).toBeLessThan(3);
      expect(Math.abs(after.y - moved.y)).toBeLessThan(3);
    });
  });

  test("수정하면 새로고침 후에도 고친 내용이 남는다", async ({ page }) => {
    await loginAndOpenCanvas(page);
    const note = noteByText(page, NOTE);
    await expect(note).toBeVisible();

    await test.step("더블클릭해 본문을 고친다", async () => {
      await note.dblclick();
      const editor = page.getByLabel("본문 수정");
      await editor.waitFor({ state: "visible" });
      await editor.fill(EDITED);
      await editor.press("Control+Enter");
      await expect(noteByText(page, EDITED)).toBeVisible();
    });

    await test.step("새로고침해도 고친 내용이 남는다", async () => {
      await page.reload();
      await openCanvas(page);
      await expect(noteByText(page, EDITED)).toBeVisible();
    });
  });

  test("삭제하면 새로고침 후에도 사라진 채로 있다", async ({ page }) => {
    await loginAndOpenCanvas(page);
    const note = noteByText(page, EDITED);
    await expect(note).toBeVisible();

    await test.step("메뉴로 삭제한다", async () => {
      await note.hover();
      await note.getByLabel("이 글의 메뉴").click();
      await page.getByRole("menuitem", { name: "삭제" }).click();
      await expect(noteByText(page, EDITED)).toHaveCount(0);
    });

    await test.step("새로고침해도 사라진 채로 있다", async () => {
      await page.reload();
      await openCanvas(page);
      await expect(noteByText(page, EDITED)).toHaveCount(0);
    });
  });
});
