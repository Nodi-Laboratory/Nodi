import { expect, test, type Page, type Request } from "@playwright/test";
import { createNote, loginAndOpenCanvas, openFreshSession } from "./helpers";

/**
 * D178 E2E — 표시가 무엇을 가리키는지 함께 보낸다.
 *
 * D176은 획을 글자로만 바꿨다. 그런데 학생이 하는 일은 그것만이 아니다 —
 * 카드를 동그라미 치고 화살표를 긋고 그 끝에 질문을 쓴다. 글자만 보내면
 * **"이거"가 사라진다.**
 *
 * 여기서 확인하는 것은 화면이 아니라 **나가는 요청**이다. 화면에는 아무 차이도
 * 안 보이기 때문이다 — 카드가 안 실려도 답은 그럴싸하게 온다. 그래서 이
 * 결함은 눈으로 못 잡는다.
 *
 *   · 카드 옆에서 쓰면 도식(scene_png)과 카드 명부(cards)가 실린다
 *   · 카드가 멀면 안 실린다 — 가리킬 후보가 없으면 비전을 부를 이유가 없다
 *   · 도식은 상한(ink_scene_max_side) 안이다
 *
 * 로컬 스택(docker + 백엔드 8000 + 프론트 3000)이 떠 있어야 한다.
 */
test.describe.configure({ mode: "serial" });

/** multipart 본문에서 필드 이름 목록을 뽑는다. */
function fieldNames(req: Request): string[] {
  const raw = req.postDataBuffer()?.toString("latin1") ?? "";
  return [...raw.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
}

/** multipart 본문에서 `cards` 필드 값(JSON 문자열). 없으면 null. */
function cardsField(req: Request): string | null {
  const raw = req.postDataBuffer()?.toString("utf8") ?? "";
  const m = raw.match(/name="cards"\r?\n\r?\n([\s\S]*?)\r?\n--/);
  return m ? m[1] : null;
}

/** 본문에서 n번째 PNG를 잘라 낸다(0부터). 필드 순서 = ink, scene, figure. */
function nthPng(req: Request, n: number): Buffer | null {
  const raw = req.postDataBuffer();
  if (!raw) return null;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let from = 0;
  for (let i = 0; i <= n; i++) {
    const start = raw.indexOf(sig, from);
    if (start < 0) return null;
    const end = raw.indexOf(Buffer.from("IEND"), start) + 8;
    if (i === n) return raw.subarray(start, end);
    from = end;
  }
  return null;
}

/** 캔버스에 획 하나 — 화면 좌표로. */
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

async function strokes(page: Page): Promise<number> {
  const v = await page.locator('[data-testid="ask-ink"]').getAttribute("data-strokes");
  return Number(v ?? -1);
}

/**
 * 인식 요청을 가로채고, 나간 요청을 돌려준다.
 *
 * 진짜 모델 서버를 부르지 않는다 — 이 테스트가 재는 것은 **무엇을 보냈나**이지
 * 무엇을 읽었나가 아니다.
 */
async function captureRequest(page: Page): Promise<() => Request | null> {
  let seen: Request | null = null;
  await page.route("**/ink/interpret", async (route) => {
    seen = route.request();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "이거 더 설명해줘",
        marks_note: "화살표가 [카드 1]을 가리킨다.",
        pointed: 1,
        confidence: null,
      }),
    });
  });
  return () => seen;
}

async function pickAskPen(page: Page): Promise<void> {
  await page.getByRole("button", { name: "질문하는 펜" }).click();
  await expect(page.locator('[data-testid="ask-ink"]')).toHaveAttribute(
    "data-phase",
    /writing|review/,
  );
}

test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
});

test("카드 옆에서 쓰면 도식과 카드 명부가 함께 나간다", async ({ page }) => {
  const note = await createNote(page, "지질학 설명", { x: 420, y: 300 });
  const got = await captureRequest(page);

  await pickAskPen(page);
  // 카드 **바로 옆**에 쓴다 — 근접 반경(기본 120 월드px) 안이어야 한다.
  await stroke(page, 300, 300, [[0, 40]]);
  await stroke(page, 320, 320, [[40, 0]]);
  await expect.poll(() => strokes(page)).toBe(2);

  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("이거 더 설명해줘");

  const req = got()!;
  const names = fieldNames(req);
  expect(names).toContain("ink_png");
  expect(names).toContain("scene_png");
  expect(names).toContain("cards");

  // 명부에는 번호와 제목만 간다 — 본문은 서버가 RLS로 다시 읽는다(D104).
  const cards = JSON.parse(cardsField(req)!) as Array<{ n: number; title: string }>;
  expect(cards.length).toBeGreaterThanOrEqual(1);
  expect(cards[0].n).toBe(1);
  expect(JSON.stringify(cards)).not.toContain("body");

  await expect(note).toBeVisible();
});

test("가까운 카드가 없으면 도식을 안 보낸다", async ({ page }) => {
  const got = await captureRequest(page);

  await pickAskPen(page);
  // 빈 세션이라 카드가 아예 없다 — 가리킬 후보가 없으면 비전을 부를 이유가 없다.
  await stroke(page, 300, 260, [[0, 60]]);
  await stroke(page, 280, 300, [[60, 0]]);
  await expect.poll(() => strokes(page)).toBe(2);

  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("이거 더 설명해줘");

  const names = fieldNames(got()!);
  expect(names).toContain("ink_png");
  expect(names).not.toContain("scene_png");
  expect(names).not.toContain("cards");
});

test("도식은 한 변 상한 안이고, 손글씨 그림보다 넓다", async ({ page }) => {
  await createNote(page, "천문학 설명", { x: 420, y: 300 });
  const got = await captureRequest(page);

  await pickAskPen(page);
  await stroke(page, 300, 300, [[0, 40]]);
  await stroke(page, 320, 320, [[40, 0]]);
  await expect.poll(() => strokes(page)).toBe(2);
  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("이거 더 설명해줘");

  const req = got()!;
  const size = async (n: number) => {
    const png = nthPng(req, n)!;
    return page.evaluate(async (bytes) => {
      const bmp = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      return { w: bmp.width, h: bmp.height };
    }, Array.from(png));
  };

  const ink = await size(0);
  const scene = await size(1);

  // 상한을 넘으면 업로드가 무거워지고, 비전 모델이 어차피 줄인다.
  expect(Math.max(scene.w, scene.h)).toBeLessThanOrEqual(1280);
  /**
   * **도식은 손글씨보다 넓다** — 카드를 끌어왔으니 당연하다. 같거나 작으면
   * 카드가 안 들어갔다는 뜻이고, 그러면 화살표가 허공을 가리킨다.
   */
  expect(scene.w * scene.h).toBeGreaterThan(ink.w * ink.h);
});
