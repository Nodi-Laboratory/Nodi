import { expect, type Page, type Locator } from "@playwright/test";

/**
 * E2E 공용 헬퍼 (D147 검증).
 *
 * 계정은 시드하지 않으므로 CLI로 만든 학생 계정을 쓴다:
 *   uv run python -m app.cli create-user e2e-student@nodi.test 'e2ePass!234' --role student
 */
export const E2E_EMAIL = "e2e-student@nodi.test";
export const E2E_PASSWORD = "e2ePass!234";

/** 표준 UUID — 임시 id(local-note-*)와 구분한다. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 로그인 → (필요 시 온보딩) → 개인 세션 캔버스로 들어가 준비될 때까지 기다린다. */
export async function loginAndOpenCanvas(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(E2E_EMAIL);
  await page.locator('input[name="password"]').fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "로그인" }).click();

  await page.waitForURL(/\/(onboarding|home|space|teacher|admin)/);
  // 첫 로그인이면 온보딩을 거친다 — 학급 없이 시작한다.
  if (page.url().includes("/onboarding")) {
    await page.getByRole("button", { name: /학급 없이 시작|완료하고 시작/ }).click();
    await page.waitForURL("**/home");
  }

  await openCanvas(page);
}

/** 개인 세션 캔버스로 이동해 세션이 바인딩(AskBar 활성)될 때까지 기다린다. */
export async function openCanvas(page: Page): Promise<void> {
  await page.goto("/space/personal");
  // 세션이 붙기 전에는 질문창이 비활성이다("세션을 준비하는 중이에요").
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 캔버스 스테이지가 떴는지 확인.
  await expect(page.locator(".canvas2")).toBeVisible();
}

/**
 * 빈 대화를 하나 열어 캔버스를 비운다.
 *
 * `createNote`는 캔버스의 **고정 좌표**를 클릭해 노트를 만든다. 개인 세션은
 * 지난 실행이 남긴 글로 차 있어서 그 자리가 이미 카드에 덮여 있으면 클릭이
 * 카드 선택으로 먹히고 편집기가 뜨지 않는다 — 실측 2026-08-04: 이 이유로
 * `canvas.spec`·`tag.spec`이 둘 다 createNote에서 타임아웃했다. 세션을 새로
 * 열면 매 실행이 같은 조건에서 시작한다.
 */
