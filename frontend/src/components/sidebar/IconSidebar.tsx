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
 * 좌측 사이드바 (UI 개편 2026-08-11).
 *
 * ## 아이콘만 있던 기둥에서 아이콘 + 글자로
 *
 * 64px 아이콘 기둥이었다. 요구사항이 **작은 `nodi` 워드마크 + 아이콘/텍스트
 * 조합**을 요구했고, 그 편이 실제로 낫다 — 아이콘만으로는 "세션"이 무엇인지
 * 눌러 봐야 알고, 툴팁은 손가락에서는 아예 안 뜬다.
 *
 * 활성 표시도 바뀌었다. 왼쪽에 붙던 라임 막대를 빼고 **아주 연한 라임 사각형
 * 배경 + 라임 아이콘**만 남긴다(테두리 없음) — 개편의 한 줄이 "라임 테두리로
 * 둘러싼 상자들을 흰 바탕 위 부드러운 레이어로"이고, 막대는 그 테두리 계열의
 * 마지막 잔재였다.
 *
 * ## 메뉴 구성 — 둘을 그대로 둔다 (판단 근거)
 *
 * 참조 시안은 `홈 / 새 대화 / 내 학습` 셋이다. 그런데 **`새 대화`는 목적지가
 * 아니라 행동**이고, 이미 두 곳에서 할 수 있다 — 홈 입력창에 쓰고 보내면 새
 * 방이 열리고, 캔버스 상단 바의 지난 대화 서랍에 [새 대화]가 있다. 세 번째
 * 길을 내면 "어느 쪽이 무엇을 하는지" 배우는 데만 시간이 든다. 이 파일은 같은
 * 이유로 **로고에서 홈 링크를 이미 뺐다**(2026-08-09) — 바로 아래에 홈이
 * 있는데 같은 곳으로 가는 길을 둘 둘 이유가 없다는 판단이었다. 그 판단을
 * 여기서 뒤집을 근거가 없다.
 *
 * `내 학습`은 `세션`의 다른 이름인데, 그 페이지 자신이 "OO님의 **세션** 목록"
 * 이라고 부른다(참조 시안도 그렇게 적혀 있다). 사이드바만 다른 낱말을 쓰면
 * 같은 것을 두 이름으로 부르게 된다.
 *
 * 그래서 **화면을 통째로 바꾸는 것만 둔다**는 원래 규칙을 지킨다: 홈 · 세션.
 * 설정·도움말은 팝업이라 주소를 안 바꾸지만 하단에 따로 모여 있어 갈래가
 * 구분된다(사용자 지시 2026-08-10).
 *
 * 교사·관리자 콘솔 버튼은 그대로다 — 학생 화면의 일부가 아니라 다른 앱에
 * 가까워서, 세션 선택 페이지에 섞으면 오히려 찾기 어려워진다.
 */

/** 활성/비활성 한 벌 — 링크와 버튼이 같은 모습이어야 한다. */
function itemClass(active: boolean): string {
  return [
    "flex w-full flex-col items-center gap-1.5 rounded-2xl px-2 py-2.5",
    "text-[12px] font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep",
    active
      ? "bg-accent-soft text-accent-deep"
      : "text-fg-muted hover:bg-accent-soft/50 hover:text-fg",
  ].join(" ");
}

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
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={itemClass(active)}
    >
      <Icon size={21} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      <span>{label}</span>
    </Link>
  );
}

/** 페이지를 안 옮기고 **그 자리에서 여는** 버튼 (설정·도움말). */
function NavButton({
  label,
  srLabel,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  srLabel?: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={srLabel ?? label}
      aria-pressed={active}
      className={itemClass(active)}
    >
      <Icon size={21} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      <span>{label}</span>
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
      data-app-sidebar
      /**
       * 크롬 배율. `zoom`은 이 안에 좌표 계산이 없을 때만 안전하다 — 사이드바는
       * 버튼뿐이라 괜찮다(캔버스에는 절대 못 건다, `lib/ui/scale.ts` 참조).
       *
       * 폭 112px × 0.95 = 106px으로 목표(105~115px) 안에 든다.
       */
      style={{ zoom: "var(--ui-scale, 1)" }}
      className="flex h-full w-28 shrink-0 flex-col items-center gap-1 border-r border-line/60 bg-bg-sidebar px-3 py-4"
    >
      {/**
       * 브랜드 마크 — **누를 수 없다** (사용자 지시 2026-08-09).
       *
       * 큰 연두 원형 `n`이었다. 요구사항대로 작은 `nodi` 워드마크로 바꾼다 —
       * 원형 배지는 이 화면에서 가장 진한 연두 면이라, "라임 면적을 줄인다"의
       * 첫 대상이었다. 여기가 어디인지 말해 주는 일은 글자로도 된다.
       */}
      {/* eslint-disable-next-line @next/next/no-img-element -- public의 정적 SVG라 next/image가 줄 이득이 없다 */}
      <img
        src="/brand/nodi-wordmark.svg"
        alt=""
        aria-hidden="true"
        width={62}
        height={24}
        className="mb-5 select-none self-start pl-1"
        draggable={false}
      />

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
          label="관리자"
          icon={Shield}
          active={isActive("/admin")}
        />
      ) : null}

      {/* 설정·도움말 (하단 고정) — 팝업이라 주소가 안 바뀐다. */}
      <div className="mt-auto flex w-full flex-col items-center gap-1">
        <NavButton
          label="설정"
          srLabel={profile?.display_name ? `설정 (${profile.display_name})` : "설정"}
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
       * 여기에는 `zoom`이 걸려 있어서, 그대로 그리면 기둥 안에 배율까지 먹은
       * 채로 뜬다.
       */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </nav>
  );
}
