import { expect, test, type Page } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession, selectTool, setAskPen } from "./helpers";

/**
 * D176 E2E — 손으로 써서 묻기.
 *
 * 질문 필기는 **기존 펜(Excalidraw 자유선)**이 받는다. 그래서 여기서 확인할
 * 것은 "획이 잘 그려지는가"가 아니라(저쪽이 이미 한다) **그 획이 글자가 되어
 * 프롬프트창으로 오는가**, 그리고 그 사이의 규칙들이다:
 *
 *   · 도구를 켜면 보내기 자리가 [글자 인식]으로 바뀐다
 *   · 인식하면 필기가 캔버스에서 사라지고 버튼이 둘로 갈린다
 *   · OCR로 보내는 그림은 **획의 bbox만** 잘라 담는다(화면 전체가 아니라)
 *   · 창구가 없을 때(404) 학생이 무엇을 보는가 — 그리고 쓴 것을 잃지 않는가
 *
 * **창구는 `/ink/interpret`이다** (D178). 예전에는 `/ocr/handwriting`이었는데,
 * 표시 해석이 붙으면서 손글씨와 표시를 **한 번에** 부르는 창구로 옮겼다.
 * 저쪽은 계약이 살아 있지만 화면은 더 이상 부르지 않는다.
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)이 떠 있어야 한다.
 */
test.describe.configure({ mode: "serial" });

/** **입력창 왼쪽 토글**로 질문하는 펜을 켠다 (사용자 지시 2026-08-09). */
async function pickAskPen(page: Page): Promise<void> {
  await setAskPen(page, true);
  await expect(page.locator('[data-testid="ask-ink"]')).toHaveAttribute(
    "data-phase",
    /writing|review/,
  );
}

/** 지금 캔버스에 있는 질문 필기의 획 수. 픽셀로는 못 센다(획끼리 겹친다). */
async function strokes(page: Page): Promise<number> {
  const v = await page.locator('[data-testid="ask-ink"]').getAttribute("data-strokes");
  return Number(v ?? -1);
}

async function phase(page: Page): Promise<string> {
  return (await page.locator('[data-testid="ask-ink"]').getAttribute("data-phase")) ?? "";
}

/** 캔버스에 획 하나를 긋는다 — 화면 좌표로. */
async function stroke(
  page: Page,
  x0: number,
  y0: number,
  pts: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
  const box = (await page.locator(".canvas2").boundingBox())!;
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  for (const [dx, dy] of pts) {
    await page.mouse.move(box.x + x0 + dx, box.y + y0 + dy, { steps: 6 });
  }
  await page.mouse.up();
}

/** 세 획짜리 낙서 — "글자"를 흉내 낸다. */
async function write(page: Page): Promise<void> {
  await stroke(page, 300, 260, [[0, 60]]);
  await stroke(page, 280, 300, [[50, 0]]);
  await stroke(page, 380, 260, [[40, 0], [40, 60]]);
}

test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
  /**
   * **빈 대화에서 시작한다.**
   *
   * 질문 표시는 획 자신에 남고 씬과 함께 저장되므로(그게 요점이다), 앞 실행이
   * 남긴 질문 획이 그대로 세어진다 — 한 획을 그었는데 2획으로 잡혔다(실측).
   * 세션을 새로 열면 매 실행이 같은 조건에서 시작한다.
   */
  await openFreshSession(page);
});

test.afterEach(async ({ page }) => {
  // 세션을 공유한다 — 다음 테스트가 깨끗한 상태에서 시작하게.
  // **캔버스에 있을 때만** 치운다: 다른 화면에서는 이 요소들이 없어서
  // locator가 타임아웃을 다 쓰고, 훅 자체가 실패한다(실측).
  if (!page.url().includes("/space/")) return;
  await page
    .getByRole("button", { name: "선택" })
    .click({ timeout: 2000 })
    .catch(() => {});
  await page.getByLabel("질문 입력").fill("", { timeout: 2000 }).catch(() => {});
});

