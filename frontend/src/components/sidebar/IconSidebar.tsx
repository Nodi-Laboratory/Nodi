"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Home,
  Settings,
  Shield,
  School,
  User,
  type LucideIcon,
} from "lucide-react";
import { useMyClasses, useProfile } from "@/lib/hooks";
import { listSessions, spaceTargetFromId } from "@/lib/api";
import { sessionsKey, STALE } from "@/lib/queries";
import { roleHome } from "@/lib/roleHome";

/**
 * 좌측 64px 아이콘 사이드바 (dark brown).
 * 항목: [홈 진입] · [공간 전환: 개인 + 가입 학급] · [프로필·설정]
 * 공간은 실제 데이터(개인 + class_members→classes). 미로그인/로딩 시에도 셸이 깨지지 않음.
 */

function NavIcon({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep ${
        active
          ? "bg-accent-soft text-sidebar-fg-active"
          : "text-sidebar-fg hover:bg-accent-soft/60 hover:text-sidebar-fg-active"
      }`}
    >
      {active ? (
        <span className="absolute -left-2 h-5 w-1 rounded-full bg-accent-deep" />
      ) : null}
      <Icon size={20} strokeWidth={2} />
    </Link>
  );
}

/**
 * 공간 전환 배지 (D100).
 *
 * 과거에는 개인 공간이 "개인"(2글자), 학급이 이름 첫 글자(1글자)를 40px 원 안에
 * 넣어 표기 규칙이 서로 달랐다 — 화면상 "개인"과 "로"가 나란히 놓여 잘린 것처럼
 * 보였다. 이제 개인 공간은 **아이콘**, 학급은 **머리글자 1자**로 종류를 형태로
 * 구분한다. 텍스트를 원 안에 우겨넣지 않으므로 이름 길이에 영향받지 않는다.
 */
function SpaceBadge({
  href,
  label,
  active,
  icon: Icon,
  initial,
  onPrefetch,
}: {
  href: string;
  label: string;
  active: boolean;
  /** 개인 공간처럼 고정 의미를 가진 공간은 아이콘으로 표시한다. */
  icon?: LucideIcon;
  /** 학급처럼 이름이 다양한 공간은 머리글자 1자로 표시한다. */
  initial?: string;
  onPrefetch?: () => void;
}) {
  return (
    <Link
      href={href}
      onMouseEnter={onPrefetch}
      title={`공간 전환: ${label}`}
      aria-label={`공간 전환: ${label}`}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep ${
        active
          ? "border-accent-deep bg-accent text-accent-fg"
          : "border-accent-border text-sidebar-fg hover:border-accent-deep hover:text-sidebar-fg-active"
      }`}
    >
      {Icon ? <Icon size={18} strokeWidth={2} /> : initial}
    </Link>
  );
}

function initials(name: string | null | undefined, fallback: string) {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 1).toUpperCase();
}

export function IconSidebar() {
  const pathname = usePathname();
  const { data: profile } = useProfile();
  const { data: myClasses = [] } = useMyClasses();
  const queryClient = useQueryClient();

  const role = profile?.role ?? null;
  const isStudent = !role || role === "student";

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // 08 G: 공간 배지 hover 시 그 공간의 세션 목록을 선반입(공간 전환 즉시 표시).
  const prefetchSpace = (spaceId: string) => {
    const target = spaceTargetFromId(spaceId);
    void queryClient.prefetchQuery({
      queryKey: sessionsKey(target),
      queryFn: () => listSessions(target),
      staleTime: STALE.sessions,
    });
  };

  return (
    <nav
      aria-label="주 메뉴"
      /**
       * 크롬 배율 (사용자 지시 2026-08-08). `zoom`은 이 안에 좌표 계산이 없을
       * 때만 안전하다 — 사이드바는 버튼뿐이라 괜찮다(캔버스에는 절대 못 건다,
       * `lib/ui/scale.ts` 참조).
       */
      style={{ zoom: "var(--ui-scale, 1)" }}
      className="flex h-full w-16 shrink-0 flex-col items-center gap-3 border-r border-accent-border/40 bg-bg-sidebar py-3"
    >
      {/* 브랜드 마크 */}
      <Link
        href={roleHome(role)}
        title="nodi"
        aria-label="nodi"
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent font-bold text-accent-fg"
      >
        n
      </Link>

      {/* 학생 전용: 홈 · 공간 · 개념 */}
      {isStudent && (
        <>
          <NavIcon href="/home" label="홈" icon={Home} active={isActive("/home")} />

          <div className="my-1 h-px w-8 bg-accent-border/50" />

          {/* min-h-0가 있어야 flex 부모 안에서 실제로 스크롤된다 — 없으면 학급이
              많을 때 목록이 사이드바 밖으로 밀려 하단 프로필 버튼을 가린다. */}
          <div className="flex min-h-0 flex-col items-center gap-2 overflow-y-auto">
            <SpaceBadge
              href="/space/personal"
              label="개인 공간"
              icon={User}
              active={isActive("/space/personal")}
              onPrefetch={() => prefetchSpace("personal")}
            />
            {myClasses.map((m) => {
              const href = `/space/${m.class_id}`;
              const label = m.classes?.name ?? "학급";
              return (
                <SpaceBadge
                  key={m.class_id}
                  href={href}
                  label={label}
                  initial={initials(m.classes?.name, "반")}
                  active={isActive(href)}
                  onPrefetch={() => prefetchSpace(m.class_id)}
                />
              );
            })}
          </div>
        </>
      )}

      {/* 교사 콘솔 */}
      {role === "teacher" ? (
        <NavIcon
          href="/teacher"
          label="교사 콘솔"
          icon={School}
          active={isActive("/teacher")}
        />
      ) : null}

      {/* 관리자 콘솔 */}
      {role === "admin" ? (
        <NavIcon
          href="/admin"
          label="관리자 콘솔"
          icon={Shield}
          active={isActive("/admin")}
        />
      ) : null}

      {/* 프로필·설정 (하단 고정) */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <NavIcon
          href="/profile"
          label={
            profile?.display_name
              ? `프로필·설정 (${profile.display_name})`
              : "프로필·설정"
          }
          icon={Settings}
          active={isActive("/profile")}
        />
        {profile?.display_name ? (
          <span
            title={profile.display_name}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-accent-fg"
          >
            {initials(profile.display_name, "나")}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
