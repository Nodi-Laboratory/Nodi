import { expect, test, type Page } from "@playwright/test";
import { E2E_EMAIL, E2E_PASSWORD, openFreshSession } from "./helpers";

/**
 * 캔버스가 실제로 부드러운지 **재는** 스위트.
 *
 * 여기 있는 것은 회귀 방지이지 성능 보증이 아니다 — CI 기계 사양이 제각각이라
 * 절대 시간으로 못 자른다. 대신 **긴 프레임의 비율**을 본다: 사람은 평균이
 * 아니라 **끊김**을 느끼고, 끊김은 꼬리에 산다.
 *
 * 부하는 학생이 열심히 쓴 캔버스다(카드 120장). 카드 몇 장으로 재면 무엇을
 * 고쳐도 늘 빠르게 나온다.
 *
 * ## ⚠️ dev 서버에 대고 재면 **제품이 아니라 계측을 잰다**
 *
 * `next dev`는 React 개발 모드다. CPU 프로파일을 떠 보니 상위가 통째로
 * `jsxDEV`(7.3%) · `jsxDEVImpl`(6.2%) · `validateProperty` ·
 * `logComponentRender`였다 — 우리 코드가 아니다. 그 탓에 **리렌더를 줄여도
 * 숫자가 꿈쩍하지 않아** 엉뚱한 곳을 고칠 뻔했다.
 *
 *     npm run build && npx next start -p 3100     # dev를 내린 뒤에 (CLAUDE.md)
 *     PLAYWRIGHT_BASE_URL=http://localhost:3100 npx playwright test e2e/perf-canvas
 *
 * 실측 2026-08-06 (같은 기계, 카드 300장):
 *
 *     dev   팬 끊김  4.9% · 줌 10.3%(p95 65ms) · 드래그 0%
 *     prod  팬 끊김  0.0% · 줌  0.0%(p95 25ms) · 드래그 0%
 *
 * 카드 600장까지 올려도 prod는 전부 0%다. **캔버스는 느리지 않다** — D124(팬 중
 * React 안 돌림)와 D123(무겹침이 알고리즘의 성질)이 이미 값을 치렀다. 이
 * 스위트가 하는 일은 그 상태를 지키는 것이다.
 *
 * ⚠️ 로컬 스택이 떠 있어야 한다 — 없으면 로그인부터 실패한다.
 */

/** 부하. 조사할 때만 환경변수로 올려 본다(기본은 CI에서 도는 값). */
const CARDS = Number(process.env.PERF_CARDS ?? 120);

/** 이 시간을 넘긴 프레임을 "끊겼다"고 본다(60fps 기준 두 프레임). */
const LONG_FRAME_MS = 34;

interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  longRatio: number;
}

/** rAF 간격을 모으는 수집기를 페이지에 심는다. */
async function startFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames?: number[]; __stop?: () => void };
    w.__frames = [];
    let last = performance.now();
    let live = true;
    const tick = () => {
      if (!live) return;
      const now = performance.now();
      w.__frames!.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__stop = () => {
      live = false;
    };
  });
}

async function stopFrames(page: Page): Promise<FrameStats> {
  return page.evaluate((longMs) => {
    const w = window as unknown as { __frames: number[]; __stop: () => void };
    w.__stop();
    // 첫 프레임은 수집기가 붙는 간격이라 버린다.
    const d = w.__frames.slice(1).sort((a, b) => a - b);
    const at = (q: number) => d[Math.min(d.length - 1, Math.floor(d.length * q))] ?? 0;
    return {
      frames: d.length,
      p50: at(0.5),
      p95: at(0.95),
      longRatio: d.filter((x) => x > longMs).length / Math.max(1, d.length),
    };
  }, LONG_FRAME_MS);
}

/** 로그인해서 토큰을 얻는다 — 카드는 API로 심는 편이 빠르고 흔들리지 않는다. */
async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();
  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/);
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }
  await page.goto("/space/personal");
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
}

/**
 * 이 세션에 카드를 채운다. **API로 심는다** — 화면으로 120장을 만들면 그
 * 자체로 몇 분이고, 재려는 것은 만들기가 아니라 다 만들어진 캔버스다.
 */