test("질문하는 펜을 켜면 보내기 자리가 글자 인식으로 바뀐다", async ({ page }) => {
  await expect(page.getByLabel("보내기")).toBeVisible();

  await pickAskPen(page);
  expect(await phase(page)).toBe("writing");
  await expect(page.locator('[data-testid="ink-recognize"]')).toBeVisible();
  await expect(page.getByLabel("보내기")).toBeHidden();
  await expect(page.getByTestId("ask-ink-hint")).toBeVisible();

  // 다른 도구로 옮기면 평소로 돌아온다.
  await page.getByRole("button", { name: "선택" }).click();
  expect(await phase(page)).toBe("off");
  await expect(page.getByLabel("보내기")).toBeVisible();
});

test("길게 이어 그은 획이 중간에 끊기지 않는다", async ({ page }) => {
  /**
   * 사용자 보고 2026-08-05: "글자인식 펜이 작성되지 않는다".
   *
   * 원인은 획을 세는 신호(`onChange`)에서 **씬을 되쓴 것**이었다. Excalidraw의
   * `updateScene({elements})`는 `replaceAllElements`라 공식 문서가 드래그 중
   * 사용을 금한다 — 그리던 획이 그 자리에서 끊긴다.
   *
   * 한 번에 길게 그으면 그 사이 `onChange`가 수십 번 온다. 그때마다 씬을
   * 되쓰면 획이 **여러 조각으로 쪼개지거나 사라진다**. 그래서 "한 획을 그으면
   * 정확히 1획"이 이 결함의 잣대다.
   */
  await pickAskPen(page);
  const box = (await page.locator(".canvas2").boundingBox())!;
  await page.mouse.move(box.x + 260, box.y + 240);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(box.x + 260 + i * 6, box.y + 240 + Math.sin(i / 3) * 30);
  }
  await page.mouse.up();

  await expect.poll(() => strokes(page), { timeout: 3000 }).toBe(1);
});

test("한 획을 긋는 즉시 버튼이 살아난다", async ({ page }) => {
  /**
   * 사용자 보고 2026-08-05: "글씨를 쓰면 왜 버튼이 활성화되지 않지?"
   *
   * 획 수를 **저장 신호**(1.5초 디바운스)에 물려 세고 있었다. 쓰는 동안에는
   * 타이머가 계속 밀려서 손을 멈춘 뒤에야 켜졌다.
   *
   * **넉넉한 폴링으로 재면 이 결함이 안 잡힌다** — 결국은 켜지기 때문이다.
   * 그래서 마감을 짧게 둔다: 한 획을 긋고 나면 곧바로 눌 수 있어야 한다.
   */
  await pickAskPen(page);
  expect(await strokes(page)).toBe(0);
  // 획이 없으면 인식할 것도 없다.
  await expect(page.locator('[data-testid="ink-recognize"]')).toBeDisabled();

  await stroke(page, 300, 260, [[0, 60]]);
  await expect(page.locator('[data-testid="ink-recognize"]')).toBeEnabled({
    timeout: 700, // 저장 디바운스(1500)보다 **짧게**
  });
  expect(await strokes(page)).toBe(1);
  await expect(page.getByTestId("ask-ink-hint")).toBeHidden();

  await stroke(page, 280, 300, [[50, 0]]);
  await expect.poll(() => strokes(page), { timeout: 700 }).toBe(2);
});

