import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest 설정 (D105).
 *
 * 프론트에 테스트가 0개였다. 검증은 `tsc --noEmit` + `next build` 스모크뿐이라,
 * **타입이 맞으면 통과**했다 — 배치 알고리즘이 좌표를 틀리게 계산해도, 파서가
 * 제어 토큰을 흘려도 아무도 못 잡는다. 실제로 그 두 가지가 다 일어났다
 * (2026-07-27 `/end` 누출, `==강조==` 누출).
 *
 * 첫 대상은 `lib/concept/` — 캔버스 배치와 스트림 파싱이다. 순수 함수에 가까워
 * 러너 설정이 거의 필요 없고(환경 node로 충분), 회수율이 가장 높다.
 * 컴포넌트 렌더 테스트는 jsdom·testing-library가 더 필요하므로 후속으로 둔다.
 */
export default defineConfig({
  resolve: {
    // 소스와 같은 `@/` 별칭 — tsconfig paths와 맞춘다.
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      reporter: ["text-summary"],
    },
  },
});
