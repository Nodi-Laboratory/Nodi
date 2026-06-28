"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Radio } from "lucide-react";
import { getAdminLogs, listAdminUsers } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { AdminLog, AdminLogsResponse, AdminUser } from "@/lib/types";

const LIMIT = 20;

/**
 * 로그 탭(D25): 채팅 턴 단위 ai_logs.
 * 과거 조회(사용자/날짜 필터·페이지네이션) + Supabase Realtime 구독으로 신규 턴 라이브 추가.
 */
export function LogsTab() {
  const [userId, setUserId] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [until, setUntil] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [liveLogs, setLiveLogs] = useState<AdminLog[]>([]);
  const [live, setLive] = useState(false);

  const { data: users } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });

  const { data, isLoading, isError } = useQuery<AdminLogsResponse>({
    queryKey: ["admin", "logs", userId || null, since || null, until || null, offset],
    queryFn: () =>
      getAdminLogs({
        userId: userId || null,
        since: since || null,
        until: until || null,
        limit: LIMIT,
        offset,
      }),
  });

  // ── Realtime 구독: ai_logs INSERT → 목록 맨 위에 라이브 추가 ──
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("admin-ai_logs")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ai_logs" },
        (payload) => {
          setLiveLogs((prev) => [payload.new as AdminLog, ...prev].slice(0, 100));
        },
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const logs = data?.logs ?? [];
  // 라이브 추가분은 첫 페이지에서만, 현재 필터에 맞는 것만, 중복 제거
  const liveExtra =
    offset === 0
      ? liveLogs.filter(
          (l) =>
            (!userId || l.owner_id === userId) &&
            !logs.some((x) => x.id === l.id),
        )
      : [];
  const display = [...liveExtra, ...logs];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const resetPage = () => setOffset(0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">채팅 턴 로그</h2>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            live
              ? "bg-[#e0796a]/20 text-[#e0796a]"
              : "bg-white/5 text-[#9a948a]"
          }`}
          title={live ? "실시간 구독 중" : "구독 대기"}
        >
          <Radio size={11} />
          {live ? "LIVE" : "연결 중…"}
        </span>

        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            resetPage();
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

        <label className="flex items-center gap-1 text-xs text-[#9a948a]">
          시작
          <input
            type="date"
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
              resetPage();
            }}
            className="rounded border border-white/15 bg-[#1b1813] px-1.5 py-1 text-[#e7e3d8]"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-[#9a948a]">
          끝
          <input
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              resetPage();
            }}
            className="rounded border border-white/15 bg-[#1b1813] px-1.5 py-1 text-[#e7e3d8]"
          />
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-[#9a948a]">로그 불러오는 중…</p>
      ) : isError ? (
        <p className="text-sm text-[#e0796a]">로그를 불러오지 못했습니다.</p>
      ) : display.length === 0 ? (
        <p className="text-sm text-[#9a948a]">로그가 없습니다.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {display.map((l) => (
            <LogRow
              key={l.id}
              log={l}
              isLive={liveExtra.some((x) => x.id === l.id)}
              open={expanded.has(l.id)}
              onToggle={() => toggle(l.id)}
              userEmail={users?.find((u) => u.id === l.owner_id)?.email ?? l.owner_id}
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
          {logs.length === 0 ? 0 : offset + 1}–{offset + logs.length}
        </span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + LIMIT)}
          disabled={logs.length < LIMIT}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          다음
        </button>
      </div>
    </div>
  );
}

function jsonPreview(v: unknown, max = 400): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function LogRow({
  log,
  isLive,
  open,
  onToggle,
  userEmail,
}: {
  log: AdminLog;
  isLive: boolean;
  open: boolean;
  onToggle: () => void;
  userEmail: string;
}) {
  const contexts = log.contexts ?? {};
  const ctxEntries = Object.entries(contexts);
  const skillCalls = log.skill_calls ?? [];
  const errors = log.errors ?? [];

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
        {isLive && (
          <span className="rounded bg-[#e0796a]/20 px-1.5 py-0.5 text-[10px] font-medium text-[#e0796a]">
            NEW
          </span>
        )}
        <span className="rounded bg-[#e0a32e]/20 px-1.5 py-0.5 text-xs font-medium text-[#fcf58b]">
          {log.kind || "chat"}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[#cfc9bd]">
          {log.question || "(질문 없음)"}
        </span>
        <span className="shrink-0 text-xs text-[#9a948a]">{userEmail}</span>
        <span className="shrink-0 text-xs text-[#9a948a]">
          {log.token_estimate != null ? `${log.token_estimate} tok` : ""}
        </span>
        <span className="shrink-0 text-xs text-[#9a948a]">
          {new Date(log.created_at).toLocaleString("ko-KR")}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-white/10 p-3 text-xs">
          {ctxEntries.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ctxEntries.map(([k, v]) => (
                <span
                  key={k}
                  className={`rounded-full px-2 py-0.5 ${
                    v
                      ? "bg-[#9bbf6a]/20 text-[#9bbf6a]"
                      : "bg-white/5 text-[#9a948a]"
                  }`}
                >
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}

          <Section label="질문">{log.question}</Section>
          <Section label="답변">{log.answer}</Section>
          <Section label="system_prompt" mono>
            {log.system_prompt}
          </Section>

          {skillCalls.length > 0 && (
            <Section label={`skill_calls (${skillCalls.length})`} mono>
              {jsonPreview(skillCalls, 800)}
            </Section>
          )}

          {errors.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-[#e0796a]">
                errors ({errors.length})
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#1b1813] p-2 font-mono text-[#e0796a]">
                {jsonPreview(errors, 800)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  if (!children) return null;
  return (
    <div>
      <div className="mb-1 font-medium text-[#9a948a]">{label}</div>
      <pre
        className={`max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[#1b1813] p-2 text-[#cfc9bd] ${
          mono ? "font-mono" : ""
        }`}
      >
        {children}
      </pre>
    </div>
  );
}