test("인식하면 필기가 사라지고 버튼이 둘로 갈린다", async ({ page }) => {
  await page.route("**/ink/interpret", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "빛의 굴절이 뭐야?", confidence: null }),
    }),
  );

  await pickAskPen(page);
  const itemsBefore = await page.locator("[data-canvas-item]").count();
  await write(page);
  await expect.poll(() => strokes(page)).toBe(3);

  /**
   * **한 번에 간다** (사용자 지시 2026-08-11).
   *
   * 예전에는 [글자 인식] → (확인) → [AI에게 묻기] 셋이었다. 지금은 버튼이
   * 하나이고, 누르면 읽어서 입력창에 넣고 **그대로 보낸다.** 인식된 글자를
   * 고치는 자리는 없다 — 그 값을 알고 내린 결정이다.
   */
  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("빛의 굴절이 뭐야?");

  // **필기는 사라진다** — 글자가 되는 순간 캔버스에서 지워진다(사용자 결정).
  await expect.poll(() => strokes(page)).toBe(0);
  // 단계는 하나뿐이다 — 확인 단계가 없어졌다.
  expect(await phase(page)).toBe("writing");

  // **보낸다** — 답이 와서 카드가 는다(예전에는 여기서 멈췄다).
  await expect
    .poll(() => page.locator("[data-canvas-item]").count(), { timeout: 90_000 })
    .toBeGreaterThan(itemsBefore);

  // 갈라지던 두 버튼은 없다.
  await expect(page.locator('[data-testid="ink-again"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ink-send"]')).toHaveCount(0);
  // 버튼은 제자리에 남아 다음 필기를 기다린다(획이 없으니 꺼져 있다).
  await expect(page.locator('[data-testid="ink-recognize"]')).toBeVisible();
  await expect(page.locator('[data-testid="ink-recognize"]')).toBeDisabled();
});

test("일반 펜 획은 질문에 안 섞이고, 도구를 오가도 질문 획은 남는다", async ({ page }) => {
  /**
   * 사용자 지시 2026-08-05: "글자인식 펜과 일반 펜의 획은 구분되어야 한다".
   *
   * 구분이 **시점**이면(도구를 켠 뒤 생긴 것) 도구를 잠깐 바꿨다 돌아올 때
   * 앞서 쓴 질문 획이 미아가 된다 — 인식도 안 되고 지워지지도 않는다.
   * 표시는 획 자신에 있어야 한다.
   */
  await pickAskPen(page);
  await stroke(page, 300, 260, [[0, 60]]);
  await expect.poll(() => strokes(page)).toBe(1);

  // 일반 펜으로 그림을 하나 그린다 — 이건 질문이 아니다.
  await selectTool(page, "자유선");
  await stroke(page, 500, 260, [[60, 0], [60, 60]]);
  await page.waitForTimeout(600);

  // 질문하는 펜으로 돌아와 한 획 더.
  await pickAskPen(page);
  await stroke(page, 300, 360, [[60, 0]]);

  // **질문 획만 둘.** 일반 펜 획이 섞이면 3이 되고, 앞 획을 잃으면 1이 된다.
  await expect.poll(() => strokes(page)).toBe(2);

  await page.getByRole("button", { name: "선택·이동", exact: true }).click();
});

test("보내는 그림은 획의 bbox만 잘라 담는다 — 흰 종이에 검은 획", async ({ page }) => {
  /**
   * 사용자 지시 2026-08-04: "글자인식으로 작성한 획들의 max bbox를 추출하여
   * OCR API에 입력한다."
   *
   * 화면 전체를 보내면 (a) 여백이 대부분이라 글자가 작아지고 (b) 학생이 그려
   * 둔 그림·격자가 함께 들어가 노이즈가 된다. 그림의 **크기**를 재면 잘랐는지가
   * 그대로 드러난다.
   */
  let png: Buffer | null = null;
  await page.route("**/ink/interpret", async (route) => {
    const raw = route.request().postDataBuffer()!;
    const start = raw.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const end = raw.indexOf(Buffer.from("IEND"), start) + 8;
    png = raw.subarray(start, end);
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"text":"ok"}' });
  });

  await pickAskPen(page);
  // 화면 한구석에만 쓴다 — 잘라내지 않으면 그림이 캔버스만큼 커진다.
  await stroke(page, 300, 260, [[0, 60]]);
  await stroke(page, 280, 300, [[60, 0]]);
  await expect.poll(() => strokes(page)).toBe(2);

  const stage = (await page.locator(".canvas2").boundingBox())!;
  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("ok");

  const stat = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let white = 0;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (lum > 245) white++;
      else if (lum < 90) dark++;
    }
    return { w: c.width, h: c.height, white, dark, total: d.length / 4 };
  }, Array.from(png!));

  // 그은 자리는 60×60 남짓이다. 배율(dpr ≤ 2)과 여백(18px)을 넉넉히 봐도
  // **화면 절반보다 작아야** 한다 — 캔버스를 통째로 보냈다면 여기서 깨진다.
  expect(stat.w).toBeLessThan(stage.width / 2);
  expect(stat.h).toBeLessThan(stage.height / 2);
  expect(stat.w).toBeGreaterThan(20);

  // 대부분이 흰 종이 — 종이색·격자가 섞이면 여기서 깨진다.
  expect(stat.white / stat.total).toBeGreaterThan(0.7);
  // 그런데 획은 분명히 검다(자유선은 얇아서 픽셀 수가 많지 않다).
  expect(stat.dark).toBeGreaterThan(5);

  /**
   * **모양이 획을 따라간다.** 그은 것은 60×60 남짓의 정사각형 영역이고,
   * 사방 여백이 같으므로 그림도 정사각형에 가까워야 한다. 화면을 통째로
   * 보냈다면 여기서 가로로 길쭉해진다(16:9).
   */
  expect(stat.w / stat.h).toBeGreaterThan(0.6);
  expect(stat.w / stat.h).toBeLessThan(1.7);
});

