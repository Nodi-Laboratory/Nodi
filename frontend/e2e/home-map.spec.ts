import { expect, test } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD } from "./helpers";

/**
 * 홈 개념 지도 (D189).
 *
 * 지도는 **캔버스 한 장**이라 DOM으로는 아무것도 안 보인다 — 점이 그려졌는지,
 * 누르면 옮겨 가는지는 실제로 태워 봐야 안다. 순수 계산은
 * `lib/home/conceptLayout.test.ts`가 지키고, 여기는 배선을 확인한다.
 */

async function login(page: import("@playwright/test").Page) {
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

test("홈에 개념 지도가 그려지고, 개념을 누르면 그 대화로 간다", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto("/home");

  await expect(page.getByRole("heading", { name: /개념 지도/ })).toBeVisible();

  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  // 힘 배치가 자리를 잡을 시간을 준다.
  await page.waitForTimeout(3000);

  // **빈 캔버스가 아니어야 한다.** 점이 하나도 없으면 회색 판과 구분되지 않고,
  // 그 상태로도 위 단언은 전부 통과한다.
  const painted = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let on = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) on++;
    return on;
  });
  expect(painted, "지도가 비어 있다").toBeGreaterThan(500);

  // 개념을 눌러 그 대화로 이동. 어느 점이 있는지 모르므로 가운데에서
  // 나선으로 훑어 실제로 노드가 있는 자리를 찾는다.
  const box = await canvas.boundingBox();
  if (!box) throw new Error("캔버스를 찾지 못했습니다");
  let moved = false;
  for (let i = 0; i < 260 && !moved; i++) {
    const a = i * 0.5;
    const rad = 4 + i * 1.6;
    const x = box.x + box.width / 2 + Math.cos(a) * rad;
    const y = box.y + box.height / 2 + Math.sin(a) * rad;
    if (x < box.x + 4 || x > box.x + box.width - 4) continue;
    if (y < box.y + 4 || y > box.y + box.height - 4) continue;
    await page.mouse.move(x, y);
    // 툴팁이 뜨면 그 자리에 개념이 있다는 뜻이다.
    if (await page.getByText("눌러서 이동").isVisible().catch(() => false)) {
      await page.mouse.click(x, y);
      moved = true;
    }
  }
  expect(moved, "지도에서 개념을 하나도 못 짚었다").toBe(true);
  await page.waitForURL(/\/space\//, { timeout: 30_000 });
});

test("개념이 없으면 무엇을 하면 되는지 말해 준다", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  // 빈 상태는 개념이 0건일 때만 뜬다 — 응답을 비워 그 화면만 확인한다.
  // (계정을 비우면 다른 스펙이 쓰는 데이터가 사라진다.)
  await page.route("**/api/home/concept-map", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [], edges: [], sessions: [] }),
    }),
  );
  await page.goto("/home");
  await expect(page.getByText("아직 지도에 올릴 개념이 없습니다")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("link", { name: "첫 대화 시작하기" })).toBeVisible();
});

/* ─────────────────────────── D191 — 대화 목록 · 확대 ─────────────────────── */

/**
 * 지도에 무엇을 띄울지 고르는 목록 (D191).
 *
 * 응답을 **못 박아서** 태운다. 진짜 계정 데이터로 하면 폴더가 몇 개인지, 어느
 * 대화에 개념이 몇 개인지가 그날그날 달라 "체크를 끄면 줄어든다"를 잴 기준이
 * 없다. 배선(순수 함수 → 화면 → 캔버스)이 이어져 있는지가 여기서 볼 것이고,
 * 집합 계산 자체는 `lib/home/sessionTree.test.ts`가 지킨다.
 */
const MAP_FIXTURE = {
  nodes: [
    { id: "n1", session_id: "s-personal", title: "빛의 굴절", preview: "", tag: "빛", created_at: "2026-08-06T00:00:00Z" },
    { id: "n2", session_id: "s-personal", title: "분산", preview: "", tag: "빛", created_at: "2026-08-06T00:00:01Z" },
    { id: "n3", session_id: "s-class", title: "판구조론", preview: "", tag: "지구", created_at: "2026-08-06T00:00:02Z" },
  ],
  edges: [{ a: "n1", b: "n2", distance: 0.4 }],
  sessions: [
    { id: "s-personal", title: "빛 이야기", space_kind: "personal", space_ref: null, updated_at: "2026-08-06T00:00:00Z" },
    { id: "s-class", title: "지구과학 수업", space_kind: "class", space_ref: "c1", updated_at: "2026-08-05T00:00:00Z" },
  ],
};

async function withFixture(page: import("@playwright/test").Page) {
  await page.route("**/api/home/concept-map", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MAP_FIXTURE),
    }),
  );
}

/** 보이는 개념 수. 캔버스는 픽셀로 못 세므로 오버레이가 내는 값을 읽는다. */
function visibleNodes(page: import("@playwright/test").Page) {
  return page.locator("[data-visible-nodes]");
}

test("대화를 끄면 지도에서 사라지고, 새로고침해도 꺼진 채로 있다", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");

  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "3", {
    timeout: 30_000,
  });

  // 대화 하나를 끈다 — 그 대화의 개념 둘이 빠져야 한다.
  await page.getByRole("checkbox", { name: "빛 이야기 표시" }).click();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "1");

  /**
   * **끈 상태는 새로고침을 넘긴다.** 저장하는 것이 '숨긴 것'이라 성립하는
   * 성질이고, 반대로 저장했다면 여기가 아니라 **새 대화가 안 뜨는 것**으로
   * 드러났을 것이다(그건 이 테스트로 못 잡는다 — 단위 테스트가 지킨다).
   */
  await page.reload();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "1", {
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "전부 보기" }).click();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "3");
});

test("폴더 체크박스가 그 공간의 대화를 한꺼번에 끄고, 전부 끄면 말해 준다", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "3", {
    timeout: 30_000,
  });

  // 개인 공간 폴더를 끈다 → 그 안의 대화 전부가 꺼진다.
  await page.getByRole("checkbox", { name: /개인 공간 전체 표시/ }).click();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "1");

  // 나머지 폴더까지 끄면 빈 캔버스가 아니라 안내가 뜬다.
  const classFolder = page.getByRole("checkbox", { name: /전체 표시/ }).nth(1);
  await classFolder.click();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "0");
  await expect(page.getByText("지도에 띄운 대화가 없습니다")).toBeVisible();

  // 일부만 켜진 폴더를 누르면 **전부 켜진다**(전부 끄기가 아니다).
  await page.getByRole("checkbox", { name: /개인 공간 전체 표시/ }).click();
  await expect(visibleNodes(page)).toHaveAttribute("data-visible-nodes", "2");
});

test("지도 위에서 휠을 굴려도 페이지는 안 움직인다", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  /**
   * 증상은 "확대했더니 웹 화면이 커졌다"였다(D191). 브라우저 확대 자체는
   * Playwright로 못 재지만, **그 전 단계**인 "휠이 페이지로 새는가"는 잰다 —
   * 페이지가 움직이면 preventDefault가 안 걸린 것이다.
   */
  const box = await canvas.boundingBox();
  if (!box) throw new Error("캔버스를 찾지 못했습니다");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await page.mouse.wheel(0, -400);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // 확대 손잡이가 실제로 붙어 있다 — 없으면 배율을 바꿀 표시가 화면에 없다.
  await expect(page.getByRole("button", { name: "지도 확대" })).toBeVisible();
  await expect(page.getByRole("button", { name: "지도 축소" })).toBeVisible();
  await expect(page.getByRole("button", { name: "지도 전체 보기" })).toBeVisible();
});
