import { SessionMapClient } from "./SessionMapClient";

/**
 * 대화방 지도 라우트 (D209).
 *
 * 서버 껍데기인 이유는 형제 라우트(`../page.tsx`)와 같다 — 라우트 설정은
 * 서버 모듈에서만 읽히고, 그것이 없으면 Next가 동적 구간의 정적 경로를
 * 모으려다 워커에서 죽는다.
 */
export const dynamic = "force-dynamic";

export default async function SessionMapPage({
  params,
}: {
  params: Promise<{ spaceId: string }>;
}) {
  const { spaceId } = await params;
  return <SessionMapClient spaceId={spaceId || "personal"} />;
}
