import { expect, test, type Page } from "@playwright/test";

/**
 * D178 E2E — 관리자 펜 표시 실험실.
 *
 * 이 탭의 값어치는 **실제 경로를 태운다**는 데 있다. 그래서 여기서 확인할 것은
 * 화면이 예쁘게 뜨는가가 아니라:
 *
 *   · 학습 화면과 **같은 캔버스 부품**이 떴는가(카드 3 + 도판 + 클립)
 *   · 질문 펜이 곧바로 쥐여지는가
 *   · [읽기]가 **진짜 창구**(`/ink/interpret`)를 부르는가
 *   · 그 결과가 흐름 로그로 펼쳐지는가(모델이 본 그림까지)
 *
 * 사본을 만들었다면 여기서 드러난다 — 사본은 `/ink/interpret`을 안 부른다.
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)과 **관리자 계정**이 필요하다.
 */
test.describe.configure({ mode: "serial" });

const ADMIN_EMAIL = "admin@nodi.local";
const ADMIN_PASSWORD = "nodi1234";

async function openInkLab(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|admin|space)/);

  await page.goto("/admin");
  await page.getByRole("button", { name: "펜 표시" }).click();
  await expect(page.getByText("펜 표시 실험실")).toBeVisible();
  // 배치가 끝나 카드가 자리를 잡을 때까지.
  await expect(page.locator('[data-canvas-item="lab-card-1"]')).toBeVisible({
    timeout: 20_000,
  });
}

/** 캔버스에 획 하나 — 실험실 스테이지 기준 화면 좌표로. */
async function stroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await page.getByTestId("ink-lab-stage").boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 12 });
  await page.mouse.up();
}

test("카드 셋과 곁들이 둘이 학습 화면과 같은 부품으로 뜬다", async ({ page }) => {
  await openInkLab(page);

  // 개념 카드 셋.
  await expect(page.locator('[data-canvas-item="lab-card-1"]')).toContainText("지질학");
  await expect(page.locator('[data-canvas-item="lab-card-2"]')).toContainText("천문학");
  await expect(page.locator('[data-canvas-item="lab-card-3"]')).toContainText("생명공학");

  // 도판과 강의 클립은 **지질학 카드에** 딸린다 (D163).
  await expect(page.locator('[data-canvas-item="lab-figure-1"]')).toBeVisible();
  await expect(page.locator('[data-canvas-item="lab-clip-1"]')).toBeVisible();
  await expect(page.locator('[data-canvas-item="lab-clip-1"]')).toContainText(
    "판 구조론",
  );
});

test("들어오면 질문하는 펜이 쥐여져 있고, 그은 획이 세어진다", async ({ page }) => {
  await openInkLab(page);
  // 도구를 따로 고르지 않아도 곧바로 쓸 수 있어야 한다 — 여기 온 이유가 그것이다.
  await expect(page.getByText(/^획 0$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "읽기" })).toBeDisabled();

  await stroke(page, { x: 160, y: 200 }, { x: 240, y: 260 });
  await expect(page.getByText(/^획 1$/)).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("button", { name: "읽기" })).toBeEnabled();
});

test("읽기가 진짜 창구를 부르고 흐름 로그가 펼쳐진다", async ({ page }) => {
  await openInkLab(page);

  /**
   * 창구는 가로채되 **부르는지는 확인한다.** 사본을 만들었다면 이 라우트가
   * 한 번도 안 걸린다 — 그것이 이 테스트의 요점이다.
   */
  let called = 0;
  let fields: string[] = [];
  await page.route("**/ink/interpret", async (route) => {
    called += 1;
    const raw = route.request().postDataBuffer()?.toString("latin1") ?? "";
    fields = [...raw.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "이거 더 설명해줘",
        marks_note: "화살표가 [카드 1]을 가리킨다. [카드 2]는 닿지 않는다.",
        marks_status: "ok",
        confidence: null,
      }),
    });
  });

  // 지질학 카드를 가로지르게 긋는다 — 접촉 판정이 걸려야 한다.
  const card = (await page.locator('[data-canvas-item="lab-card-1"]').boundingBox())!;
  const stage = (await page.getByTestId("ink-lab-stage").boundingBox())!;
  await stroke(
    page,
    { x: card.x - stage.x + 20, y: card.y - stage.y + 30 },
    { x: card.x - stage.x + card.width - 20, y: card.y - stage.y + 60 },
  );
  await expect(page.getByRole("button", { name: "읽기" })).toBeEnabled();

  await page.getByRole("button", { name: "읽기" }).click();

  // **결과가 맨 위에 바로 보인다** — 스크롤 없이(사용자 지적 2026-08-05).
  await expect(page.getByText("손글씨 (OCR)")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("짚은 카드 (기하)")).toBeVisible();
  await expect(page.getByText("표시 설명 (비전)")).toBeVisible();

  // 흐름 로그가 단계별로 펼쳐진다.
  await expect(page.getByText("질문 획")).toBeVisible();
  await expect(page.getByText("카드 선정")).toBeVisible();
  await expect(page.getByText("도식 렌더")).toBeVisible();
  await expect(page.getByText("두 모델 (동시)")).toBeVisible();
  await expect(page.getByText("SOLAR에 간 블록")).toBeVisible();
  // SOLAR 단계까지 붙어 있어야 한다 — 실험실의 마지막 칸이다.
  await expect(page.getByText("SOLAR 답변")).toBeVisible();

  // 모델이 본 그림이 실제로 그려진다 — 표만으로는 못 잡는 것이 여기 있다.
  await expect(page.getByAltText("OCR로 가는 그림 (획만)")).toBeVisible();
  await expect(page.getByAltText("비전 모델이 보는 그림")).toBeVisible();

  // 응답이 그대로 보인다.
  await expect(page.getByText("이거 더 설명해줘")).toBeVisible();
  await expect(page.getByText(/\[카드 1\]/).first()).toBeVisible();

  expect(called).toBe(1);
  expect(fields).toContain("ink_png");
  expect(fields).toContain("scene_png");
  expect(fields).toContain("cards");
});
