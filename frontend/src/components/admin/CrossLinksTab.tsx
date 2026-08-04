"use client";

/**
 * 교차 연결 판정 로그 (D172).
 *
 * `item_links`는 **성공한 링크만** 남는다. 여기서 보는 것은 판정 전체다 —
 * 어떤 세션들을 뒤졌고, 각 후보의 유사도가 얼마였고, 무엇이 왜 떨어졌는지.
 *
 * 이 화면의 목적은 하나다: **"왜 안 뜨지"에 답하는 것.** 거리가 멀어서인지,
 * 같은 태그라서인지, 모델이 관련 없다고 했는지가 구분돼야 게이트를 조정할 수
 * 있다. 그래서 떨어진 후보도 전부 보여 준다.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Link2, Search } from "lucide-react";
import {
  getCrossLinkRuns,
  getCrossLinkSummary,
  type CrossLinkCandidate,
  type CrossLinkRun,
} from "@/lib/api";

const OUTCOMES: { id: string; label: string; hint: string }[] = [
  { id: "", label: "전체", hint: "" },
  { id: "linked", label: "연결됨", hint: "링크가 만들어진 판정" },
  { id: "all_rejected", label: "후보 탈락", hint: "찾긴 했는데 전부 떨어졌다" },
  { id: "no_candidate", label: "후보 없음", hint: "검색 결과 자체가 없다" },
  { id: "skipped", label: "건너뜀", hint: "색인 실패·이미 링크 있음 등" },
];

/** 판정별 표시. 색으로 "통과/탈락/미상"을 구분한다. */
const VERDICT: Record<CrossLinkCandidate["verdict"], { ko: string; cls: string }> = {
  accepted: { ko: "채택", cls: "bg-emerald-500/15 text-emerald-600" },
  too_close: { ko: "너무 가까움", cls: "bg-amber-500/15 text-amber-600" },
  too_far: { ko: "너무 멂", cls: "bg-slate-500/15 text-slate-500" },
  no_explanation: { ko: "관련 없음", cls: "bg-rose-500/15 text-rose-600" },
  vanished: { ko: "사라짐", cls: "bg-slate-500/15 text-slate-500" },
};

