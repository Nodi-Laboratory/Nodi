"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Grid2x2,
  HelpCircle,
  Home,
  Settings,
  Shield,
  School,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useProfile } from "@/lib/hooks";
import { HelpDialog } from "@/components/help/HelpDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";

/**
 * 좌측 64px 아이콘 사이드바.
 *
 * ## 학급 동그라미를 걷어냈다 (사용자 지시 2026-08-09)
 *
 * 예전에는 가입한 학급마다 배지가 하나씩 쌓였다. 학급이 늘수록 **무슨 반인지
 * 알아볼 수 없다** — 이름 첫 글자 하나로는 "3학년 1반"과 "3학년 2반"이 같아
 * 보이고, 많아지면 목록이 스크롤로 밀린다.
 *
 * 이제 사이드바에 있는 것은 다섯뿐이다:
 *
 *   로고    아무 기능 없음 (여기가 어디인지 말해 주는 표식)
 *   홈      홈으로
 *   세션    세션 선택 페이지로 — 학급을 사진으로 골라 들어간다
 *   설정    **팝업**으로 연다 (사용자 지시 2026-08-10)
 *   도움말  **팝업**으로 연다
 *
 * **기록은 여기 있다가 캔버스 상단 바로 옮겼다**(사용자 지시 2026-08-09).
 * 대화방을 오가는 일은 캔버스 **안**에서 하는 일이고, 사이드바는 화면을
 * 통째로 바꾸는 것들만 두는 편이 갈래가 분명하다.
 *
 * 하단의 프로필 머리글자도 뺐다 — **아무것도 안 하는 표시**였고, 그 자리를
 * 도움말이 쓴다.
 *
 * ## 설정·도움말은 **화면을 안 바꾼다** (사용자 지시 2026-08-10)
 *
 * 둘 다 페이지였는데 팝업으로 옮기고 `/profile`·`/help`는 지웠다. 거기서 하는
 * 일은 전부 **한 번 하고 돌아가는 일**이라(이름 바꾸기·학급 넣기·사용법 보기)
 * 하던 대화를 떠날 값이 없다 — 캔버스에서 열면 뒤에 그대로 남는다.
 *
 * 교사·관리자 콘솔 버튼은 그대로 둔다. 그 둘은 학생 화면의 일부가 아니라
 * 다른 앱에 가까워서, 세션 선택 페이지에 섞으면 오히려 찾기 어려워진다.
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

/** 페이지를 안 옮기고 **그 자리에서 여는** 버튼 (설정·도움말). */
function NavButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep ${
        active
          ? "bg-accent-soft text-sidebar-fg-active"
          : "text-sidebar-fg hover:bg-accent-soft/60 hover:text-sidebar-fg-active"
      }`}
    >
      <Icon size={20} strokeWidth={2} />
    </button>
  );
}

export default function IconSidebar() {
  const pathname = usePathname();
  const { data: profile } = useProfile();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const role = profile?.role ?? null;
  const isStudent = !role || role === "student";

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

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
      {/**
       * 브랜드 마크 — **누를 수 없다** (사용자 지시 2026-08-09).
       *
       * 예전에는 홈으로 가는 링크였는데 바로 아래에 홈 버튼이 따로 있다.
       * 같은 곳으로 가는 길이 둘이면 하나는 없는 것과 같고, 어느 쪽이 무엇을
       * 하는지 배우는 데만 시간이 든다.
       */}
      <div
        aria-hidden="true"
        className="mb-1 flex h-9 w-9 select-none items-center justify-center rounded-full bg-accent font-bold text-accent-fg"
      >
        n
      </div>

      {isStudent && (
        <>
          <NavIcon href="/home" label="홈" icon={Home} active={isActive("/home")} />
          <NavIcon
            href="/sessions"
            label="세션"
            icon={Grid2x2}
            active={isActive("/sessions")}
          />
        </>
      )}

      {role === "teacher" ? (
        <NavIcon
          href="/teacher"
          label="교사 콘솔"
          icon={School}
          active={isActive("/teacher")}
        />
      ) : null}

      {role === "admin" ? (
        <NavIcon
          href="/admin"
          label="관리자 콘솔"
          icon={Shield}
          active={isActive("/admin")}
        />
      ) : null}

      {/* 설정·도움말 (하단 고정) — 팝업이라 주소가 안 바뀐다. */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <NavButton
          label={profile?.display_name ? `설정 (${profile.display_name})` : "설정"}
          icon={Settings}
          active={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        />
        <NavButton
          label="도움말"
          icon={HelpCircle}
          active={helpOpen}
          onClick={() => setHelpOpen(true)}
        />
      </div>

      {/**
       * ⚠️ 팝업은 이 `nav` 안에 그려지지만 **몸통으로 포털된다**(`Dialog`).
       * 여기에는 `zoom`이 걸려 있어서, 그대로 그리면 64px 기둥 안에 배율까지
       * 먹은 채로 뜬다.
       */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </nav>
  );
}
