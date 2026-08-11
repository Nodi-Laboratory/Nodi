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

  /**
   * **앞 테스트의 획을 지우고 시작한다** (2026-08-09).
   *
   * 학습 캔버스는 매번 빈 대화에서 시작하지만(`openFreshSession`) 실험실은
   * 고정 무대라 **씬이 그대로 남는다** — Excalidraw가 요소를 저장·복원하기
   * 때문이다(D176의 `customData.nodiAsk`가 도구를 오가도 살아남는 그 성질).
   *
   * 남은 획이 다음 테스트를 실제로 깨뜨린다: 카드 위에 겹쳐 있으면 새 획이
   * 그 요소에 먹혀 **획 수가 0으로 남고** `읽기`가 잠긴 채였다(실측: 파일을
   * 통째로 돌리면 뒤에 오는 테스트가 그 이유로 실패했다).
   */
  const wipe = page.getByTitle("획 지우기");
  if (await wipe.isEnabled().catch(() => false)) {
    await wipe.click();
    await expect(page.getByText(/^획 0$/)).toBeVisible({ timeout: 5000 });
  }

  /**
   * **펜이 실제로 쥐여질 때까지 기다린다** (2026-08-10).
   *
   * 이 파일의 세 번째 시험이 5번 중 3번 실패했다. 실패 모드는 늘 "획 0"이고,
   * 빈 곳에 긋는 두 번째 시험은 늘 통과했다 — 차이는 **시작점이 카드 위냐**다.
   *
   * 실험실은 펜을 프레임을 넘겨 쥐여 준다(`InkLabTab`의 그 주석 참조). 그런데
   * `activeTool`이 `askpen`이 되는 조건은 **Excalidraw가 되돌려주는 도구가
   * freedraw인 것**이라(`useExcalidrawBridge`), 그 왕복이 끝나기 전 몇 프레임
   * 동안은 아직 `selection`이다. 그동안 오버레이가 포인터를 가져가므로
   * (`isPassThroughTool`) 카드 위에서 시작한 획은 카드에 먹혀 사라진다.
   *
   * 실측(2026-08-10): 같은 페이지에서 카드 위에 여섯 번 그으면 **첫 번째만**
   * 아이템의 `pointer-events`가 `auto`이고 나머지는 `none`이다.
   *
   * 그래서 획 수나 시간이 아니라 **그 조건 자체**를 기다린다. 사람은 이 창을
   * 못 맞출 만큼 느리지만(몇십 ms), 자동 시험은 늘 그 순간에 도착한다.
   */
  await expect
    .poll(
      () =>
        page
          .locator('[data-canvas-item="lab-card-1"]')
          .evaluate((el) => getComputedStyle(el).pointerEvents),
      { timeout: 10_000 },
    )
    .toBe("none");
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
