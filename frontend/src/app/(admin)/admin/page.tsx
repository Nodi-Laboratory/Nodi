"use client";

import { useState } from "react";
import { Shield, Users, Sliders, ScrollText } from "lucide-react";
import { useProfile } from "@/lib/hooks";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { UsersTab } from "@/components/admin/UsersTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { LogsTab } from "@/components/admin/LogsTab";

/**
 * 관리자 운영 콘솔 (Stage 4c). 다크 운영 톤(일반 cream/노랑과 구분).
 * 관리자 role만 접근(백엔드 403과 이중 가드). 탭: 권한·설정·로그.
 */
type Tab = "users" | "settings" | "logs";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "users", label: "권한", icon: Users },
  { id: "settings", label: "런타임 설정", icon: Sliders },
  { id: "logs", label: "로그", icon: ScrollText },
];

export default function AdminPage() {
  return (
    <RoleGuard allowed={["admin"]}>
      <AdminConsole />
    </RoleGuard>
  );
}

function AdminConsole() {
  const { data: profile } = useProfile();
  const [tab, setTab] = useState<Tab>("users");

  return (
    <div className="flex min-h-screen flex-col bg-[#1b1813] text-[#e7e3d8]">
      <header className="flex items-center gap-2 border-b border-white/10 bg-[#221e17] px-6 py-3">
        <Shield size={18} className="text-[#e0a32e]" />
        <h1 className="text-base font-bold">운영 콘솔</h1>
        <div className="ml-auto">
          <AccountMenu dark />
        </div>
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
        {tab === "users" && <UsersTab currentUserId={profile?.id ?? ""} />}
        {tab === "settings" && <SettingsTab />}
        {tab === "logs" && <LogsTab />}
      </main>
    </div>
  );
}
