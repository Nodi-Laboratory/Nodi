"use client";

/**
 * 내 공간이 아닌 주소를 열었을 때 **무슨 일인지 말한다** (D201).
 *
 * 학생이 주소를 잘못 붙여 넣거나 지난 학기 학급 링크를 누르면, 지금까지는
 * **빈 캔버스가 그대로 열렸다.** 도구 레일도 뜨고 "제목 없는 대화"도 뜨는데
 * 질문창은 영영 잠겨 있다 — 콘솔에만 403·404가 찍힌다(실측 2026-08-07).
 *
 * 이 저장소가 D168에서 이미 한 번 싸운 모양이다: **화면은 떴는데 아무것도 안
 * 되는 상태를 만들지 않는다.** 없는 방이면 없다고 말하고 돌아갈 길을 준다.
 *
 * 개인 공간은 언제나 내 것이라 검사하지 않는다. 학급은 `/auth/me/classes`가
 * 진실이고, 그 조회가 **성공적으로** 끝났을 때만 판정한다 — 네트워크가 잠깐
 * 끊긴 것으로 학생을 내보내면 그게 더 나쁘다(StudentShellGuard와 같은 규칙).
 */

import Link from "next/link";
import { useMyClasses } from "@/lib/hooks";

export function SpaceGuard({
  spaceId,
  children,
}: {
  spaceId: string;
  children: React.ReactNode;
}) {
  const { data: classes, isSuccess } = useMyClasses();

  const 개인 = spaceId === "personal";
  const 내학급 = (classes ?? []).some((c) => c.class_id === spaceId);
  const 없는방 = !개인 && isSuccess && !내학급;

  if (!없는방) return <>{children}</>;

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <h1 className="text-lg font-semibold text-fg">들어갈 수 없는 학급이에요</h1>
      <p className="max-w-md text-sm leading-relaxed text-fg-muted">
        이 학급에 속해 있지 않거나, 주소가 잘못됐어요. 선생님께 받은 학급 코드로
        참여하면 여기서 함께 공부할 수 있어요.
      </p>
      <div className="flex gap-2">
        <Link
          href="/home"
          className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110"
        >
          홈으로
        </Link>
        <Link
          href="/space/personal"
          className="rounded-lg border border-accent-border/50 px-4 py-2 text-sm text-fg transition-colors hover:bg-accent-soft/60"
        >
          내 캔버스로
        </Link>
      </div>
    </main>
  );
}
