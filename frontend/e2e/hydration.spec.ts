import { expect, test } from "@playwright/test";

/**
 * 브라우저 확장이 DOM을 고쳐도 콘솔이 조용한가 (2026-08-04).
 *
 * 크롬의 비밀번호 관리자·자동완성은 React가 붙기 **전에** 로그인 화면을
 * 고친다 — `<html __gcrremoteframetoken>` · `<form __gcruniqueid>`. 서버가 보낸
 * HTML에는 없는 속성이라 하이드레이션 불일치로 잡히고, **매 로드마다 콘솔에
 * 빨간 오류**가 찍힌다(dev 서버 터미널에도 그대로 올라온다).
 *
 * Playwright의 크로미움에는 확장이 없어 그냥 두면 이 결함이 **영영 안 잡힌다.**
 * 그래서 확장이 하는 일을 흉내 낸다.
 *
 * 실패하면 `app/layout.tsx`·`components/auth/AuthForm.tsx`의
 * `suppressHydrationWarning`이 빠진 것이다.
 */

/** React가 붙기 전에 표식을 남긴다 — 확장과 같은 순서. */
const EXTENSION = () => {
  const stamp = () => {
    document.documentElement?.setAttribute("__gcrremoteframetoken", "deadbeef");
    document.querySelectorAll("form").forEach((f, i) => {
      f.setAttribute("__gcruniqueid", String(i + 1));
    });
  };
  stamp();
  new MutationObserver(stamp).observe(document, { childList: true, subtree: true });
};

test("확장이 로그인 화면을 고쳐도 하이드레이션 오류가 안 난다", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await page.addInitScript(EXTENSION);
  await page.goto("/login");
  // 하이드레이션은 번들이 붙은 뒤다 — 폼이 실제로 동작할 때까지 기다린다.
  await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
  await page.waitForTimeout(2000);

  // **오염이 실제로 됐는지 먼저 본다.** 안 됐으면 이 테스트는 아무것도 안 지킨다.
  const stamped = await page.evaluate(() => ({
    html: document.documentElement.hasAttribute("__gcrremoteframetoken"),
    form: !!document.querySelector("form[__gcruniqueid]"),
  }));
  expect(stamped).toEqual({ html: true, form: true });

  expect(errors.join("\n")).toBe("");
});
