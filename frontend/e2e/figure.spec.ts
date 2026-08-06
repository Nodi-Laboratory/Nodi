import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openSeededFigureSession } from "./helpers";

/**
 * 교과서 도판 이미지 로딩 E2E (D147 후속 버그).
 *
 * 재수화 시 figure.url은 빈 문자열이다(D87: 영속 금지). FigureItem이 그때
 * getFigure로 새 signed URL을 받아야 하는데 그 트리거가 없어 스켈레톤에 갇혔다
 * (canvas_items 영속이 켜지며 드러났다). 여기서는 **url이 빈** 도판 행을 미리
 * 심어 두고, 캔버스를 열었을 때 이미지가 실제로 로드되는지(naturalWidth>0)를
 * 확인한다.
 *
 * 전제: `cd backend && uv run python -m scripts.seed_e2e`
 * (학급 등록 + 학생 개인 세션에 url="" 도판 카드(caption='E2E도판')까지 심는다.)
 */
test("재수화된 교과서 도판이 signed URL을 받아 이미지를 불러온다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openSeededFigureSession(page);

  // 시드 도판이 없는 환경에서는 건너뛴다(계정처럼 이 테스트도 seed가 전제다).
  // 스켈레톤("도판 불러오는 중…")이든 <img>든, 도판 카드가 있어야 검증한다.
  const card = page.locator('[data-canvas-item]').filter({ hasText: "E2E도판" });
  if ((await card.count()) === 0) {
    test.skip(true, "시드 도판 없음 — db seed(class_members + canvas_items figure) 필요");
  }

  const img = page.locator('img[alt="E2E도판"]');
  // url을 비워 저장했으므로 처음엔 스켈레톤 → 효과가 getFigure로 URL을 받으면
  // <img>가 뜬다.
  await expect(img).toBeVisible({ timeout: 20_000 });

  // 실제 로드 여부: 디코드된 자연 폭이 0보다 커야 한다(깨진 이미지는 0).
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
});

test("도판을 좌우 손잡이로 리사이즈해도 이미지만 커지고 캡션은 그대로다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openSeededFigureSession(page);

  const card = page.locator('[data-canvas-item]').filter({ hasText: "E2E도판" });
  if ((await card.count()) === 0) {
    test.skip(true, "시드 도판 없음 — db seed 필요");
  }

  const img = page.locator('img[alt="E2E도판"]');
  await expect(img).toBeVisible({ timeout: 20_000 });

  // 캡션(쪽 번호)의 폰트 크기는 리사이즈와 무관해야 한다 — 미리 재 둔다.
  const caption = card.getByText("교과서 9쪽");
  const capBefore = await caption.boundingBox();
  const imgBefore = await img.boundingBox();
  if (!capBefore || !imgBefore) throw new Error("박스 측정 실패");

  // 도판을 선택하면 손잡이가 뜬다.
  await card.click();
  const east = card.locator('[data-resize-handle="e"]');
  await expect(east).toBeVisible();

  // 동쪽 손잡이를 오른쪽으로 끌어 **폭만** 키운다.
  const hb = await east.boundingBox();
  if (!hb) throw new Error("손잡이 박스 실패");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();

  // 이미지 폭이 커졌다.
  await expect
    .poll(async () => (await img.boundingBox())?.width ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(imgBefore.width + 60);

  // 캡션 글자 크기는 그대로다(높이가 안 변했다).
  const capAfter = await caption.boundingBox();
  expect(Math.abs((capAfter?.height ?? 0) - capBefore.height)).toBeLessThan(2);

  // 손잡이 더블클릭 → 자동 크기로 되돌려 다음 실행을 위해 정리한다.
  await east.dblclick();
});
