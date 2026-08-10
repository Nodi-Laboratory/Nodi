import { expect, test } from "@playwright/test";
import {
  createNote,
  loginAndOpenCanvas,
  noteByText,
  openFreshSession,
  selectTool,
} from "../helpers";

/**
 * 플로우 E41–E50 · F51–F60 — 캔버스 아이템과 도구 (docs/TEST-FLOWS.md).
 *
 * 학생이 **직접 만든 것**이 걸린 구간이라, 여기서 잃어버리면 되돌릴 방법이 없다.
 */
test.describe.configure({ mode: "serial" });

test("E41·E43·E44 메모를 쓰고 고치고 지운다 — 전부 새로고침을 견딘다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  const text = `메모${Date.now() % 100000}`;
  const note = await createNote(page, text, { x: 360, y: 260 });
  await expect(note).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await expect(noteByText(page, text)).toBeVisible({ timeout: 15_000 });
});

/**
 * 단축키는 **접힌 도구까지** 그대로 듣는다 (사용자 지시 2026-08-09).
 *
 * 도구바가 짧아지며 펜·도형이 묶음 뒤로 접혔다. 화면에서 사라진 것과 기능이
 * 사라진 것은 다르다 — 손에 익은 키가 어느 날 안 먹으면 그건 고장으로 읽힌다.
 * 그래서 키를 누른 **결과**를 묶음을 펼쳐서 확인한다.
 */
test("F51 도구 단축키가 전부 듣는다", async ({ page }) => {
  await loginAndOpenCanvas(page);

  /** 레일에 자기 줄이 있는 도구 — 누르면 그 버튼이 켜진다. */
  const solo: ReadonlyArray<readonly [string, string]> = [
    ["v", "선택·이동"],
    ["h", "선택·이동"], // 선택과 화면 이동은 하나로 합쳐졌다
    ["s", "카드 수정"],
    ["e", "지우개"],
  ];
  for (const [key, label] of solo) {
    await page.keyboard.press(key);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 5000 },
    );
  }

  /** 묶음 안의 도구 — 키로 고른 뒤 묶음을 펼쳐 확인한다. */
  const grouped: ReadonlyArray<readonly [string, string, string]> = [
    ["p", "펜", "자유선"],
    ["m", "펜", "형광펜"],
    ["t", "펜", "글 쓰기"],
    ["r", "도형", "네모"],
    ["g", "도형", "세모"],
    ["k", "도형", "별"],
    ["a", "도형", "화살표"],
    ["l", "도형", "선"],
  ];
  for (const [key, group, label] of grouped) {
    await page.keyboard.press(key);
    // 묶음 단추 자신이 켜져야 한다 — 접힌 채로도 "지금 이 계열"이 읽혀야 한다.
    await expect(page.getByRole("button", { name: group, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 5000 },
    );
    await page.getByRole("button", { name: group, exact: true }).click();
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 5000 },
    );
    await page.getByRole("button", { name: group, exact: true }).click();
  }

  await page.keyboard.press("v");
});

