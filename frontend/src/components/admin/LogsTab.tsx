"use client";

import { useEffect, useState } from "react";
import { AnswerBox } from "./AnswerBox";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Radio, Wrench, X } from "lucide-react";
import { getAdminLogDetail, getAdminLogs, listAdminUsers } from "@/lib/api";
import type {
  AdminLog,
  AdminLogDetail,
  AdminLogsResponse,
  AdminUser,
} from "@/lib/types";
import { Badge, Empty, Failed, Loading, ms, n, when } from "./ui";
import { TurnTrace } from "./TurnTrace";

const LIMIT = 20;
// D104-6: Realtime 대체 폴링 주기.
const REFRESH_MS = 30_000;

/**
 * 로그 탭 (D25 → D34 → D113): 턴 단위 모니터 + 상세 드로어.
 *
 * D113에서 상세 본문이 `TurnTrace`로 빠졌다 — 대화 탭이 **같은 것**을 보여 줘야
 * 해서다. 여기 남은 것은 목록·필터·페이지네이션과 드로어 껍데기다.
 *
 * 행에는 이제 실측 토큰과 스킬 개수가 보인다. 예전에는 어림값(글자수÷4)만
 * 있었고, 그 값은 한국어에서 실측의 1/4 수준이라 크기 비교에 쓸 수 없었다.
 */
export function LogsTab() {
  const [userId, setUserId] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: users } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });

  // 첫 페이지를 보고 있을 때만 주기 갱신한다 — 과거를 뒤지는 중에 목록이
  // 흔들리면 방해가 된다.
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
    refetchInterval: offset === 0 ? REFRESH_MS : false,
  });

  const logs = data?.logs ?? [];
  const resetPage = () => setOffset(0);
  const emailFor = (ownerId: string) =>
    users?.find((u) => u.id === ownerId)?.email ?? ownerId;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">채팅 턴 로그</h2>
        <span
          className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-[#9a948a]"
          title={`${REFRESH_MS / 1000}초마다 자동 새로고침 (첫 페이지)`}
        >
          <Radio size={11} />
          자동 새로고침
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
        <Loading />
      ) : isError ? (
        <Failed />
      ) : logs.length === 0 ? (
        <Empty>로그가 없습니다.</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {logs.map((l) => (
            <LogRow
              key={l.id}
              log={l}
              selected={selectedId === l.id}
              onSelect={() => setSelectedId(l.id)}
              userEmail={emailFor(l.owner_id)}
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

      {selectedId && (
        <TurnDrawer
          logId={selectedId}
          emailFor={emailFor}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function LogRow({
  log,
  selected,
  onSelect,
  userEmail,
}: {
  log: AdminLog;
  selected: boolean;
  onSelect: () => void;
  userEmail: string;
}) {
  const hasError = (log.errors?.length ?? 0) > 0;
  const skills = log.skill_calls?.length ?? 0;
  const real = log.tokens?.total ?? null;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-[#e0a32e]/60 bg-[#2c2820]"
          : "border-white/10 bg-[#25211a] hover:border-white/20"
      }`}
    >
      {log.route ? (
        <Badge tone={log.route === "react" ? "gold" : "info"}>{log.route}</Badge>
      ) : (
        <Badge>{log.kind || "chat"}</Badge>
      )}
      {hasError && <AlertTriangle size={13} className="shrink-0 text-[#e0796a]" />}
      <span className="min-w-0 flex-1 truncate text-sm text-[#cfc9bd]">
        {log.question || "(질문 없음)"}
      </span>
      {skills > 0 && (
        <Badge tone="ok">
          <Wrench size={10} />
          {skills}
        </Badge>
      )}
      <span className="shrink-0 text-xs text-[#9a948a]">{userEmail}</span>
      <span
        className="shrink-0 text-xs"
        title={real != null ? "공급자 실측" : "글자수÷4 어림(실측 없음)"}
        style={{ color: real != null ? "#fcf58b" : "#9a948a" }}
      >
        {real != null ? `${n(real)} tok` : `~${n(log.token_estimate)}`}
      </span>
      {log.duration_ms != null && (
        <span className="shrink-0 text-xs text-[#9a948a]">{ms(log.duration_ms)}</span>
      )}
      <span className="shrink-0 text-xs text-[#9a948a]">{when(log.created_at)}</span>
      <ChevronRight size={15} className="shrink-0 text-[#9a948a]" />
    </button>
  );
}

function TurnDrawer({
  logId,
  emailFor,
  onClose,
}: {
  logId: string;
  emailFor: (ownerId: string) => string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useQuery<AdminLogDetail>({
    queryKey: ["admin", "log-detail", logId],
    queryFn: () => getAdminLogDetail(logId),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const log = data?.log;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="턴 상세"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative ml-auto flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-white/10 bg-[#1b1813] shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#221e17] px-4 py-3">
          {log?.route && <Badge tone="gold">{log.route}</Badge>}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e7e3d8]">
            턴 상세
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isLoading ? (
            <Loading />
          ) : isError || !log ? (
            <Failed what="상세를 불러오지" />
          ) : (
            <div className="flex flex-col gap-5">
              <section className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#9a948a]">
                  <span>{when(log.created_at)}</span>
                  <span>· {emailFor(log.owner_id)}</span>
                  {log.session_id && (
                    <span className="font-mono">· session {log.session_id.slice(0, 8)}</span>
                  )}
                  {log.duration_ms != null && <span>· {ms(log.duration_ms)}</span>}
                  <Badge tone={(log.errors?.length ?? 0) > 0 ? "bad" : "ok"}>
                    {(log.errors?.length ?? 0) > 0 ? "오류 있음" : "정상"}
                  </Badge>
                </div>
                <Field label="질문">{log.question}</Field>
                {/**
                  * 답변은 **읽는 모습이 기본**이다 (2026-08-10).
                  *
                  * 원문에는 `CHAT:`·`@concept:` 같은 전선 위 표시가 섞여 있어서
                  * 그대로 두면 "응답에 다른 내용이 들어간" 것으로 보인다.
                  * 날것이 필요하면 상자 안에서 바꾼다.
                  */}
                <div>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#9a948a]">
                    답변
                  </div>
                  <AnswerBox raw={log.answer} />
                </div>
              </section>

              <TurnTrace log={log} />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#9a948a]">
        {label}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[#221e17] p-2 text-xs text-[#cfc9bd]">
        {children}
      </pre>
    </div>
  );
}
