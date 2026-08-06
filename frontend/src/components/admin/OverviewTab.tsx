"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { getAdminOverview, getHealthConfig } from "@/lib/api";
import type { AdminOverview, HealthConfig } from "@/lib/types";
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

      <EnvironmentPanel />
    </div>
  );
}

/**
 * 환경 — 지금 이 서버가 무엇에 붙어 있는가.
 *
 * 설정(app_settings)이 "바꿀 수 있는 값"이라면 이건 "기동 시 정해진 값"이다.
 * 둘을 섞으면 관리자가 콘솔에서 바꿀 수 있다고 오해한다. `/health/config`를
 * 그대로 읽으며 **비밀값은 애초에 응답에 없다**(존재 여부와 모델명·URL만).
 */
function EnvironmentPanel() {
  const { data, isLoading, isError } = useQuery<HealthConfig>({
    queryKey: ["admin", "health-config"],
    queryFn: getHealthConfig,
    staleTime: 60_000,
  });

  if (isLoading) return <Panel title="환경"><Loading /></Panel>;
  if (isError || !data) return <Panel title="환경"><Failed /></Panel>;

  const rows: { label: string; value: string; tone?: "ok" | "warn" | "bad" }[] = [
    { label: "환경", value: data.environment },
    { label: "DB 호스트", value: data.database.host ?? "—", tone: data.database.configured ? "ok" : "bad" },
    { label: "워커 DSN", value: data.database.worker_dsn_set ? "설정됨" : "없음 — 업로드·임베딩 비활성", tone: data.database.worker_dsn_set ? "ok" : "bad" },
    { label: "대화 모델", value: data.chat.model, tone: data.chat.configured ? "ok" : "bad" },
    { label: "임베딩(질의/문서)", value: `${data.upstage.embedding_query_model} / ${data.upstage.embedding_passage_model}`, tone: data.upstage.configured ? "ok" : "bad" },
    { label: "Upstage 베이스", value: data.upstage.base_url },
    { label: "Qdrant", value: data.qdrant.url, tone: data.qdrant.configured ? "ok" : "bad" },
    { label: "파일 저장소", value: `${data.storage.bucket} @ ${data.storage.root}` },
    { label: "토큰 만료", value: `${data.auth.expire_minutes}분 (${data.auth.jwt_algorithm})` },
    {
      label: "도판 비전 판정",
      value: data.judge.configured
        ? `${data.judge.model} @ ${data.judge.base_url}`
        : // D134 이후 폴백이 없다 — 판정 모델이 없으면 캡션 생성 자체가
          // 불가해 **전 도판이 실패**한다(점검 2026-08-06에서 바로잡음).
          `미설정 (${data.judge.missing.join(", ")}) — 교과서 도판이 하나도 안 뜸`,
      tone: data.judge.configured ? "ok" : "warn",
    },
  ];

  return (
    <Panel
      title="환경 (기동 시 결정 — 콘솔에서 바꿀 수 없음)"
      right={
        <Badge tone={data.ready ? "ok" : "bad"}>
          {data.ready ? "채팅 가능" : `막힘: ${data.blocking.join(", ")}`}
        </Badge>
      }
    >
      {data.auth.secret_is_default && (
        <div className="mb-2 flex items-start gap-2 rounded border border-[#e0796a]/40 bg-[#e0796a]/10 px-2.5 py-2 text-[11px] text-[#e6a99e]">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          JWT 시크릿이 기본값입니다 — 누구나 토큰을 위조할 수 있습니다. 운영 전
          반드시 교체하세요.
        </div>
      )}
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="shrink-0 text-[#9a948a]">{r.label}</span>
            <span
              className="min-w-0 truncate text-right font-mono"
              title={r.value}
              style={{
                color:
                  r.tone === "bad" ? "#e0796a" : r.tone === "warn" ? "#e0a86a" : "#cfc9bd",
              }}
            >
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </Panel>
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