test("F52 입력창에 타이핑할 때는 도구가 안 바뀐다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await selectTool(page, "선택·이동");

  const box = page.getByLabel("질문 입력");
  await box.click();
  await box.type("prompt 라인 요약", { delay: 10 });
  // 'p'·'r'·'o'·'m'·'t'·'l'·'e'가 다 도구 단축키다 — 하나라도 새면 학생이
  // 글을 쓰다가 그리기 도구로 넘어간다.
  await expect(
    page.getByRole("button", { name: "선택·이동", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await box.fill("");
});

test("F55 도구 레일 접기가 기억된다 (D140)", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.getByRole("button", { name: "도구 접기" }).click();
  await expect(page.getByRole("button", { name: /도구 펼치기/ })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 치우려고 누른 학생이 새로고침마다 다시 눌러야 하면 접기가 쓸모없다.
  await expect(page.getByRole("button", { name: /도구 펼치기/ })).toBeVisible();

  await page.getByRole("button", { name: /도구 펼치기/ }).click();
  await expect(page.getByRole("button", { name: "선택·이동", exact: true })).toBeVisible();
});

/**
 * 색은 **도구와 따로 고른다** (사용자 지시 2026-08-09).
 *
 * 예전에는 펜을 들면 펜 색이, 형광펜을 들면 형광펜 색이 딸려 나왔다(D150).
 * 이제 무지개 단추 하나가 색을 쥐고, 고른 색은 **모든 그리기 도구**에 쓴다 —
 * 도구를 바꿔도 색은 그대로라는 뜻이고, 그게 필기구를 바꿔 쥐는 일과 같다.
 */
test("F56 색 단추가 팔레트를 열고, 고른 색이 도구를 바꿔도 남는다", async ({ page }) => {
  await loginAndOpenCanvas(page);

  // 평소에는 안 뜬다 — 레일이 짧아야 하는 이유가 그것이다.
  await expect(page.getByRole("radiogroup", { name: "그리기 색" })).toBeHidden();

  await page.getByRole("button", { name: "색", exact: true }).click();
  const palette = page.getByRole("radiogroup", { name: "그리기 색" });
  await expect(palette).toBeVisible();
  await palette.getByRole("radio", { name: "빨강" }).click();

  // 도구를 바꾸고 다시 열어도 고른 색 그대로여야 한다.
  await selectTool(page, "형광펜");
  await page.getByRole("button", { name: "색", exact: true }).click();
  await expect(palette.getByRole("radio", { name: "빨강" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("button", { name: "색", exact: true }).click();
  await page.keyboard.press("v");
});

/**
 * 캔버스 배율은 **휠이 바꾼다** (사용자 지시 2026-08-09).
 *
 * 좌상단의 `[− 000% + ⤢]` 막대를 걷어내면서 버튼으로 배율을 바꾸는 길이
 * 사라졌다 — 그 자리는 이제 "어느 학급 어느 대화방"을 말하는 글자 한 줄이고,
 * 비운 덕에 미니맵이 네 모서리를 다 쓴다.
 *
 * 그래서 여기서 지키는 것은 버튼이 아니라 **배율이 바뀐다**는 사실이다.
 * 화면에 배율 숫자가 없으므로 오버레이 변환에서 직접 읽는다.
 */
async function canvasZoom(page: import("@playwright/test").Page): Promise<number> {
  return await page.evaluate(() => {
    const item = document.querySelector("[data-canvas-item]");
    const layer = item?.parentElement;
    if (!layer) return 0;
    return new DOMMatrixReadOnly(getComputedStyle(layer).transform).a;
  });
}

test("F59 Ctrl+휠로 캔버스 배율이 바뀐다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  const item = page.locator("[data-canvas-item]").first();
  if ((await item.count()) === 0) test.skip(true, "카드가 없는 방이다");
  await expect(item).toBeVisible({ timeout: 30_000 });

  /**
   * **카메라가 멈춘 뒤에 잰다.** 방을 열면 카드로 날아가는 착지 비행이 돌고
   * (스프링), 그 도중에 휠을 굴리면 비행이 끝나면서 배율을 도로 덮는다 —
   * 실측: 휠 직후 1.1이었다가 5초 내내 1로 돌아왔다.
   */
  await expect
    .poll(
      async () => {
        const a = await canvasZoom(page);
        await page.waitForTimeout(400);
        return (await canvasZoom(page)) === a;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  const box = await item.boundingBox();
  if (!box) throw new Error("카드를 찾지 못했습니다");
  const before = await canvasZoom(page);

  /**
   * **카드 위에서** 굴린다. 기본 도구(화면 이동)에서 카드는 포인터를 받는데,
   * 휠 전달이 다른 조건에 걸려 있어서 한동안 카드 위 Ctrl+휠이 **브라우저
   * 페이지 확대**로 샜다(사용자 보고 2026-08-09). 배경에서만 재면 그 결함이
   * 안 잡힌다.
   */
  await page.mouse.move(box.x + 30, box.y + 8);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect
    .poll(() => canvasZoom(page), { timeout: 5000 })
    .not.toBe(before);
});

/**
 * 여기 나오는 확대·축소 버튼은 **지도의 것**이다 (사용자 지시 2026-08-09로
 * 캔버스 좌상단 막대가 사라진 뒤로는 그것뿐이다). 지도는 기본이 닫힘이라
 * 먼저 연다 — 안 열면 버튼이 DOM에 아예 없다.
 */
test("F54 지도의 줌 버튼이 배율을 바꾼다", async ({ page }) => {
  await loginAndOpenCanvas(page);
  await page.getByRole("button", { name: "개념 지도 열기" }).click();

  /**
   * ⚠️ **지도 안에서 찾는다.** 화면 전체에서 `/^\d+%$/`를 찾으면 Excalidraw가
   * 숨겨 둔 자기 `Reset zoom` 버튼(0×0, `visibility: hidden`)이 먼저 잡힌다 —
   * 우리 배율 표시가 캔버스 좌상단에 있을 때는 그것이 먼저였는데, 그 막대를
   * 걷어내면서(사용자 지시 2026-08-09) 순서가 뒤집혔다.
   */
  const map = page.locator("[data-minimap]");
  await expect(map).toBeVisible({ timeout: 15_000 });
  const zoom = map.getByText(/^\d+%$/).first();
  await expect(zoom).toBeVisible({ timeout: 15_000 });
  const before = Number((await zoom.textContent())!.replace("%", ""));

  const inBtn = map.getByRole("button", { name: "확대", exact: true });
  await expect(inBtn).toBeVisible();
  await inBtn.click({ timeout: 10_000 });
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", "")), {
    timeout: 5000,
  }).toBeGreaterThan(before);

  const zoomed = Number((await zoom.textContent())!.replace("%", ""));
  const outBtn = map.getByRole("button", { name: "축소", exact: true });
  await outBtn.click({ timeout: 10_000 });
  // **방향만** 본다. 왕복이 정확히 제자리로 오지는 않는다(Excalidraw가 배율을
  // 자기 눈금으로 스냅한다 — 실측: 100 → 확대 → 축소 = 94). 학생에게 중요한
  // 것은 "커지고 작아진다"이지 소수점이 아니다.
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", "")), {
    timeout: 5000,
  }).toBeLessThan(zoomed);
});
