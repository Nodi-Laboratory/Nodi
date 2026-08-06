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
    /**
     * 기본은 dev 서버다. **성능을 잴 때는 프로덕션 빌드를 가리켜야 한다** —
     * `next dev`는 React 개발 모드라 `jsxDEV`·`validateProperty`·
     * `logComponentRender`가 CPU의 큰 몫을 먹는다. 실측 2026-08-06: 줌
     * 프로파일 상위가 통째로 그 계측이었고, 그래서 리렌더를 줄여도 숫자가
     * 꿈쩍하지 않았다 — **재는 대상이 제품이 아니었다.**
     *
     *   npm run build && npx next start -p 3100
     *   PLAYWRIGHT_BASE_URL=http://localhost:3100 npx playwright test
     */
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
