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
 * 빈 대화를 하나 열어 캔버스를 비운다.
 *
 * `createNote`는 캔버스의 **고정 좌표**를 클릭해 노트를 만든다. 개인 세션은
 * 지난 실행이 남긴 글로 차 있어서 그 자리가 이미 카드에 덮여 있으면 클릭이
 * 카드 선택으로 먹히고 편집기가 뜨지 않는다 — 실측 2026-08-04: 이 이유로
 * `canvas.spec`·`tag.spec`이 둘 다 createNote에서 타임아웃했다. 세션을 새로
 * 열면 매 실행이 같은 조건에서 시작한다.
 */
export async function openFreshSession(page: Page): Promise<void> {
  /**
   * **전환이 끝날 때까지 기다린다.**
   *
   * 예전에는 "아이템 0개 + 질문창 활성"으로 판정했는데, 그 둘은 **이전 빈
   * 대화에서도 참**이라 아무것도 확인하지 못했다. 그 사이에 파일을 붙이면
   * 앞 대화로 들어갔다(실측 2026-08-05). 대화 id가 실제로 바뀐 것을 본다.
   */
  const before = await page.locator(".canvas2").getAttribute("data-session");
  await page.getByLabel("대화 목록 열기").click();
  // 목록의 세션 행에도 "새 대화"라는 글자가 뜬다(제목 없는 세션의 기본 이름).
  // 만드는 버튼은 title 속성으로 정확히 집는다.
  await page.locator('button[title="새 대화"]').click();
  await expect(page.locator("[data-canvas-item]")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => page.locator(".canvas2").getAttribute("data-session"), {
      timeout: 30_000,
    })
    .not.toBe(before);
  // 서랍을 닫아 캔버스를 가리지 않게 한다.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/**
 * 손으로 글 노트를 하나 만들고 텍스트를 저장한 뒤, **서버에 저장(진짜 id)**
 * 될 때까지 기다려 그 노트 Locator를 돌려준다.
 *
 * 저장을 기다리는 이유: 저장 전(local-note-*) 아이템을 끌면 승격 경로가
 * 얽힌다. UUID로 바뀐 뒤 끌어야 드래그가 곧장 PATCH로 영속된다.
 */
export async function createNote(
  page: Page,
  text: string,
  pos: { x: number; y: number } = { x: 380, y: 280 },
): Promise<Locator> {
  // 글쓰기 도구 선택 후 빈 캔버스를 클릭 → 그 자리에 편집 중인 빈 노트가 생긴다.
  await page.getByRole("button", { name: "글 쓰기" }).click();
  await page.locator(".canvas2").click({ position: pos });

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

/**
 * 시드가 심어 둔 **도판 세션**을 이름으로 골라 연다 (D200).
 *
 * `/space/personal`은 가장 최근 대화를 여는데, 앞선 스펙들이 새 대화를 만들면
 * 그 세션이 더 최신이 된다 — 그러면 도판 스펙이 시드 카드를 못 보고 조용히
 * 건너뛴다. **혼자 돌릴 때는 되고 전체로 돌리면 안 되는** 종류의 흔들림이라,
 * 순서에 기대지 않고 목록에서 직접 고른다.
 */
export async function openSeededFigureSession(page: Page): Promise<void> {
  await page.goto("/space/personal");
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("대화 목록 열기").click();
  const row = page.getByRole("dialog").getByText("E2E 도판 세션").first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-canvas-item]")).not.toHaveCount(0, {
    timeout: 20_000,
  });
}