async function seedCards(page: Page, sessionId: string, n: number): Promise<void> {
  await page.evaluate(
    async ([sid, count]) => {
      // 토큰은 쿠키에 있다(`lib/session.ts` — 미들웨어가 같은 값을 봐야 한다).
      const hit = document.cookie
        .split("; ")
        .find((c) => c.startsWith("nodi_token="));
      const token = hit ? decodeURIComponent(hit.slice("nodi_token=".length)) : "";
      const base = "/api";
      // 서버가 한 번에 받는 상한(50)에 맞춰 나눠 보낸다.
      for (let start = 0; start < (count as number); start += 50) {
        const items = [];
        for (let i = start; i < Math.min(start + 50, count as number); i++) {
          items.push({
            kind: "concept",
            source: "ai",
            title: `성능 카드 ${i}`,
            body: `본문입니다. `.repeat(12),
            tag: `분류${i % 6}`,
            seq: i,
          });
        }
        const res = await fetch(`${base}/sessions/${sid}/canvas/items`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) throw new Error(`시드 실패 ${res.status}`);
      }
    },
    [sessionId, n] as const,
  );
  await page.reload();
  await expect(page.locator("[data-canvas-item]")).toHaveCount(n, { timeout: 60_000 });
}

test.describe("캔버스 부드러움", () => {
  test.setTimeout(180_000);

  test(`카드 ${CARDS}장에서 팬·줌·드래그가 끊기지 않는다`, async ({ page }) => {
    await login(page);
    await openFreshSession(page);

    const sessionId = await page.locator(".canvas2").getAttribute("data-session");
    expect(sessionId).toBeTruthy();
    await seedCards(page, sessionId!, CARDS);

    const stage = page.locator(".canvas2");
    const box = await stage.boundingBox();
    if (!box) throw new Error("캔버스를 찾지 못했습니다");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // --- 팬 -----------------------------------------------------------------
    // D124: 팬 중에는 React를 돌리지 않는다. 그 약속이 지켜지는지 본다.
    await page.mouse.move(cx, cy);
    await startFrames(page);
    for (let i = 0; i < 40; i++) {
      await page.mouse.wheel(14, 10);
      await page.waitForTimeout(16);
    }
    const pan = await stopFrames(page);

    // --- 줌 -----------------------------------------------------------------
    await startFrames(page);
    for (let i = 0; i < 24; i++) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, i % 2 ? 60 : -60);
      await page.keyboard.up("Control");
      await page.waitForTimeout(16);
    }
    const zoom = await stopFrames(page);

    // --- 드래그 -------------------------------------------------------------
    const first = page.locator("[data-canvas-item]").first();
    const fb = await first.boundingBox();
    if (!fb) throw new Error("카드를 찾지 못했습니다");
    await page.mouse.move(fb.x + 30, fb.y + 14);
    await page.mouse.down();
    await startFrames(page);
    for (let i = 0; i < 40; i++) {
      await page.mouse.move(fb.x + 30 + i * 6, fb.y + 14 + i * 3);
      await page.waitForTimeout(16);
    }
    const drag = await stopFrames(page);
    await page.mouse.up();

    for (const [name, s] of [["팬", pan], ["줌", zoom], ["드래그", drag]] as const) {
      // 이 스위트의 산출물이 곧 이 숫자다 — 통과/실패만으로는 알 수 없다.
      console.log(
        `  ${name}: 프레임 ${s.frames}개 · 중앙값 ${s.p50.toFixed(1)}ms` +
          ` · p95 ${s.p95.toFixed(1)}ms · 끊김 ${(s.longRatio * 100).toFixed(1)}%`,
      );
    }

    // 끊김이 4프레임 중 1개를 넘으면 사람 눈에 걸린다. 느슨한 이유는 CI 기계
    // 사양을 모르기 때문이다 — 회귀를 잡는 것이 목적이지 등급을 매기는 것이
    // 아니다.
    expect(pan.longRatio, "팬이 끊긴다").toBeLessThan(0.25);
    expect(zoom.longRatio, "줌이 끊긴다").toBeLessThan(0.25);
    expect(drag.longRatio, "드래그가 끊긴다").toBeLessThan(0.25);
  });
});
