import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

/**
 * EBS 강의 클립 추천이 **화면에 보이는가** (D149 기능 · D163 배치).
 *
 * 단위 테스트로는 못 잡는 것이 둘이다:
 *
 *   1. 검색이 실제로 돌아 done 이벤트에 clips가 실리는가 (ReAct 스킬 선택 →
 *      Qdrant → RLS 재조회까지 진짜로 왕복한다).
 *   2. 그 결과가 **카드 옆, 화면 안**에 그려지는가. 예전에는 태그 없는 열로
 *      밀려나 235% 줌에서 화면 밖이었다 — 검색은 되는데 학생 눈에는 아무것도
 *      안 뜬 것과 같았고, 이 결함은 화면에도 로그에도 안 드러났다.
 *
 * 전제(README 빠른 시작 + 시드):
 *   - 로컬 스택(docker compose · 백엔드 · 프론트)
 *   - **시드**: `cd backend && uv run python -m scripts.seed_e2e`
 *     학급·교과서 도판·강의 클립·클립 썸네일을 한 번에 심는다. 예전에는 이
 *     전제가 누군가의 기계에만 있어서 다른 기계에서는 그냥 실패했다
 *     (실측 2026-08-07). 상태만 보려면 `--check`.
 */

/** 시드된 학급 — 교과서 도판 + EBS 강의 패키지가 둘 다 켜져 있다. */
const CLASS_ID = "94f21035-f19e-4b0f-91bd-84aa69d65330";
/** 교과서(실험 안전)와 강의 클립 양쪽에 걸리는 질문. */
const QUESTION = "실험실에서 안전하게 실험하려면 어떻게 해야 해?";

/** 아이템의 world 좌표·크기. 배치 엔진이 정한 값 그대로다. */
async function box(el: Locator) {
  return el.evaluate((n) => {
    const e = n as HTMLElement;
    return {
      x: parseFloat(e.style.left) || 0,
      y: parseFloat(e.style.top) || 0,
      w: e.offsetWidth,
      h: e.offsetHeight,
    };
  });
}

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

/**
 * 학급 캔버스를 열고 **빈 새 대화**로 들어간다.
 *
 * 앞 세션의 카드가 남아 있으면 "클립이 어느 카드 옆인가"를 판정할 기준이
 * 애매해진다. 대화 목록(좌측 서랍)의 "새 대화"로 매번 새로 판다.
 */
