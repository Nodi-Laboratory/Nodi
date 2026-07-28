"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { getAdminOverview } from "@/lib/api";
import type { AdminOverview } from "@/lib/types";
import {
  Badge,
  Empty,
  Failed,
  Loading,
  Panel,
  Stat,
  bytes,
  countLine,
  ms,
  n,
  statusTone,
} from "./ui";

/**
 * 개요 탭 (D113) — 서비스 전체 카운터 한 판.
 *
 * 토큰은 **실측과 어림을 나란히** 보여 준다. 어림(token_estimate)은 글자수/4
 * 휴리스틱이라 한국어에서 크게 빗나가고(실측 2026-07-28: 어림이 실측의 1/4.5),
 * 둘을 합쳐 하나로 보여 주면 관리자가 추정을 실측으로 오해한다.
 */
export function OverviewTab() {
  const { data, isLoading, isError } = useQuery<AdminOverview>({
    queryKey: ["admin", "overview"],
    queryFn: getAdminOverview,
    refetchInterval: 30_000,
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <Failed />;

  const t = data.tokens;
  const cacheRate =
    t.prompt > 0 ? Math.round((t.cached / t.prompt) * 100) : null;
  const unmeasured = data.turns.total - t.measured_turns;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <Stat
          label="사용자"
          value={n(data.users.total)}
          sub={countLine(data.users.by_role)}
        />
        <Stat
          label="대화(세션)"
          value={n(data.sessions.total)}
          sub={countLine(data.sessions.by_space)}
        />
        <Stat label="개념 노드" value={n(data.nodes)} sub={`학급 ${n(data.classes)}개`} />
        <Stat
          label="채팅 턴"
          value={n(data.turns.total)}
          sub={`최근 7일 ${n(data.turns.last_7d)}`}
          tone={data.turns.with_errors > 0 ? "warn" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="토큰 사용량">
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="실측 합계" value={n(t.total)} sub={`측정된 턴 ${n(t.measured_turns)}개`} />
            <Stat
              label="캐시 히트"
              value={cacheRate == null ? "—" : `${cacheRate}%`}
              sub={`${n(t.cached)} / 입력 ${n(t.prompt)}`}
              tone={cacheRate != null && cacheRate >= 40 ? "ok" : "default"}
            />
            <Stat label="입력" value={n(t.prompt)} />
            <Stat label="출력" value={n(t.completion)} />
          </div>
          <div className="mt-3 rounded border border-white/10 bg-[#1b1813] px-2.5 py-2 text-[11px] leading-relaxed text-[#9a948a]">
            어림 합계(글자수÷4) <b className="text-[#cfc9bd]">{n(t.estimate_total)}</b> —
            실측과 나란히 둔다. 한국어에서 이 휴리스틱은 크게 빗나가므로 과금·한도
            판단에는 실측만 쓴다.
            {unmeasured > 0 && (
              <>
                {" "}
                <span className="text-[#e0a86a]">
                  {n(unmeasured)}개 턴은 실측값이 없다(D113 이전 로그이거나 스트림이
                  중간에 끊긴 턴).
                </span>
              </>
            )}
          </div>
        </Panel>

        <Panel title="응답 지연 · 경로">
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="지연 p50" value={ms(data.latency.p50)} />
            <Stat label="지연 p95" value={ms(data.latency.p95)} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[#9a948a]">경로별 턴</span>
            {Object.entries(data.turns.by_route).map(([k, v]) => (
              <Badge key={k} tone={k === "react" ? "gold" : k === "unknown" ? "default" : "info"}>
                {k === "unknown" ? "기록 이전" : k} {n(v)}
              </Badge>
            ))}
          </div>
          {data.turns.with_errors > 0 && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#e0796a]/40 bg-[#e0796a]/10 px-2.5 py-2 text-[11px] text-[#e6a99e]">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              오류가 기록된 턴 {n(data.turns.with_errors)}건 — 로그 탭에서 확인하세요.
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="문서">
          <Stat
            label="파일"
            value={n(data.files.total)}
            sub={`${bytes(data.files.bytes)} · ${countLine(data.files.by_kind)}`}
          />
          <StatusRow map={data.files.by_status} />
        </Panel>
        <Panel title="청크 · 도판">
          <Stat label="청크" value={n(data.chunks.total)} />
          <StatusRow map={data.chunks.by_status} />
          <div className="mt-2">
            <Stat label="교과서 도판" value={n(data.figures.total)} />
            <StatusRow map={data.figures.by_status} />
          </div>
        </Panel>
        <Panel title="인제스트 잡">
          {Object.keys(data.jobs.by_status).length === 0 ? (
            <Empty>잡 기록이 없습니다.</Empty>
          ) : (
            <StatusRow map={data.jobs.by_status} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatusRow({ map }: { map: Record<string, number> }) {
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <Badge key={k} tone={statusTone(k)}>
          {k} {n(v)}
        </Badge>
      ))}
    </div>
  );
}
