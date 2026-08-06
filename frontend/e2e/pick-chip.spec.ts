import { expect, test } from "@playwright/test";
import { loginAndOpenCanvas, openFreshSession } from "./helpers";

/**
 * 답을 기다리는 동안 고른 카드가 **턴이 끝나도 살아남는지** 본다 (D187).
 *
 * `d-ask.spec`이 "카드를 누르면 인용 칩이 붙는다"를 확인한 직후 그 칩을 누르다
 * 실패했다(실측 2026-08-06: `element was detached from the DOM`). 칩은 상태가
 * 아니라 **`pickedId`에서 파생**되므로(D151), 초점이 어긋나면 칩이 조용히 사라진다.
 *
 * 원인이 **둘**이었고 어느 하나만 고쳐서는 낫지 않았다(실측으로 갈랐다):
 *
 *   1. 저장이 끝나며 카드 id가 `tmp-N` → UUID로 갈리는데 `pickedId`는 그대로다.
 *   2. 스트림이 끝나며 `handleSend`의 `.then`이 초점을 **무조건** 덮어썼다.
 *      아무것도 안 골랐던 턴이면 `nextFocus(null, null, …)`가 null이라 지워진다.
 *
 * 학생 눈에는 "이어 묻기를 골랐는데 표시가 없어졌다"이고, 그대로 질문을 보내면
 * **엉뚱한 자리(뿌리)에 답이 붙는다.** 화면에도 로그에도 안 드러난다.
 *
 * ⚠️ CI는 e2e를 안 돌린다(라이브 스택이 필요하다). 회귀의 실질적 방어선은
 * `lib/canvas2/idRemap.test.ts`이고, 이 스펙은 **두 원인이 겹친 실물 경로**를
 * 확인한다 — 순수 함수가 맞아도 배선이 틀리면 화면만 틀린다.
 */
test("고른 카드는 저장이 끝나도 계속 고른 상태다", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAndOpenCanvas(page);
  await openFreshSession(page);

  await page.getByLabel("질문 입력").fill("빛의 굴절이 뭐야?");
  await page.getByLabel("보내기").click();

  const items = page.locator("[data-canvas-item]");
  // **답이 뜨자마자** 고른다 — 스트림이 끝나기도 전이다. 학생이 실제로 하는
  // 일이 그것이고, 이 결함이 사는 창이 정확히 여기다: 이때 카드 id는 아직
  // 임시(`tmp-N`)이고, 저장이 끝나면 서버 UUID로 갈린다.
  await expect(items).not.toHaveCount(0, { timeout: 120_000 });
  const first = items.first();
  const idAtPick = await first.getAttribute("data-canvas-item");
  await first.click();

  const chip = page.getByLabel("이어 묻기 그만두기");
  await expect(chip, `고를 때 id=${idAtPick}`).toBeVisible({ timeout: 10_000 });

  // 스트림이 끝나고 저장 왕복까지 지난 뒤에도 **여전히** 붙어 있어야 한다.
  await expect(page.getByText(/생각하고 있어요/)).toBeHidden({ timeout: 120_000 });
  await page.waitForTimeout(4000);
  const idsAfter = await items.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-canvas-item")),
  );
  await expect(
    chip,
    `고른 id=${idAtPick}\n저장 뒤 화면의 id들=${JSON.stringify(idsAfter)}\n` +
      `그 id가 아직 있나=${idsAfter.includes(idAtPick)}`,
  ).toBeVisible();
  await chip.click();
  await expect(chip).toBeHidden({ timeout: 10_000 });
});