async function openFreshSession(page: Page) {
  await page.goto(`/space/${CLASS_ID}`);
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "대화 목록 열기" }).click();
  // 목록 **항목**도 제목이 비면 "새 대화"로 보인다 — 헤더 버튼만 집는다.
  await page.getByTitle("새 대화").click();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("[data-canvas-item]")).toHaveCount(0, { timeout: 20_000 });
  // 서랍이 캔버스를 가리면 클릭·스크린샷이 어긋난다. 닫고 시작한다.
  const close = page.getByRole("button", { name: "닫기" }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

test.describe("EBS 강의 클립 추천", () => {
  // 답 생성은 LLM 왕복이라 기본 60초로는 모자란다.
  test.setTimeout(180_000);

  test("질의하면 클립이 개념 카드 옆·화면 안에 뜬다", async ({ page }) => {
    await login(page);

    // 새 대화에서 시작한다 — 앞 세션의 카드가 남아 있으면 "옆에 붙었나"를
    // 판정할 기준 카드가 애매해진다.
    await openFreshSession(page);

    await page.getByLabel("질문 입력").fill(QUESTION);
    await page.getByRole("button", { name: "보내기" }).click();

    // --- 1. 검색이 돌아 클립 카드가 생겼나 --------------------------------
    const clips = page.locator("[data-canvas-clip]");
    await expect(clips.first()).toBeVisible({ timeout: 150_000 });
    const clipCount = await clips.count();
    expect(clipCount).toBeGreaterThan(0);

    // 클립 카드가 무엇인지 읽히는가 — 라벨·타임라인·링크.
    const first = clips.first();
    await expect(first).toContainText("EBS 강의");
    await expect(first).toContainText(/\d+:\d{2}/);
    const link = first.getByRole("link", { name: /EBS에서 이어 보기/ });
    await expect(link).toHaveAttribute("href", /^https:\/\//);
    await expect(link).toHaveAttribute("target", "_blank");

    // --- 2. 개념 카드 **옆**인가 -------------------------------------------
    const card = page
      .locator("[data-canvas-item]:not([data-canvas-clip]):not([data-canvas-figure])")
      .first();
    await expect(card).toBeVisible();
    const cardBox = await box(card);
    const clipBox = await box(first);

    // 오른쪽에 있다.
    expect(clipBox.x).toBeGreaterThanOrEqual(cardBox.x + cardBox.w);
    // 그리고 **가깝다**. 열 하나 건너(COL_GAP=760)면 딸린 것으로 안 읽힌다 —
    // 예전 UNTAGGED 열 배치가 정확히 그 상태였다.
    expect(clipBox.x - (cardBox.x + cardBox.w)).toBeLessThan(760);
    // 카드 윗변 근처에서 시작한다(카드 아래로 흘러내리지 않는다).
    expect(clipBox.y).toBeLessThan(cardBox.y + cardBox.h);

    // --- 3. 실제로 **화면 안에** 있나 --------------------------------------
    //
    // 이 단언이 이 파일의 핵심이다. 좌표가 카드 옆이어도 카메라가 235%로
    // 카드만 꽉 채우고 있으면 학생 눈에는 아무것도 안 뜬 것과 같다(D163).
    //
    // 폴링하는 이유: 카메라는 답을 다 타이핑한 **뒤에** 딸린 것까지 담는
    // 배율로 다시 날아가고(useCanvasStream), 스프링 감쇠까지 시간이 걸린다.
    const vp = page.viewportSize()!;
    await expect
      .poll(
        async () => {
          const r = await first.boundingBox();
          if (!r) return false;
          return (
            r.x >= 0 && r.y >= 0 &&
            r.x + r.width <= vp.width && r.y + r.height <= vp.height
          );
        },
        { timeout: 60_000, message: "클립 카드가 화면 안으로 들어오지 않았다" },
      )
      .toBe(true);

    await page.screenshot({ path: "test-results/d163-clip-beside-card.png", fullPage: false });
  });

  test("교과서 도판도 같은 자리 규칙으로 뜬다", async ({ page }) => {
    await login(page);
    await openFreshSession(page);

    await page.getByLabel("질문 입력").fill(QUESTION);
    await page.getByRole("button", { name: "보내기" }).click();

    const figures = page.locator("[data-canvas-figure]");
    await expect(figures.first()).toBeVisible({ timeout: 150_000 });

    // 이미지가 실제로 그려졌나 — signed URL 재발급(D87)까지 도는지 본다.
    // src만 보면 깨진 이미지도 통과한다.
    const img = figures.first().locator("img").first();
    await expect(img).toBeVisible();
    await expect
      .poll(async () => img.evaluate((n) => (n as HTMLImageElement).naturalWidth), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    const card = page
      .locator("[data-canvas-item]:not([data-canvas-clip]):not([data-canvas-figure])")
      .first();
    const cardBox = await box(card);
    const figBox = await box(figures.first());
    expect(figBox.x).toBeGreaterThanOrEqual(cardBox.x + cardBox.w);
    expect(figBox.x - (cardBox.x + cardBox.w)).toBeLessThan(760);

    await page.screenshot({ path: "test-results/d163-figure-beside-card.png" });
  });

  test("새로고침해도 클립이 카드 옆에 남는다", async ({ page }) => {
    await login(page);
    await openFreshSession(page);

    await page.getByLabel("질문 입력").fill(QUESTION);
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.locator("[data-canvas-clip]").first()).toBeVisible({
      timeout: 150_000,
    });
    const clipId = await page
      .locator("[data-canvas-clip]")
      .first()
      .getAttribute("data-canvas-clip");

    // 저장이 끝날 시간을 준다(턴 종료 후 일괄 저장 + parent 재연결).
    await page.waitForTimeout(4_000);
    await page.reload();
    await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });

    // 재수화 후에도 같은 클립이, 여전히 카드 옆에 있다. page_url은 안정적이라
    // 그대로 영속된다(D149) — 도판과 달리 재발급이 없다.
    const same = page.locator(`[data-canvas-clip="${clipId}"]`);
    await expect(same).toBeVisible({ timeout: 30_000 });
    const card = page
      .locator("[data-canvas-item]:not([data-canvas-clip]):not([data-canvas-figure])")
      .first();
    const cardBox = await box(card);
    const clipBox = await box(same);
    expect(clipBox.x).toBeGreaterThanOrEqual(cardBox.x + cardBox.w);
    expect(clipBox.x - (cardBox.x + cardBox.w)).toBeLessThan(760);
  });
});
