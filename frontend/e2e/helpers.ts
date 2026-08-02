import { expect, type Page, type Locator } from "@playwright/test";

/**
 * E2E 공용 헬퍼 (D147 검증).
 *
 * 계정은 시드하지 않으므로 CLI로 만든 학생 계정을 쓴다:
 *   uv run python -m app.cli create-user e2e-student@nodi.test 'e2ePass!234' --role student
 */
export const E2E_EMAIL = "e2e-student@nodi.test";
export const E2E_PASSWORD = "e2ePass!234";

/** 표준 UUID — 임시 id(local-note-*)와 구분한다. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 로그인 → (필요 시 온보딩) → 개인 세션 캔버스로 들어가 준비될 때까지 기다린다. */
export async function loginAndOpenCanvas(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();

  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/);
  // 첫 로그인이면 온보딩을 거친다 — 학급 없이 시작한다.
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }

  await openCanvas(page);
}

/** 개인 세션 캔버스로 이동해 세션이 바인딩(AskBar 활성)될 때까지 기다린다. */
export async function openCanvas(page: Page): Promise<void> {
  await page.goto("/space/personal");
  // 세션이 붙기 전에는 질문창이 비활성이다("세션을 준비하는 중이에요").
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 캔버스 스테이지가 떴는지 확인.
  await expect(page.locator(".canvas2")).toBeVisible();
}

/**
 * 손으로 글 노트를 하나 만들고 텍스트를 저장한 뒤, **서버에 저장(진짜 id)**
 * 될 때까지 기다려 그 노트 Locator를 돌려준다.
 *
 * 저장을 기다리는 이유: 저장 전(local-note-*) 아이템을 끌면 승격 경로가
 * 얽힌다. UUID로 바뀐 뒤 끌어야 드래그가 곧장 PATCH로 영속된다.
 */
export async function createNote(page: Page, text: string): Promise<Locator> {
  // 글쓰기 도구 선택 후 빈 캔버스를 클릭 → 그 자리에 편집 중인 빈 노트가 생긴다.
  await page.getByRole("button", { name: "글 쓰기" }).click();
  await page.locator(".canvas2").click({ position: { x: 380, y: 280 } });

  const editor = page.getByLabel("본문 수정");
  await editor.waitFor({ state: "visible" });
  await editor.fill(text);
  // Ctrl+Enter로 커밋(= blur). 노트 도구는 생성 직후 선택 도구로 돌아간다.
  await editor.press("Control+Enter");

  const note = noteByText(page, text);
  await expect(note).toBeVisible();
  // 서버 저장이 끝나 data-canvas-item이 UUID로 바뀔 때까지 기다린다.
  await expect
    .poll(async () => note.getAttribute("data-canvas-item"), { timeout: 15_000 })
    .toMatch(UUID_RE);
  return note;
}

/** 본문 텍스트로 캔버스 아이템을 찾는다. */
export function noteByText(page: Page, text: string): Locator {
  return page.locator("[data-canvas-item]").filter({ hasText: text });
}

/** 아이템의 world 좌표(인라인 left/top). 배치·영속의 단위다. */
export async function itemPos(note: Locator): Promise<{ x: number; y: number }> {
  return note.evaluate((el) => ({
    x: parseFloat((el as HTMLElement).style.left) || 0,
    y: parseFloat((el as HTMLElement).style.top) || 0,
  }));
}

/**
 * 아이템을 화면상 (dx, dy)만큼 끈다. 커스텀 pointer 핸들러라 실제 마우스
 * 입력을 단계적으로 보낸다(임계 4px를 넘겨 클릭이 아니라 드래그로 인식되게).
 */
export async function dragBy(page: Page, note: Locator, dx: number, dy: number): Promise<void> {
  const box = await note.boundingBox();
  if (!box) throw new Error("아이템 박스를 찾지 못했습니다");
  const cx = box.x + Math.min(box.width / 2, 40);
  const cy = box.y + Math.min(box.height / 2, 20);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 5 });
  await page.mouse.move(cx + dx, cy + dy, { steps: 5 });
  await page.mouse.up();
}