test("창구가 없으면 준비 중이라고 말하고, 쓴 것을 지우지 않는다", async ({ page }) => {
  await page.route("**/ink/interpret", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not Found"}' }),
  );

  await pickAskPen(page);
  await write(page);
  await expect.poll(() => strokes(page)).toBe(3);

  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByText(/준비하고 있어요/)).toBeVisible();

  // **실패했다고 지우면 다시 써야 한다.**
  expect(await strokes(page)).toBe(3);
  expect(await phase(page)).toBe("writing");
  // 보내는 버튼은 하나뿐이고, 실패했으니 질문도 안 나갔다.
  await expect(page.locator('[data-testid="ink-send"]')).toHaveCount(0);
  await expect(page.getByLabel("질문 입력")).toHaveValue("");
});

test("어느 화면에서도 글자가 안 잡히고, 입력칸에서만 잡힌다", async ({ page }) => {
  // 태블릿에서 길게 누르면 뜨는 "복사 · 선택 영역 찾기" 막대를 없앤 것.
  // 획을 긋는 중에 뜨면 그 획이 통째로 버려진다.
  const pick = (sel: string) =>
    page.locator(sel).first().evaluate((el) => getComputedStyle(el).userSelect);

  expect(await pick("body")).toBe("none");
  expect(await pick(".canvas2")).toBe("none");
  expect(await pick("nav")).toBe("none"); // 캔버스 밖 — 앱 껍데기
  expect(await pick("[aria-label='질문 입력']")).toBe("text");

  await page.goto("/home");
  await expect(page.locator("body")).toBeVisible();
  expect(await pick("body")).toBe("none");
});

test("펜으로 쓰는 동안 도구 레일이 손날에 안 바뀐다", async ({ page }) => {
  // 사용자 보고 2026-08-04: "펜으로 쓰니까 오른쪽의 도구 바가 계속 선택된다".
  //
  // 겨냥은 **지우개**다 — 묶음(펜·도형) 안의 단추는 고르는 순간 접히므로
  // 눌린 뒤의 상태를 그 자리에서 볼 수 없다(2026-08-09 도구바 재편).
  const rect = page.getByRole("button", { name: "지우개", exact: true });
  await expect(rect).toHaveAttribute("aria-pressed", "false");

  const penMoves = () =>
    page.evaluate(() =>
      document.body.dispatchEvent(
        new PointerEvent("pointermove", { pointerType: "pen", bubbles: true }),
      ),
    );
  const palmTaps = () =>
    rect.evaluate((el) => {
      el.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }),
      );
      (el as HTMLButtonElement).click();
    });

  await penMoves();
  await palmTaps();
  await expect(rect).toHaveAttribute("aria-pressed", "false");

  // **영영 막지는 않는다** — 펜을 내려놓고 누른 손가락은 의도한 조작이다.
  await page.waitForTimeout(1100);
  await palmTaps();
  await expect(rect).toHaveAttribute("aria-pressed", "true");
});