export async function openFreshSession(page: Page): Promise<void> {
  /**
   * **전환이 끝날 때까지 기다린다.**
   *
   * 처음에는 "아이템 0개 + 질문창 활성"으로만 판정했는데, 그 둘은 이전 빈
   * 대화에서도 참이라 아무것도 확인하지 못했다(실측 2026-08-05: 그 사이에
   * 파일을 붙이면 앞 대화로 들어갔다). 그래서 **대화 id가 바뀐 것**을 봤다.
   *
   * ⚠️ 그 판정이 **D202(2026-08-07)로 틀린 것이 됐다.** 서버는 이제 이
   * 공간의 가장 최근 대화가 비어 있으면(제목 없고 · 카드 없고 · 파일 없고)
   * **새로 만들지 않고 그 행을 돌려준다** — 빈 대화 211개가 쌓여 목록을
   * 덮은 실측이 근거다. 그러니 id는 **같은 것이 정상**이다.
   *
   * 이 단정 하나 때문에 스위트가 통째로 빨갰다 — `openFreshSession`을
   * 부르는 스펙이 18개라 전부 여기서 멈췄다(실측 2026-08-09). 늘 빨간
   * 스위트는 없는 것보다 나쁘다. 아무도 안 읽는다.
   *
   * 이제 **id 대신 조건**을 본다. 스펙이 실제로 필요한 것은 "새 행"이 아니라
   * **비어 있고 내 것인 대화**다 — D202가 재사용하는 대화도 그 조건을 이미
   * 만족한다(서버가 파일까지 확인하고 준다).
   */
  // 지난 대화 서랍을 여는 곳은 **캔버스 상단 바의 삼선**이다(사용자 지시
  // 2026-08-09). 사이드바에 잠깐 [기록]으로 있었는데 되돌렸다 — 대화방을
  // 오가는 일은 캔버스 안에서 하는 일이라는 판단이다.
  await page.getByRole("button", { name: "지난 대화" }).click();
  // 목록의 세션 행에도 "새 대화"라는 글자가 뜬다(제목 없는 세션의 기본 이름).
  // 만드는 버튼은 title 속성으로 정확히 집는다.
  await page.locator('button[title="새 대화"]').click();
  await expect(page.locator("[data-canvas-item]")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  // 세션이 **정해졌는지**는 봐야 한다 — 비어 있으면 캔버스가 읽지도 쓰지도
  // 않으므로(D148), 그 상태로 시작한 스펙은 엉뚱한 곳에서 실패한다.
  await expect
    .poll(() => page.locator(".canvas2").getAttribute("data-session"), {
      timeout: 30_000,
    })
    .toMatch(/^[0-9a-f-]{36}$/);
  // 서랍을 닫아 캔버스를 가리지 않게 한다.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/**
 * 도구를 고른다 — **묶음은 펼쳐야 나온다** (사용자 지시 2026-08-09).
 *
 * 도구바가 짧아지면서 펜(연필·형광펜·글 쓰기)과 도형(네모·세모·별·화살표·선)이
 * 각각 한 단추 뒤로 접혔다. 스펙마다 "먼저 펴고 고른다"를 적어 두면 다음에
 * 묶음이 바뀔 때 전부 고쳐야 하므로 여기 한곳에 둔다.
 */
const PEN_GROUP = ["자유선", "형광펜", "글 쓰기"];
const SHAPE_GROUP = ["네모", "세모", "별", "화살표", "선"];

export async function selectTool(page: Page, label: string): Promise<void> {
  const group = PEN_GROUP.includes(label)
    ? "펜"
    : SHAPE_GROUP.includes(label)
      ? "도형"
      : null;
  if (group) await page.getByRole("button", { name: group, exact: true }).click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

/**
 * 질문하는 펜을 켜고 끈다 — **입력창 왼쪽 토글**이다 (사용자 지시 2026-08-09).
 *
 * 도구 레일에서 뺐다. 자판으로 물을지 손으로 써서 물을지는 "무엇을 그릴까"가
 * 아니라 "어떻게 물을까"라, 물음이 시작되는 자리에 있어야 한다.
 */
export async function setAskPen(page: Page, on: boolean): Promise<void> {
  await page.getByLabel(on ? "펜으로 써서 묻기" : "자판으로 묻기").click();
}

/**
 * 손으로 글 노트를 하나 만들고 텍스트를 저장한 뒤, **서버에 저장(진짜 id)**
 * 될 때까지 기다려 그 노트 Locator를 돌려준다.
 *
 * 저장을 기다리는 이유: 저장 전(local-note-*) 아이템을 끌면 승격 경로가
 * 얽힌다. UUID로 바뀐 뒤 끌어야 드래그가 곧장 PATCH로 영속된다.
 */
export async function createNote(
  page: Page,
  text: string,
  pos: { x: number; y: number } = { x: 380, y: 280 },
): Promise<Locator> {
  // 글쓰기 도구 선택 후 빈 캔버스를 클릭 → 그 자리에 편집 중인 빈 노트가 생긴다.
  await selectTool(page, "글 쓰기");
  await page.locator(".canvas2").click({ position: pos });

  const editor = page.getByLabel("본문 수정");
  await editor.waitFor({ state: "visible" });
  await editor.fill(text);
  // Ctrl+Enter로 커밋(= blur). 노트 도구는 생성 직후 선택 도구로 돌아간다.
  await editor.press("Control+Enter");

  const note = noteByText(page, text);
  await expect(note).toBeVisible();
  // 서버 저장이 끝나 data-canvas-item이 UUID로 바뀔 때까지 기다린다.
  await expect
    .poll(async () => note.getAttribute("data-canvas-item"), { timeout: 15_000 })
    .toMatch(UUID_RE);
  return note;
}

/** 본문 텍스트로 캔버스 아이템을 찾는다. */
export function noteByText(page: Page, text: string): Locator {
  return page.locator("[data-canvas-item]").filter({ hasText: text });
}

/** 아이템의 world 좌표(인라인 left/top). 배치·영속의 단위다. */
export async function itemPos(note: Locator): Promise<{ x: number; y: number }> {
  return note.evaluate((el) => ({
    x: parseFloat((el as HTMLElement).style.left) || 0,
    y: parseFloat((el as HTMLElement).style.top) || 0,
  }));
}

/**
 * 설정 팝업을 연다 (사용자 지시 2026-08-10).
 *
 * `/profile` 페이지를 걷어내고 사이드바 버튼이 여는 팝업으로 옮겼다. 주소가
 * 안 바뀌므로 스펙도 "어디서든 열 수 있다"를 그대로 쓴다 — 어느 화면에 있든
 * 사이드바는 거기 있다.
 */
export async function openSettings(page: Page): Promise<void> {
  await page.getByLabel(/^설정/).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible({
    timeout: 15_000,
  });
}

/** 열려 있는 팝업을 닫는다. */
export async function closeDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
}

/**
 * 세션 선택 화면에서 공간 카드를 눌러 **첫 대화방으로 들어간다** (사용자 지시
 * 2026-08-09).
 *
 * 카드는 이제 곧장 들어가지 않고 **그 공간의 방 목록**을 팝업으로 편다.
 * 들어가는 길이 두 걸음이 되었으므로, 그 두 걸음을 여기 한곳에 둔다 — 스펙
 * 여럿이 각자 팝업을 알고 있으면 다음에 이 흐름이 또 바뀔 때 전부 고쳐야 한다.
 */
export async function enterSpace(page: Page, cardName: RegExp | string): Promise<void> {
  /**
   * ⚠️ **카드는 `[data-space-card]`로 잡는다.** 글자로 잡으면 아래 "최근 대화"의
   * 줄이 먼저 걸린다 — 그 줄도 어느 공간의 방인지 말하느라 같은 이름을 달고
   * 있고, `/spaces/overview`가 `/spaces/recent`보다 느려서 **카드가 뜨기 전에는
   * 그 줄이 첫 번째**다(실측 2026-08-09: 그래서 팝업 대신 캔버스로 갔다).
   */
  await page.locator("[data-space-card]").filter({ hasText: cardName }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // 방이 하나도 없는 공간은 들어갈 데가 없다 — 부르는 쪽이 알아야 한다.
  const row = dialog.locator("[data-room-row] button").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
}

/**
 * 아이템이 **UI에 안 가린 자리**로 오게 캔버스를 민다.
 *
 * 캔버스 위에는 도구 레일(오른쪽)·입력창(아래)·상단 바(위)가 늘 떠 있다.
 * 착지 카메라는 **그 턴의 카드 하나**를 UI 안쪽에 놓을 뿐이라(D166),
 * 나머지 카드는 레일 밑에 앉을 수 있다 — 학생은 밀어서 보면 되지만 테스트의
 * `hover`는 그 자리에서 그냥 막힌다(실측 2026-08-09: 상단 바가 세로를 62px
 * 먹으면서 `tag.spec`의 카드가 레일 밑으로 들어갔다).
 *
 * 미는 것은 **평 휠**이다 — 도구를 안 건드리므로 테스트가 재려는 상태를
 * 바꾸지 않는다.
 */
export async function bringIntoView(page: Page, item: Locator): Promise<void> {
  const stage = page.locator(".canvas2");
  // ⚠️ 새로고침 직후에는 상자가 아직 없다. 여기서 그냥 돌아가면 **아무것도
  // 안 밀어 놓고** 성공한 척하게 된다(실측 2026-08-09: 카드가 화면 밖에
  // 있는데 helper는 조용히 끝났고 hover가 60초를 기다렸다).
  await item.waitFor({ state: "visible", timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    const b = await item.boundingBox();
    const s = await stage.boundingBox();
    if (!b || !s) {
      await page.waitForTimeout(300);
      continue;
    }
    // UI가 먹는 자리. `lib/canvas2/focusCamera.ts`의 여백과 같은 뜻이다.
    const safe = {
      left: s.x + 40,
      right: s.x + s.width - 140,
      top: s.y + 40,
      bottom: s.y + s.height - 150,
    };
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const dx = cx > safe.right ? cx - safe.right + 80 : cx < safe.left ? cx - safe.left - 80 : 0;
    const dy = cy > safe.bottom ? cy - safe.bottom + 80 : cy < safe.top ? cy - safe.top - 80 : 0;
    if (!dx && !dy) return;
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
    await page.mouse.wheel(dx, dy);
    // 카메라는 스프링이라 한 프레임에 안 선다(D124).
    await page.waitForTimeout(400);
  }
}

/**
 * 아이템을 화면상 (dx, dy)만큼 끈다. 커스텀 pointer 핸들러라 실제 마우스
 * 입력을 단계적으로 보낸다(임계 4px를 넘겨 클릭이 아니라 드래그로 인식되게).
 */
export async function dragBy(page: Page, note: Locator, dx: number, dy: number): Promise<void> {
  const box = await note.boundingBox();
  if (!box) throw new Error("아이템 박스를 찾지 못했습니다");
  const cx = box.x + Math.min(box.width / 2, 40);
  const cy = box.y + Math.min(box.height / 2, 20);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 5 });
  await page.mouse.move(cx + dx, cy + dy, { steps: 5 });
  await page.mouse.up();
}

/**
 * 시드가 심어 둔 **도판 세션**을 이름으로 골라 연다 (D200).
 *
 * `/space/personal`은 가장 최근 대화를 여는데, 앞선 스펙들이 새 대화를 만들면
 * 그 세션이 더 최신이 된다 — 그러면 도판 스펙이 시드 카드를 못 보고 조용히
 * 건너뛴다. **혼자 돌릴 때는 되고 전체로 돌리면 안 되는** 종류의 흔들림이라,
 * 순서에 기대지 않고 목록에서 직접 고른다.
 */
export async function openSeededFigureSession(page: Page): Promise<void> {
  await page.goto("/space/personal");
  await expect(page.getByLabel("질문 입력")).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "지난 대화" }).click();
  /**
   * **이름으로 찾아 연다.** 목록은 최근 200개까지만 오므로(`_LIST_CAP`),
   * 대화가 쌓인 계정에서는 시드 세션이 그 밖으로 밀려난다. 찾기는 서버가
   * 하므로 상한 밖도 이름으로 불러온다.
   */
  await page.getByLabel("대화 찾기").fill("E2E 도판 세션");
  const row = page.getByRole("dialog").getByText("E2E 도판 세션").first();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-canvas-item]")).not.toHaveCount(0, {
    timeout: 20_000,
  });
}
