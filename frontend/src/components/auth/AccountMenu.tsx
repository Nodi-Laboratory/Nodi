"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Settings, LogOut } from "lucide-react";
import { clearToken } from "@/lib/session";
import { useProfile } from "@/lib/hooks";

/**
 * 공용 계정 메뉴(D26): 아바타/이름 → [프로필·설정 / 로그아웃].
 * 교사·관리자 콘솔 헤더에 배치(사이드바가 없어 로그아웃 경로가 없던 문제 해결).
 * dark=관리자 콘솔(다크 톤), 기본=라이트.
 */
export function AccountMenu({ dark = false }: { dark?: boolean }) {
  const { data: profile } = useProfile();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const handleLogout = async () => {
    clearToken();
    queryClient.clear();
    router.push("/login");
    router.refresh();
  };

  const name = profile?.display_name || profile?.email || "계정";
  const initial = (profile?.display_name || profile?.email || "?")
    .slice(0, 1)
    .toUpperCase();

  const panel = dark
    ? "border-white/15 bg-[#25211a] text-[#e7e3d8]"
    : "border-accent-border/50 bg-bg-elevated text-fg";
  const itemHover = dark ? "hover:bg-white/5" : "hover:bg-accent-soft";
  const avatar = dark
    ? "bg-[#e0a32e] text-[#2a2a24]"
    : "bg-accent text-accent-fg";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={name}
        className="flex items-center gap-2 rounded-full p-0.5 pr-2 transition-opacity hover:opacity-90"
      >
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${avatar}`}
        >
          {initial}
        </span>
        <span
          className={`max-w-[10rem] truncate text-sm ${
            dark ? "text-[#cfc9bd]" : "text-fg"
          }`}
        >
          {name}
        </span>
      </button>

      {open && (
        <div
          className={`absolute right-0 top-10 z-50 w-44 overflow-hidden rounded-lg border py-1 text-sm shadow-lg ${panel}`}
        >
          <Link
            href="/profile"
            onClick={() => setOpen(false)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left ${itemHover}`}
          >
            <Settings size={14} /> 프로필·설정
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-danger ${itemHover}`}
          >
            <LogOut size={14} /> 로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

