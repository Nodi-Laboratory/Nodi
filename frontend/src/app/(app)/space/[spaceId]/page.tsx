import { SpaceClient } from "./SpaceClient";

/**
 * 학습 캔버스 라우트 (D209).
 *
 * ## 왜 서버 껍데기인가
 *
 * 예전에는 이 파일이 통째로 `"use client"`였다. 그러면 **라우트 설정을 달
 * 방법이 없다** — `export const dynamic`은 서버 모듈에서만 읽힌다. 그래서
 * Next가 동적 구간(`[spaceId]`)의 정적 경로를 모으려고 이 페이지 모듈을
 * 별도 워커에서 평가했고, 그 워커가 캔버스 그래프(Excalidraw CSS·손글씨
 * 폰트 3조각·1,900행짜리 작업대)를 통째로 들이다 죽었다:
 *
 *     ⨯ Failed to generate static paths for /space/[spaceId]:
 *       Jest worker encountered 2 child process exceptions
 *
 * 화면에는 **런타임 오류 오버레이**로 뜨는데 정작 요청은 200으로 돌아온다 —
 * "되는데 에러가 뜬다"라 원인을 찾기 어렵다(사용자 보고 2026-08-08).
 *
 * 이 페이지는 로그인한 사람의 캔버스라 애초에 정적으로 만들 것이 없다.
 * `force-dynamic`으로 그 단계를 아예 건너뛴다.
 */
export const dynamic = "force-dynamic";

export default async function SpacePage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  return <SpaceClient spaceId={spaceId || "personal"} />;
}
