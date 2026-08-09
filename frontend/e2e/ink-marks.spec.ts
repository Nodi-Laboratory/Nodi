import { expect, test, type Page, type Request } from "@playwright/test";
import { createNote, loginAndOpenCanvas, openFreshSession, setAskPen } from "./helpers";

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

/** multipart 본문에서 텍스트 필드 값(JSON 문자열). 없으면 null. */
function textField(req: Request, name: string): string | null {
  const raw = req.postDataBuffer()?.toString("utf8") ?? "";
  const m = raw.match(
    new RegExp(`name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`),
  );
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

/**
 * 질문하는 펜을 켜고, **그 순간의 획 수**를 돌려준다.
 *
 * ⚠️ 0에서 시작한다고 믿으면 안 된다. `openFreshSession`이 여는 "빈 대화"는
 * D202로 **재사용된 방**일 수 있고, 그 방의 씬에는 앞선 스펙이 남긴 질문 획이
 * 그대로 있다(질문 획은 `customData.nodiAsk`로 영속되는 것이 D176의 성질이다).
 * 실측 2026-08-09: `ask-ink` 뒤에 이 스펙을 돌리면 2획이 3획으로 셌고, 혼자
 * 돌리면 통과했다 — **순서에 기대는 초록불**이다.
 *
 * 그래서 이 스펙은 "몇 획인가"가 아니라 **"몇 획 늘었나"**를 잰다.
 */
async function pickAskPen(page: Page): Promise<number> {
  await setAskPen(page, true);
  await expect(page.locator('[data-testid="ask-ink"]')).toHaveAttribute(
    "data-phase",
    /writing|review/,
  );
  return Math.max(0, await strokes(page));
}

test.beforeEach(async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);
});

test("카드 옆에서 쓰면 도식과 카드 명부가 함께 나간다", async ({ page }) => {
  const note = await createNote(page, "지질학 설명", { x: 420, y: 300 });
  const got = await captureRequest(page);

  const base = await pickAskPen(page);
  // 카드 **바로 옆**에 쓴다 — 근접 반경(기본 120 월드px) 안이어야 한다.
  await stroke(page, 300, 300, [[0, 40]]);
  await stroke(page, 320, 320, [[40, 0]]);
  await expect.poll(() => strokes(page)).toBe(base + 2);

  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("이거 더 설명해줘");

  const req = got()!;
  const names = fieldNames(req);
  expect(names).toContain("ink_png");
  expect(names).toContain("scene_png");
  expect(names).toContain("cards");

  // 명부에는 번호와 제목만 간다 — 본문은 서버가 RLS로 다시 읽는다(D104).
  const cards = JSON.parse(textField(req, "cards")!) as Array<{ n: number; title: string }>;
  expect(cards.length).toBeGreaterThanOrEqual(1);
  expect(cards[0].n).toBe(1);
  expect(JSON.stringify(cards)).not.toContain("body");

  await expect(note).toBeVisible();
});

/**
 * **표시는 카드와 따로 간다.**
 *
 * 카드마다 낱말 하나만 보내면 "화살표가 [카드 1]에서 [카드 3]으로 향한다"를
 * 말할 방법이 없다 — 방향은 카드 둘 사이의 관계라 어느 한 카드에도 안 딸린다.
 * 이 필드가 조용히 빠지면 프롬프트가 예전 수준으로 되돌아가는데, 화면에는
 * 아무 표시도 안 난다.
 */
test("동그라미를 치면 표시 목록이 함께 나간다", async ({ page }) => {
  const note = await createNote(page, "지질학 설명", { x: 420, y: 300 });
  const got = await captureRequest(page);

  const base = await pickAskPen(page);
  // 카드를 크게 한 바퀴 두른다 — 닫힌 고리라야 감쌈으로 읽힌다.
  const ring: [number, number][] = [];
  for (let i = 1; i <= 28; i++) {
    const t = (i / 28) * Math.PI * 2;
    ring.push([Math.cos(t) * 260 - 260, Math.sin(t) * 150]);
  }
  await stroke(page, 700, 340, ring);
  await expect.poll(() => strokes(page)).toBe(base + 1);

  await page.locator('[data-testid="ink-recognize"]').click();
  await expect(page.getByLabel("질문 입력")).toHaveValue("이거 더 설명해줘");

  const req = got()!;
  expect(fieldNames(req)).toContain("gestures");
  const gestures = JSON.parse(textField(req, "gestures")!) as Array<{
    shape: string;
    encloses: number[];
  }>;
  expect(gestures.length).toBeGreaterThanOrEqual(1);
  // 한 바퀴 두른 것은 **동그라미**이고, 그 안에 카드가 들어 있다.
  expect(gestures.some((g) => g.shape === "circle" && g.encloses.length > 0)).toBe(
    true,
  );

  await expect(note).toBeVisible();
});

test("가까운 카드가 없으면 도식을 안 보낸다", async ({ page }) => {
  const got = await captureRequest(page);

  const base = await pickAskPen(page);
  // 빈 세션이라 카드가 아예 없다 — 가리킬 후보가 없으면 비전을 부를 이유가 없다.
  await stroke(page, 300, 260, [[0, 60]]);
  await stroke(page, 280, 300, [[60, 0]]);
  await expect.poll(() => strokes(page)).toBe(base + 2);

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

  const base = await pickAskPen(page);
  await stroke(page, 300, 300, [[0, 40]]);
  await stroke(page, 320, 320, [[40, 0]]);
  await expect.poll(() => strokes(page)).toBe(base + 2);
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
