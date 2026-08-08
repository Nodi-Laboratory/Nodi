import { ClassDetailClient } from "./ClassDetailClient";

/**
 * 학급 상세 라우트 (D209).
 *
 * 서버 껍데기인 이유는 캔버스 라우트와 같다 — 로그인한 교사의 학급이라
 * 정적으로 만들 것이 없고, 설정을 달지 않으면 Next가 정적 경로를 모으려
 * 페이지 모듈을 워커에서 평가한다.
 */
export const dynamic = "force-dynamic";

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;
  return <ClassDetailClient classId={classId} />;
}
