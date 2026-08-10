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

  // 페이지 제목은 걷어냈다(사용자 지시 2026-08-09) — 지금 이 화면의 머리말은
  // 인사말이다.
  await expect(
    page.getByRole("heading", { name: /무엇을 배우고 싶으신가요/ }),
  ).toBeVisible({ timeout: 30_000 });

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

/**
 * 개념이 없으면 **홈에 머무르지 않는다** (D210 2-1, 사용자 지시).
 *
 * 예전에는 "아직 지도에 올릴 개념이 없습니다 / 첫 대화 시작하기"라는 빈 상태를
 * 보여 줬다. 지금은 그 화면 자체가 없다 — 지도에 올릴 것이 없으면 캔버스로
 * 곧장 보낸다. 안내를 한 번 더 읽고 버튼을 누르게 하는 것보다, 할 수 있는
 * 자리에 데려다 놓는 편이 낫다는 판단이다.
 *
 * 판정 기준이 "세션 없음"이 아니라 **"개념 카드 0개"**인 것이 요점이라
 * 응답을 비워서 태운다(계정을 비우면 다른 스펙이 쓰는 데이터가 사라진다).
 *
 * `replace`여야 한다 — `push`면 뒤로 가기가 다시 빈 홈으로 데려오고 거기서
 * 또 튕겨 나가 뒤로 가기가 먹지 않는 것처럼 보인다.
 */
test("개념이 없으면 홈에 머무르지 않고 캔버스로 보낸다", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  await page.route("**/api/home/concept-map", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [], edges: [], sessions: [] }),
    }),
  );
  await page.goto("/home");
  await page.waitForURL(/\/space\/personal/, { timeout: 30_000 });
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
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

/**
 * 폴더로 대화를 켜고 끄던 목록(D191)은 **2026-08-09에 걷어냈다**(사용자 지시).
 *
 * 홈에서 지도는 이제 배경이다 — 그 위에 인사·입력창·갈 곳 둘이 뜬다. 무엇을
 * 숨길지 고르는 일은 값보다 자리를 더 많이 차지한다는 판단이었다. 그 목록을
 * 검증하던 두 스펙(대화 끄기 · 폴더 체크박스)도 함께 지웠다 — 없는 기능을
 * 검증하는 테스트는 다음 사람에게 "있는 기능"이라고 말한다.
 *
 * 대신 그 자리에 **새 홈이 갖춰야 할 것**을 둔다.
 */
test("홈이 인사·입력창·갈 곳 둘을 지도 위에 띄운다", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");

  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 2 })).toContainText(
    "무엇을 배우고 싶으신가요?",
  );
  await expect(page.getByLabel("질문 입력")).toBeVisible();
  await expect(page.getByRole("button", { name: "새로운 대화 하기" })).toBeVisible();
  await expect(page.getByRole("button", { name: "내 세션 보기" })).toBeVisible();

  // 걷어낸 목록이 되살아나지 않았는지 — 되살아나면 화면이 다시 좁아진다.
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("'내 세션 보기'는 세션 선택 화면으로 간다 (D217)", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");
  await page.getByRole("button", { name: "내 세션 보기" }).click();
  await page.waitForURL(/\/sessions/, { timeout: 30_000 });
  // 학급 코드는 **칸 여섯**이다(사용자 지시 2026-08-09 재디자인) — 첫 칸으로 잰다.
  await expect(page.getByLabel("학급 코드 1번째 자리")).toBeVisible({ timeout: 30_000 });
});

/**
 * 덮개가 지도를 **덮기만 하고 막지는 않는다** (사용자 지시 2026-08-09).
 *
 * 베이지 덮개가 포인터를 먹으면 배경은 그림이 되고, 그러면 지도를 둘 이유가
 * 사라진다. 지도 한가운데에서 위에 있는 것이 캔버스인지로 잰다.
 */
test("덮개 아래 지도가 살아 있다", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await withFixture(page);
  await page.goto("/home");
  await expect(page.locator("canvas")).toBeVisible({ timeout: 30_000 });

  /**
   * **덮개 자신에게 묻는다.** 화면 한 점의 최상위 요소로 재려 했더니 그 자리에
   * 무엇이 오는지가 지도 내용에 따라 달라졌다(툴팁·확대 손잡이). 지키려는
   * 성질은 "덮개가 포인터를 안 먹는다" 하나이므로 그것을 직접 잰다.
   */
  const veil = page.locator("[data-map-veil]");
  await expect(veil).toHaveCount(1);
  const pe = await veil.evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(pe).toBe("none");
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
  // **전체 보기(⤢)는 없다**(사용자 지시 2026-08-09) — 지도가 배경이 되면서
  // "전부 담아 보기"의 값이 사라졌다. 처음 그릴 때 이미 담아 맞춘다.
  await expect(page.getByRole("button", { name: "지도 전체 보기" })).toHaveCount(0);
});
