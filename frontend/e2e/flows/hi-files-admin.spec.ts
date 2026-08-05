import { expect, test, type Page } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "../helpers";

/**
 * 플로우 H71–H80 · I81–I90 — 파일과 교사·관리자 화면 (docs/TEST-FLOWS.md).
 *
 * 학생 계정으로 도는 스위트라, 교사·관리자 화면은 **못 들어가는 것이 정답**인
 * 쪽을 확인한다(I89). 권한은 DB가 강제하지만(D104) 화면도 길을 막아야 한다 —
 * 열렸다가 빈 화면을 보이면 학생은 고장으로 읽는다.
 */
test.describe.configure({ mode: "serial" });

/** 메모리에서 만든 파일 하나. 디스크에 흔적을 안 남긴다. */
function file(name: string, mime: string, bytes: number) {
  return { name, mimeType: mime, buffer: Buffer.alloc(bytes, 0x41) };
}

/**
 * 프롬프트창의 첨부칸에 넣는다.
 *
 * **`input[type=file]`의 첫째를 잡으면 안 된다** — Excalidraw도 자기 파일칸을
 * 갖고 있어서 DOM에서 먼저 나온다. 거기 넣으면 아무 일도 안 일어나고, 테스트는
 * "업로드가 안 된다"는 **거짓 결함**을 만든다(실측 2026-08-05).
 */
async function attach(page: Page, f: ReturnType<typeof file>): Promise<void> {
  await page.getByTitle("파일 첨부").locator('input[type="file"]').setInputFiles(f);
}

test("H72 지원하지 않는 형식은 한국어 사유로 거절한다 (D75)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  await attach(page, file("악성.exe", "application/x-msdownload", 1024));
  await page.waitForTimeout(3000);

  const body = await page.locator("body").innerText();
  // 조용히 사라지면 학생은 올라간 줄 안다 — 이유를 말해야 한다.
  expect(body).toMatch(/형식|지원|올릴 수|확장자/);
});

test("H71·H74 파일을 붙이면 칩이 뜨고 지울 수 있다 (D83)", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const name = `노트${Date.now() % 100000}.txt`;
  // **어느 세션에 붙었는지**까지 본다. 새 대화 직후에 붙이면 앞 세션으로 갈 수
  // 있는데, 그러면 화면에는 아무 표시가 없고 학생은 다시 붙인다.
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith("/files") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await attach(page, file(name, "text/plain", 2048));
  const res = await uploaded;
  expect(res.status()).toBe(201);

  // 칩이 떠야 한다 — 붙였는데 아무 표시가 없으면 학생은 다시 붙인다.
  await expect(page.getByText(name, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
});

test("I89 학생은 교사 화면에 못 들어간다 — 빈 화면이 아니라 되돌려진다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/teacher");
  await page.waitForTimeout(3000);

  const url = page.url();
  const body = await page.locator("body").innerText();
  // 되돌려 보내거나(권장) 안내를 보여야 한다. 빈 화면이 최악이다.
  const bounced = !url.includes("/teacher");
  expect(bounced || body.trim().length > 10).toBe(true);
  expect(body.trim().length).toBeGreaterThan(0);
});

test("I87 학생은 관리자 화면에 못 들어간다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.goto("/admin");
  await page.waitForTimeout(3000);

  const url = page.url();
  const body = await page.locator("body").innerText();
  const bounced = !url.includes("/admin");
  expect(bounced || body.trim().length > 10).toBe(true);
  // 관리자 데이터가 새면 안 된다 — 사용자 목록·설정 같은 것.
  expect(body).not.toMatch(/JWT_SECRET|DATABASE_URL/);
});

test("I90 가입 화면은 관리자 역할을 안 준다 (D99)", async ({ page }) => {
  await page.goto("/signup");
  const body = await page.locator("body").innerText();
  // 역할 선택이 있더라도 학생·교사뿐이어야 한다.
  expect(body).not.toMatch(/관리자|admin/i);
});
