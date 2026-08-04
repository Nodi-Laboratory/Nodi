import { expect, test, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

/**
 * D167 — **교과서 도판은 그림이 보여야 한다.**
 *
 * signed URL은 만료되므로 저장하지 않는다(D87). 그래서 도판 아이템은 주소가
 * **없는 채로 존재하는 것이 정상**이고, 그때 `getFigure`로 받아 오는 것이
 * FigureItem의 일이다. 그 트리거가 `<img onError>`밖에 없었는데, 주소가 없으면
 * `<img>`를 안 그리므로 onError가 일어날 수 없었다 — 도판이 "도판 불러오는
 * 중…"에 **영원히** 갇혔다(사용자 보고 2026-08-04, "미터원기가 뭐야?").
 *
 * `figure.spec.ts`가 같은 결함을 노리지만 심어 둔 시드 행이 없으면 **조용히
 * skip**한다 — 그래서 못 잡았다. 이 스펙은 진짜 턴을 태워 도판을 만들므로
 * 건너뛰지 않는다.
 *
 * 전제: e2e-student가 아래 학급에 속하고, 그 학급에 도판 인덱싱이 끝난
 * 교과서가 켜져 있다(lecture-clip.spec과 같은 시드).
 */

/** 시드된 학급 — 교과서 도판이 켜져 있다. */
const CLASS_ID = "94f21035-f19e-4b0f-91bd-84aa69d65330";
/** 교과서 도판에 확실히 걸리는 질문(사용자가 보고한 그 질문이다). */
const QUESTION = "미터원기가 뭐야?";

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/);
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }
}

/** 도판이 **그려졌나**. src만 보면 깨진 이미지도 통과하므로 디코드 폭을 본다. */
async function drawn(page: Page): Promise<number> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-canvas-figure] img")].filter(
      (n) => (n as HTMLImageElement).naturalWidth > 0,
    ).length,
  );
}

test("도판은 저장 뒤에도 · 새로고침 뒤에도 그림이 보인다", async ({ page }) => {
  test.setTimeout(300_000);

  await login(page);
  await page.goto(`/space/${CLASS_ID}`);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "대화 목록 열기" }).click();
  await page.getByTitle("새 대화").click();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-canvas-item]")).toHaveCount(0, { timeout: 20_000 });
  await page.keyboard.press("Escape");

  await page.getByLabel("질문 입력").fill(QUESTION);
  await page.getByRole("button", { name: "보내기" }).click();

  const figures = page.locator("[data-canvas-figure]");
  await expect(figures.first()).toBeVisible({ timeout: 150_000 });
  const total = await figures.count();
  expect(total).toBeGreaterThan(0);

  /**
   * ① 답이 **저장된 뒤에도** 그림이 남아 있나.
   *
   * 여기가 결함의 자리였다. 저장이 끝나면 서버 행이 로컬 아이템을 대체하는데
   * 그 행에는 url이 없어서(D87), 생성 1.3초 뒤 살아 있던 이미지가 스켈레톤으로
   * 되돌아갔다. 그래서 "떴다"가 아니라 **"떠 있는 채로 남았다"**를 재야 한다 —
   * 저장 왕복이 끝날 시간을 준 뒤 확인한다.
   */
  await expect
    .poll(async () => page.locator('[data-writing="1"]').count(), { timeout: 180_000 })
    .toBe(0);
  await page.waitForTimeout(4_000);   // 저장 → replaceTemp 왕복이 끝날 시간

  await expect
    .poll(() => drawn(page), { timeout: 30_000, message: "저장 뒤 도판 그림이 사라졌다" })
    .toBe(total);

  /**
   * ② 새로고침(재수화) 뒤에도 그림이 보이나.
   *
   * 재수화는 언제나 url이 빈 상태에서 시작하므로, 받아 오는 경로가 없으면
   * 여기서 100% 스켈레톤이다.
   */
  await page.reload();
  await expect(figures.first()).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => drawn(page), { timeout: 30_000, message: "새로고침 뒤 도판 그림이 없다" })
    .toBe(total);

  // ③ 스켈레톤 문구가 남아 있으면 안 된다 — 학생이 보는 것이 그 문구다.
  await expect(page.getByText("도판 불러오는 중…")).toHaveCount(0);
  await expect(page.getByText("도판을 불러오지 못했어요")).toHaveCount(0);
});