export function CrossLinksTab() {
  const [outcome, setOutcome] = useState("");

  const summary = useQuery({
    queryKey: ["crosslink-summary"],
    queryFn: getCrossLinkSummary,
    staleTime: 10_000,
  });

  const runs = useQuery({
    queryKey: ["crosslink-runs", outcome],
    queryFn: () => getCrossLinkRuns({ outcome: outcome || null, limit: 50 }),
    staleTime: 10_000,
  });

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-fg">개념 연결 판정 로그</h2>
        <p className="mt-1 text-sm text-fg-muted">
          카드 하나마다 다른 세션을 뒤져 본 기록이다. 떨어진 후보와 그 이유까지
          남는다 — 게이트가 너무 빡빡한지 여기서 판단한다.
        </p>
      </header>

      {/* 결과별 건수 — 게이트가 과한지 한눈에 */}
      <div className="flex flex-wrap gap-2">
        {OUTCOMES.filter((o) => o.id).map((o) => (
          <div
            key={o.id}
            className="rounded-lg border border-accent-border/40 bg-bg-elevated px-3 py-2"
          >
            <div className="text-[11px] text-fg-muted">{o.label}</div>
            <div className="text-lg font-semibold text-fg">
              {summary.data?.[o.id] ?? "–"}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {OUTCOMES.map((o) => (
          <button
            key={o.id || "all"}
            type="button"
            onClick={() => setOutcome(o.id)}
            title={o.hint}
            className={[
              "rounded-full px-3 py-1 text-xs transition-colors",
              outcome === o.id
                ? "bg-accent text-accent-fg"
                : "border border-accent-border/40 text-fg-muted hover:bg-accent/10",
            ].join(" ")}
          >
            {o.label}
          </button>
        ))}
      </div>

      {runs.isPending ? (
        <p className="text-sm text-fg-muted">불러오는 중…</p>
      ) : (runs.data?.items.length ?? 0) === 0 ? (
        <p className="rounded-lg border border-accent-border/40 bg-bg-elevated p-4 text-sm text-fg-muted">
          기록이 없다. 학생이 AI 개념 카드를 만들면 그때마다 판정이 한 줄씩 쌓인다.
        </p>
      ) : (
        <ul className="space-y-2">
          {runs.data!.items.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({ run }: { run: CrossLinkRun }) {
  const [open, setOpen] = useState(false);
  const linked = run.outcome === "linked";
  const when = new Date(run.created_at).toLocaleString("ko-KR");

  return (
    <li className="overflow-hidden rounded-lg border border-accent-border/40 bg-bg-elevated">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/5"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span
          className={[
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
            linked
              ? "bg-emerald-500/15 text-emerald-600"
              : "bg-slate-500/15 text-slate-500",
          ].join(" ")}
        >
          {linked ? "연결됨" : run.outcome}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          {run.from_title || "(제목 없음)"}
          {run.from_tag ? (
            <span className="ml-1.5 text-xs text-fg-muted">[{run.from_tag}]</span>
          ) : null}
        </span>
        <span className="shrink-0 text-[11px] text-fg-muted">
          세션 {run.searched_sessions}개 · 후보 {run.candidates.length}개
          {run.duration_ms != null ? ` · ${run.duration_ms}ms` : ""}
        </span>
        <span className="shrink-0 text-[11px] text-fg-muted">{when}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-accent-border/30 px-3 py-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-muted">
            <span>학생: {run.owner_label || run.owner_id}</span>
            <span>공간: {run.from_space_kind ?? "–"}</span>
            <span>
              띠: {String(run.knobs.lo ?? "?")} ~ {String(run.knobs.hi ?? "?")}
              {run.knobs.always_on ? " (상시 켜기 — 띠 무시)" : ""}
            </span>
            <span>검색 폭: {String(run.knobs.top_k ?? "?")}</span>
          </div>

          {run.explanation ? (
            <div className="rounded-lg border border-accent-border/30 bg-accent/5 p-2.5">
              <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-accent-deep">
                <Link2 size={12} /> 학생에게 보여 준 설명
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-fg">
                {run.explanation}
              </p>
            </div>
          ) : null}

          <div>
            <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-fg-muted">
              <Search size={12} /> 조사한 후보 ({run.candidates.length})
            </div>
            {run.candidates.length === 0 ? (
              <p className="text-xs text-fg-muted">
                검색 결과가 없다 — 같은 태그·같은 세션을 빼고 나면 남는 카드가
                없었다는 뜻이다.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase text-fg-muted">
                  <tr>
                    <th className="py-1 pr-2">유사도(거리)</th>
                    <th className="py-1 pr-2">판정</th>
                    <th className="py-1 pr-2">과거 카드</th>
                    <th className="py-1 pr-2">세션 · 분류</th>
                    <th className="py-1">사유</th>
                  </tr>
                </thead>
                <tbody>
                  {run.candidates.map((c, i) => (
                    <tr key={`${c.item_id}-${i}`} className="border-t border-accent-border/20">
                      <td className="py-1.5 pr-2 font-mono">{c.distance.toFixed(3)}</td>
                      <td className="py-1.5 pr-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${VERDICT[c.verdict]?.cls ?? ""}`}
                        >
                          {VERDICT[c.verdict]?.ko ?? c.verdict}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-fg">{c.title ?? "–"}</td>
                      <td className="py-1.5 pr-2 text-fg-muted">
                        {c.session_title ?? c.session_id.slice(0, 8)}
                        {c.tag ? ` · ${c.tag}` : ""}
                        {c.space_kind ? ` · ${c.space_kind}` : ""}
                      </td>
                      <td className="py-1.5 text-fg-muted">{c.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
