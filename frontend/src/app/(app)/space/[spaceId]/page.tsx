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
  searchParams,
}: {
  params: Promise<{ spaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { spaceId } = await params;
  /**
   * `?map=1`이면 **지도를 연 채로** 연다 (2026-08-11).
   *
   * 지도 페이지(`/space/[id]/map`)는 배치 사진이 없으면 아무것도 못 그려서
   * 주소로 들어오면 막다른 길이었다. 이제 그 페이지가 이리로 넘기는데,
   * "지도를 보러 왔다"는 뜻이 함께 와야 한다.
   *
   * ⚠️ **여기(서버)에서 읽는다.** 클라이언트에서 `window.location`을 읽으면
   * 넘어온 직후 한 프레임 동안 옛 주소일 수 있다 — 실측 2026-08-11: 넘김은
   * 됐는데 지도가 안 열렸다.
   */
  const sp = await searchParams;
  return (
    <SpaceClient spaceId={spaceId || "personal"} openMap={sp.map === "1"} />
  );
}
