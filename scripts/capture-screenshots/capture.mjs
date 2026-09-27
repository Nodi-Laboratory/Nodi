#!/usr/bin/env node
/**
 * README 스크린샷 캡처 — Playwright(headless)로 실행 중인 앱에 접속해 찍는다.
 *
 * 전제
 *   1. 앱이 떠 있다:  cp .env.example .env && docker compose up -d   (SEED_DEMO=true)
 *   2. Playwright가 설치돼 있다(프론트 devDependency를 빌려 쓴다):
 *        cd frontend && npm ci && npx playwright install chromium
 *
 * 실행 (저장소 루트에서)
 *   node scripts/capture-screenshots/capture.mjs
 *   APP_URL=http://localhost:3400 node scripts/capture-screenshots/capture.mjs
 *
 * 결과: image/*.png (1440×900). 데모 계정(demo · teacher · admin / demo1234)으로
 * 로그인해 시드 데이터가 채워진 화면을 로딩이 끝난 뒤 찍는다.
 *
 * API 키는 화면에 절대 나오지 않는다:
 *   - 키 입력 화면은 **빈 칸** 상태로 찍는다.
 *   - 나머지 화면은 "키가 있을 때"의 모습을 보이려고 localStorage에 **더미 문자열**을
 *     넣는다. 실제 호출은 하지 않고(시드 데이터를 보여 줄 뿐), 더미 값이 표시되는
 *     곳도 없다(입력칸은 password 타입이고, 그 화면에서는 더미를 먼저 지운다).
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

const APP_URL = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const OUT = join(ROOT, "image");
const PASSWORD = "demo1234";
const KEYS_STORAGE = "nodi.apiKeys.v1";
const PROMPTED = "nodi.apiKeys.prompted";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    deviceScaleFactor: 1,
  });
  return context.newPage();
}

async function shot(page, name) {
  // 글꼴·이미지·애니메이션이 가라앉을 시간을 준다.
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ image/${name}.png`);
}

async function login(page, username) {
  await page.goto(`${APP_URL}/login`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** "키가 있는" 화면을 보이기 위한 더미 값. 실제 키가 아니며 화면에 나오지 않는다. */
async function setDummyKeys(page) {
  await page.evaluate(
    ([k, p]) => {
      localStorage.setItem(
        k,
        JSON.stringify({ upstage: "dummy", gemini: "dummy", geminiModel: "gemini-3.5-flash-lite" }),
      );
      localStorage.setItem(p, "1");
    },
    [KEYS_STORAGE, PROMPTED],
  );
}

/** 세션 화면에서 공간 카드 → 대화방을 골라 캔버스로 들어간다. */
async function openRoom(page, spaceName, roomTitle) {
  await page.goto(`${APP_URL}/sessions`);
  await page.locator(`[data-space-card]:has-text("${spaceName}")`).first().click();
  await page.locator(`[data-room-row]:has-text("${roomTitle}")`).first().click();
  await page.waitForSelector(".canvas2", { timeout: 30_000 });
  // 카드가 그려지고 카메라가 새 카드로 날아가는 것까지 기다린다.
  await page.waitForTimeout(3500);
}

/** 빈 자리에서 Ctrl+휠로 축소한다(Excalidraw가 뷰포트를 소유한다). */
async function zoomOut(page, notches, at = { x: 760, y: 470 }) {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down("Control");
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(120);
  }
  await page.keyboard.up("Control");
  await page.waitForTimeout(900);
}

async function pan(page, dx, dy) {
  // 휠(Ctrl 없이)은 화면 이동이다.
  await page.mouse.move(760, 470);
  await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(600);
}

try {
  console.log(`캡처 대상: ${APP_URL}`);

  // --- 로그인 화면 --------------------------------------------------------
  {
    const page = await newPage();
    await page.goto(`${APP_URL}/login`);
    await shot(page, "login");
    await page.context().close();
  }

  // --- 학생(demo) ---------------------------------------------------------
  {
    const page = await newPage();
    await login(page, "demo");

    // 키 입력 화면 — 서버 .env에 키가 없으면 첫 진입(로그인 직후 홈)에서 뜬다.
    // 새 브라우저 컨텍스트라 저장된 키가 없다 → 칸은 비어 있다.
    await page.waitForSelector('[data-testid="api-key-dialog"]', { timeout: 15_000 });
    await shot(page, "api-key-settings");
    await page.keyboard.press("Escape");

    // 키가 없을 때 기능만 잠기고 안내가 뜨는 모습(캔버스 입력창).
    await openRoom(page, "2학년 3반 과학", "광합성은 어떻게");
    await shot(page, "no-key-notice");

    // 이후 화면은 "키가 있는" 상태로.
    await setDummyKeys(page);

    await page.goto(`${APP_URL}/home`);
    await page.waitForTimeout(2500);
    await shot(page, "home-concept-map");

    await page.goto(`${APP_URL}/sessions`);
    await page.waitForSelector("[data-space-card]");
    await shot(page, "session-picker");

    // 대표 이미지: 학급 대화 캔버스(개념 카드 + 교과서 도판)
    await openRoom(page, "2학년 3반 과학", "광합성은 어떻게");
    await zoomOut(page, 3);
    await shot(page, "canvas-concept-cards");

    // 개념 카드 + 강의 클립
    await openRoom(page, "2학년 3반 과학", "전자석은 왜");
    await shot(page, "canvas-lecture-clip");

    // 개인 세션 — 다른 과목 대화와의 개념 연결
    await openRoom(page, "개인 세션", "원자랑 분자");
    await zoomOut(page, 2);
    await shot(page, "canvas-crosslink");

    await page.context().close();
  }

  // --- 선생님 -------------------------------------------------------------
  {
    const page = await newPage();
    await login(page, "teacher");
    await page.waitForSelector("text=2학년 3반 과학");
    await page.locator("button:has-text('2학년 3반 과학'), [role=button]:has-text('2학년 3반 과학')").first().click();
    await page.waitForURL(/\/teacher\/.+/);
    await page.waitForTimeout(1500);
    // 학생 한 명 → 그 학생의 학급 대화 하나를 열어 읽기 전용 기록을 보인다.
    await page.getByText("김하늘").first().click();
    await page.waitForTimeout(1500);
    await page.getByText("광합성은 어떻게").first().click();
    await page.waitForTimeout(2500);
    await shot(page, "teacher-students");
    await page.getByRole("button", { name: /자료/ }).first().click();
    await page.waitForTimeout(2000);
    await shot(page, "teacher-materials");
    await page.context().close();
  }

  // --- 관리자 -------------------------------------------------------------
  {
    const page = await newPage();
    await login(page, "admin");
    await page.waitForURL(/\/admin/);
    await page.waitForTimeout(2500);
    await shot(page, "admin-overview");
    await page.context().close();
  }

  console.log("완료");
} finally {
  await browser.close();
}
