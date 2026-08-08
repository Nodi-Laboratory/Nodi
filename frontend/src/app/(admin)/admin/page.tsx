"use client";

import { useState } from "react";
import {
  Archive,
  Clapperboard,
  Images,
  Type,
  Link2,
  FlaskConical,
  GitBranch,
  LayoutDashboard,
  MessagesSquare,
  PenLine,
  ScrollText,
  Shield,
  Sliders,
  Users,
  Wrench,
  FileText,
} from "lucide-react";
import { useProfile } from "@/lib/hooks";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { UsersTab } from "@/components/admin/UsersTab";
import { SettingsTab } from "@/components/admin/SettingsTab";
import { LogsTab } from "@/components/admin/LogsTab";
import { OverviewTab } from "@/components/admin/OverviewTab";
import { FlowTab } from "@/components/admin/FlowTab";
import { SkillsTab } from "@/components/admin/SkillsTab";
import { ConversationsTab } from "@/components/admin/ConversationsTab";
import { DocumentsTab } from "@/components/admin/DocumentsTab";
import { RagLabTab } from "@/components/admin/RagLabTab";
import { DataTab } from "@/components/admin/DataTab";
import { HandFontsTab } from "@/components/admin/HandFontsTab";
import { ClipThumbnailsTab } from "@/components/admin/ClipThumbnailsTab";
import { LecturePackagesTab } from "@/components/admin/LecturePackagesTab";
import { CrossLinksTab } from "@/components/admin/CrossLinksTab";
import { InkLabTab } from "@/components/admin/InkLabTab";

/**
 * 관리자 운영 콘솔 (Stage 4c → D113).
 *
 * 서비스 테스트를 위한 화면이라 **관리자만** 들어온다. 프론트 RoleGuard와
 * 백엔드 require_admin·RLS 정책·RPC 내부 is_admin이 3중으로 막는다 — 이 가드를
 * 통과해도 DB가 허락하지 않으면 아무것도 못 읽는다(D104).
 *
 * 탭 순서는 "무슨 일이 일어나는가 → 왜 그렇게 되는가 → 무엇을 바꾸는가"다.
 */
type Tab =
  | "overview"
  | "flow"
  | "conversations"
  | "logs"
  | "skills"
  | "documents"
  | "rag"
  | "settings"
  | "data"
  | "lectures"
  | "clipthumbs"
  | "handfonts"
  | "crosslinks"
  | "inklab"
  | "users";

const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
  { id: "overview", label: "개요", icon: LayoutDashboard },
  { id: "flow", label: "AI 흐름", icon: GitBranch },
  { id: "conversations", label: "대화", icon: MessagesSquare },
  { id: "logs", label: "턴 로그", icon: ScrollText },
  { id: "skills", label: "스킬", icon: Wrench },
  { id: "documents", label: "문서", icon: FileText },
  { id: "rag", label: "RAG 테스트", icon: FlaskConical },
  { id: "settings", label: "설정", icon: Sliders },
  { id: "data", label: "데이터", icon: Archive },
  { id: "lectures", label: "강의 패키지", icon: Clapperboard },
  // D190: 클립 카드에 붙일 그림 창고 — EBS 썸네일을 못 가져와서 우리가 든다.
  { id: "clipthumbs", label: "클립 썸네일", icon: Images },
  // D210 8-1: 캔버스 손글씨 폰트 — 적용 범위는 캔버스뿐이다(이 화면은 안 바뀐다).
  { id: "handfonts", label: "손글씨 폰트", icon: Type },
  // D172: 교차 연결이 왜 떴는지/왜 안 떴는지를 보는 자리.
  { id: "crosslinks", label: "개념 연결", icon: Link2 },
  // D178: 펜 표시가 어느 카드를 가리키는지 — 결과가 화면에 안 보이는
  // 기능이라 경로를 보는 자리를 따로 둔다.
  { id: "inklab", label: "펜 표시", icon: PenLine },
  { id: "users", label: "권한", icon: Users },
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
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="flex min-h-screen flex-col bg-[#1b1813] text-[#e7e3d8]">
      <header className="flex items-center gap-2 border-b border-white/10 bg-[#221e17] px-6 py-3">
        <Shield size={18} className="text-[#e0a32e]" />
        <h1 className="text-base font-bold">운영 콘솔</h1>
        <span className="text-[11px] text-[#9a948a]">
          모든 사용자의 문서·대화에 접근합니다 — 관리자 전용
        </span>
        <div className="ml-auto">
          <AccountMenu dark />
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-white/10 bg-[#1f1b15] px-4">
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
        {tab === "overview" && <OverviewTab />}
        {tab === "flow" && <FlowTab />}
        {tab === "conversations" && <ConversationsTab />}
        {tab === "logs" && <LogsTab />}
        {tab === "skills" && <SkillsTab />}
        {tab === "documents" && <DocumentsTab />}
        {tab === "rag" && <RagLabTab />}
        {tab === "settings" && <SettingsTab />}
        {tab === "data" && <DataTab />}
        {tab === "lectures" && <LecturePackagesTab />}
        {tab === "clipthumbs" && <ClipThumbnailsTab />}
        {tab === "handfonts" && <HandFontsTab />}
        {tab === "crosslinks" && <CrossLinksTab />}
        {tab === "inklab" && <InkLabTab />}
        {tab === "users" && <UsersTab currentUserId={profile?.id ?? ""} />}
      </main>
    </div>
  );
}
