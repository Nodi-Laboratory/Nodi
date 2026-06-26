"use client";

import { useState } from "react";
import Link from "next/link";
import { Shield, Users, Sliders, BarChart3, ScrollText } from "lucide-react";
import { useProfile } from "@/lib/hooks";
import { UsersTab } from "@/components/admin/UsersTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { UsageTab } from "@/components/admin/UsageTab";
import { LogsTab } from "@/components/admin/LogsTab";

/**
 * 관리자 운영 콘솔 (Stage 4c). 다크 운영 톤(일반 cream/노랑과 구분).
 * 관리자 role만 접근(백엔드 403과 이중 가드). 탭: 권한·설정·사용량·로그.
 */
type Tab = "users" | "settings" | "usage" | "logs";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "users", label: "권한", icon: Users },
  { id: "settings", label: "런타임 설정", icon: Sliders },
  { id: "usage", label: "사용량", icon: BarChart3 },
  { id: "logs", label: "로그", icon: ScrollText },
];

export default function AdminPage() {
  const { data: profile, isLoading } = useProfile();
  const [tab, setTab] = useState<Tab>("users");

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#1b1813] text-sm text-[#9a948a]">
        불러오는 중…
      </div>
    );
  }

  if (profile?.role !== "admin") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#1b1813] p-8 text-center">
        <Shield size={36} className="text-[#e0796a]" />
        <p className="text-sm text-[#e7e3d8]">관리자 권한이 필요합니다.</p>
        <Link
          href="/home"
          className="rounded-lg bg-[#e0a32e] px-4 py-2 text-sm font-medium text-[#2a2a24] hover:brightness-110"
        >
          홈으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#1b1813] text-[#e7e3d8]">
      <header className="flex items-center gap-2 border-b border-white/10 bg-[#221e17] px-6 py-3">
        <Shield size={18} className="text-[#e0a32e]" />
        <h1 className="text-base font-bold">운영 콘솔</h1>
        <span className="ml-3 text-xs text-[#9a948a]">{profile.email}</span>
        <Link
          href="/home"
          className="ml-auto text-xs text-[#9a948a] hover:text-[#e7e3d8]"
        >
          일반 화면으로 →
        </Link>
      </header>

      <nav className="flex gap-1 border-b border-white/10 bg-[#1f1b15] px-4">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                active
                  ? "border-[#e0a32e] text-[#fcf58b]"
                  : "border-transparent text-[#9a948a] hover:text-[#e7e3d8]"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </nav>

      <main className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "users" && <UsersTab currentUserId={profile.id} />}
        {tab === "settings" && <SettingsTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "logs" && <LogsTab />}
      </main>
    </div>
  );
}
