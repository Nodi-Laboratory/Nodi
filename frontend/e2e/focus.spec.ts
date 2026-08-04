import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "./helpers";

/**
 * D166 E2E — **새 답은 화면에 들어온다.**
 *
 * 단위 테스트(`lib/canvas2/focusCamera.test.ts`)는 기하만 본다. 실제로 잘렸던
 * 이유는 기하와 화면 사이에 있는 것들이었다 — 카드 폭은 `max-content`라 렌더
 * 뒤에야 정해지고, 초점은 그 실측값으로 잡히며, 그 위에 UI가 겹쳐 뜬다.
 * 그래서 진짜 브라우저에서 한 번 더 잰다.
 *
 * 재현(2026-08-04, 고치기 전): 새 대화에서 질문하면 배율이 235%로 **고정**돼
 * 폭 560 카드가 화면 위 1316px을 먹었다. 1024×768에서 왼쪽 114px·오른쪽
 * 178px이 화면 밖이었고 줄마다 첫 글자가 왼쪽 레일 밑에 깔렸다 — 학생 눈에는
 * "답이 안 뜬다"였다.
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)이 떠 있어야 하고, 진짜 LLM
 * 턴을 태우므로 백엔드에 대화 API 키가 필요하다(`GET /health/config`).
 */

/** 캔버스 왼쪽에 늘 떠 있는 레일의 오른쪽 끝(px). 글이 이 안으로 들어가면 가린다. */
const LEFT_RAIL = 64;

/** 교실에서 실제로 쓰는 화면들. 좁은 쪽이 먼저 깨진다. */
const SCREENS = [
  { name: "구형 크롬북", w: 1024, h: 768 },
  { name: "교실 노트북", w: 1366, h: 768 },
];

for (const s of SCREENS) {
  test(`${s.name} ${s.w}×${s.h} — 새 대화의 답이 잘리지 않는다`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: s.w, height: s.h });

    await loginAndOpenCanvas(page);
    await openFreshSession(page);

    await page.getByLabel("질문 입력").fill("무지개가 생기는 이유를 알려줘");
    await page.getByLabel("보내기").click();

    // 답이 다 써질 때까지 — 카드는 글이 자라는 동안 넓어진다. 다 자란 뒤에
    // 재야 "잘렸나"가 판정된다.
    await expect
      .poll(async () => page.locator("[data-canvas-item]").count(), {
        timeout: 120_000,
        intervals: [200],
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => page.locator('[data-writing="1"]').count(), { timeout: 180_000 })
      .toBe(0);
    // 카메라 스프링이 멈출 여유.
    await page.waitForTimeout(1_500);

    const geo = await page.locator("[data-canvas-item]").first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.x, right: r.right, width: r.width, vw: innerWidth };
    });

    // ① 양쪽 다 화면 안. 어느 한쪽이라도 넘으면 그 줄의 글자가 사라진다.
    expect(geo.left, `카드 왼쪽(${Math.round(geo.left)})이 화면 밖이다`).toBeGreaterThanOrEqual(0);
    expect(
      geo.right,
      `카드 오른쪽(${Math.round(geo.right)})이 화면 폭(${geo.vw})을 넘었다`,
    ).toBeLessThanOrEqual(geo.vw);

    // ② 왼쪽 레일 밑에 깔리지 않는다 — 가려지는 건 **줄마다 첫 글자**라
    //    잘린 티도 안 나면서 제일 안 읽힌다.
    expect(
      geo.left,
      `카드가 왼쪽 레일(${LEFT_RAIL}px) 밑에서 시작한다`,
    ).toBeGreaterThanOrEqual(LEFT_RAIL);

    // ③ 그래도 크게 보여야 한다(D162의 뜻). 잘리지 않는 선에서 당긴 결과가
    //    기본 배율보다는 커야 한다 — 안 그러면 "읽을 수 있는 크기"가 무너진다.
    expect(geo.width, "카드가 기본 크기(560)보다 작게 축소됐다").toBeGreaterThan(560);
  });
}
