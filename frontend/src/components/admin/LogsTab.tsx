"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getAdminLogs, listAdminUsers } from "@/lib/api";
import type { AdminLogsResponse, AdminLogSession, AdminUser } from "@/lib/types";

const LIMIT = 20;

/** 로그 탭: ai_sessions 목록 + ai_steps 트레이스(턴/스텝). 사용자 필터 + 페이지네이션. */
export function LogsTab() {
  const [userId, setUserId] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: users } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });

  const { data, isLoading, isError } = useQuery<AdminLogsResponse>({
    queryKey: ["admin", "logs", userId || null, offset],
    queryFn: () =>
      getAdminLogs({ userId: userId || null, limit: LIMIT, offset }),
  });

  const sessions = data?.sessions ?? [];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">
          에이전트 트레이스 로그
        </h2>
        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setOffset(0);
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 사용자</option>
          {(users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.email || u.id}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <p className="text-sm text-[#9a948a]">로그 불러오는 중…</p>
      ) : isError ? (
        <p className="text-sm text-[#e0796a]">로그를 불러오지 못했습니다.</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-[#9a948a]">로그가 없습니다.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <LogSessionRow
              key={s.id}
              session={s}
              open={expanded.has(s.id)}
              onToggle={() => toggle(s.id)}
              userEmail={
                users?.find((u) => u.id === s.owner_id)?.email ?? s.owner_id
              }
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
          disabled={offset === 0}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          이전
        </button>
        <span className="text-xs text-[#9a948a]">
          {offset + 1}–{offset + sessions.length}
        </span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + LIMIT)}
          disabled={sessions.length < LIMIT}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          다음
        </button>
      </div>
    </div>
  );
}

function preview(v: unknown, max = 200): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function LogSessionRow({
  session,
  open,
  onToggle,
  userEmail,
}: {
  session: AdminLogSession;
  open: boolean;
  onToggle: () => void;
  userEmail: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#25211a]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={15} className="text-[#9a948a]" />
        ) : (
          <ChevronRight size={15} className="text-[#9a948a]" />
        )}
        <span className="rounded bg-[#e0a32e]/20 px-1.5 py-0.5 text-xs font-medium text-[#fcf58b]">
          {session.kind || "trace"}
        </span>
        <span className="text-sm text-[#cfc9bd]">{userEmail}</span>
        <span className="ml-auto text-xs text-[#9a948a]">
          {new Date(session.created_at).toLocaleString("ko-KR")} ·{" "}
          {session.ai_steps.length}스텝
        </span>
      </button>

      {open && (
        <div className="border-t border-white/10 p-3">
          {session.ai_steps.length === 0 ? (
            <p className="text-xs text-[#9a948a]">스텝 없음.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {session.ai_steps.map((step) => (
                <li
                  key={step.seq}
                  className="rounded border border-white/10 bg-[#1b1813] p-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[#9a948a]">#{step.seq}</span>
                    {step.skill && (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 font-medium text-[#e7e3d8]">
                        {step.skill}
                      </span>
                    )}
                    {step.tokens != null && (
                      <span className="ml-auto text-[#9a948a]">
                        {step.tokens} tok
                      </span>
                    )}
                  </div>
                  {step.thought && (
                    <p className="mt-1 text-[#cfc9bd]">
                      <span className="text-[#9a948a]">thought: </span>
                      {step.thought}
                    </p>
                  )}
                  {step.input != null && preview(step.input) && (
                    <p className="mt-1 break-all font-mono text-[#9a948a]">
                      input: {preview(step.input)}
                    </p>
                  )}
                  {step.observation != null && preview(step.observation) && (
                    <p className="mt-1 break-all font-mono text-[#9a948a]">
                      obs: {preview(step.observation)}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
