"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Settings, type LucideIcon } from "lucide-react";

/**
 * 좌측 64px 아이콘 사이드바 (dark brown).
 * Stage 0: 라우팅/활성 표시 골격만. 공간 전환은 더미 버튼(실제 공간 데이터는 이후 단계).
 *
 * 항목: [홈 진입] · [공간 전환: 개인/학급A/학급B] · [프로필·설정]
 */

type SpaceItem = { id: string; label: string; short: string };

// Stage 0 더미 공간 목록 (실제로는 개인 + 가입 학급을 서버에서 로드)
const DUMMY_SPACES: SpaceItem[] = [
  { id: "personal", label: "개인 공간", short: "개인" },
  { id: "classA", label: "학급 A", short: "A" },
  { id: "classB", label: "학급 B", short: "B" },
];

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
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
        active
          ? "bg-white/10 text-sidebar-fg-active"
          : "text-sidebar-fg hover:bg-white/5 hover:text-sidebar-fg-active"
      }`}
    >
      {active ? (
        <span className="absolute -left-2 h-5 w-1 rounded-full bg-accent-deep" />
      ) : null}
      <Icon size={20} strokeWidth={2} />
    </Link>
  );
}

export function IconSidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav
      aria-label="주 메뉴"
      className="flex h-full w-16 shrink-0 flex-col items-center gap-3 bg-bg-sidebar py-3"
    >
      {/* 브랜드 마크 */}
      <Link
        href="/home"
        title="nodi 홈"
        aria-label="nodi 홈"
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent font-bold text-accent-fg"
      >
        n
      </Link>

      {/* 홈 진입 */}
      <NavIcon
        href="/home"
        label="홈"
        icon={Home}
        active={isActive("/home")}
      />

      <div className="my-1 h-px w-8 bg-white/10" />

      {/* 공간 전환 (개인/학급A/학급B) — Stage 0 더미 */}
      <div className="flex flex-col items-center gap-2">
        {DUMMY_SPACES.map((space) => {
          const href = `/space/${space.id}`;
          const active = isActive(href);
          return (
            <Link
              key={space.id}
              href={href}
              title={`공간 전환: ${space.label}`}
              aria-label={`공간 전환: ${space.label}`}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 w-10 items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
                active
                  ? "border-accent-deep bg-accent text-accent-fg"
                  : "border-white/15 text-sidebar-fg hover:border-accent-deep hover:text-sidebar-fg-active"
              }`}
            >
              {space.short}
            </Link>
          );
        })}
      </div>

      {/* 프로필·설정 (하단 고정) */}
      <div className="mt-auto">
        <NavIcon
          href="/profile"
          label="프로필·설정"
          icon={Settings}
          active={isActive("/profile")}
        />
      </div>
    </nav>
  );
}
