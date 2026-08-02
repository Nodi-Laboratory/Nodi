import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 설정 (D147 검증).
 *
 * 캔버스 조작(드래그·수정·삭제)과 **새로고침 후 위치 영속**은 순수 함수 단위
 * 테스트로는 못 잡는다 — DOM 이벤트·서버 왕복·재수화가 얽혀 있다. 이 스위트가
 * 실제 브라우저로 그 왕복을 확인한다.
 *
 * 로컬 스택이 떠 있어야 한다(README '빠른 시작'):
 *   docker compose up -d · 백엔드 8000 · 프론트 3000.
 * 계정은 시드하지 않으므로 CLI로 만든 e2e-student@nodi.test 를 쓴다.
 */
export default defineConfig({
  testDir: "./e2e",
  // 캔버스는 애니메이션(스프링·전이)이 있어 여유를 둔다.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
