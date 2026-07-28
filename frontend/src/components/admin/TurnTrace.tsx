"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Coins, Wrench } from "lucide-react";
import { getAdminSkills } from "@/lib/api";
import type {
  AdminLog,
  AdminSkillsResponse,
  LogContextBlock,
  RagSource,
  SkillTrace,
} from "@/lib/types";
import { Badge, Code, Collapse, CopyButton, ms, n } from "./ui";
import { TurnFlow } from "./TurnFlow";

/**
 * 한 턴이 어떻게 만들어졌는지 (D113).
 *
 * 대화 탭과 로그 탭이 **같은 것**을 보여 줘야 해서 컴포넌트를 나눴다. 담는 것:
 *   ① 실측 토큰 — 판단/생성 단계별. 어림값과 섞지 않는다.
 *   ② 스킬 트레이스 — 어떤 스킬을, 어떤 인자로, 결과가 무엇이었는지.
 *      스킬 **설명**은 로그에 없다(매 턴 복제할 이유가 없다) — 카탈로그와
 *      이름으로 이어 붙인다.
 *   ③ 실제로 보낸 시스템 프롬프트 + 블록 하이라이트.
 */
export function TurnTrace({ log }: { log: AdminLog }) {
  // 스킬 설명을 잇기 위한 카탈로그. 실패해도 트레이스는 그대로 보인다.
  const { data: catalog } = useQuery<AdminSkillsResponse>({
    queryKey: ["admin", "skills"],
    queryFn: () => getAdminSkills(30),
    staleTime: 5 * 60_000,
  });
  const describe = (name: string) =>
    catalog?.skills.find((s) => s.name === name)?.description ?? "";

  const traces = log.skill_calls ?? [];
  const blocks: LogContextBlock[] = Array.isArray(log.contexts?.blocks)
    ? (log.contexts!.blocks as LogContextBlock[])
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/*
        맨 위에 흐름을 둔다. "무엇을 했나"를 먼저 보고 세부(토큰·프롬프트)로
        내려가는 순서다. 스킬을 안 쓴 턴에서도 전체 파이프라인이 보이므로
        "아무것도 안 나온다"와 "도구가 필요 없었다"가 구분된다.
      */}
      <TurnFlow log={log} />

      <TokenPanel log={log} />

      {traces.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
            <Wrench size={13} /> 스킬 실행 ({traces.length})
          </h4>
          <div className="flex flex-col gap-2">
            {traces.map((t, i) => (
              <TraceCard key={i} trace={t} description={describe(t.skill)} />
            ))}
          </div>
        </section>
      )}

      <SystemPrompt prompt={log.system_prompt ?? ""} blocks={blocks} />

      {blocks.length > 0 && <ContextBlocks blocks={blocks} />}

      {(log.errors?.length ?? 0) > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="flex items-center gap-1 text-xs font-semibold text-[#e0796a]">
            <AlertTriangle size={13} /> 오류 ({log.errors!.length})
          </h4>
          <Code max="max-h-40">{JSON.stringify(log.errors, null, 2)}</Code>
        </section>
      )}
    </div>
  );
}

function TokenPanel({ log }: { log: AdminLog }) {
  const t = log.tokens;
  const measured = !!t?.total;
  return (
    <section className="flex flex-col gap-2">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
        <Coins size={13} /> 토큰
      </h4>
      {measured ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="gold">합계 {n(t!.total)}</Badge>
            <Badge>입력 {n(t!.prompt)}</Badge>
            <Badge>출력 {n(t!.completion)}</Badge>
            {(t!.cached ?? 0) > 0 && <Badge tone="ok">캐시 {n(t!.cached)}</Badge>}
            {log.model && <Badge tone="info">{log.model}</Badge>}
          </div>
          {(t!.calls?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead>
                  <tr className="text-[#9a948a]">
                    <th className="py-1 pr-3 font-medium">단계</th>
                    <th className="py-1 pr-3 font-medium">입력</th>
                    <th className="py-1 pr-3 font-medium">출력</th>
                    <th className="py-1 pr-3 font-medium">캐시</th>
                    <th className="py-1 font-medium">합계</th>
                  </tr>
                </thead>
                <tbody>
                  {t!.calls!.map((c, i) => (
                    <tr key={i}>
                      <td className="py-0.5 pr-3 text-[#cfc9bd]">
                        {c.stage === "decide" ? "도구 판단" : c.stage === "answer" ? "답변 생성" : c.stage}
                        {c.step != null && c.stage === "decide" ? ` #${c.step + 1}` : ""}
                      </td>
                      <td className="py-0.5 pr-3 text-[#9a948a]">{n(c.prompt)}</td>
                      <td className="py-0.5 pr-3 text-[#9a948a]">{n(c.completion)}</td>
                      <td className="py-0.5 pr-3 text-[#9a948a]">{n(c.cached)}</td>
                      <td className="py-0.5 text-[#cfc9bd]">{n(c.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-[#9a948a]">
            어림(글자수÷4) {n(log.token_estimate)} — 참고용. 위 값이 공급자 실측이다.
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="warn">실측 없음</Badge>
          <span className="text-[11px] text-[#9a948a]">
            어림 {n(log.token_estimate)} (글자수÷4). D113 이전 턴이거나 스트림이
            usage를 남기지 못한 경우입니다.
          </span>
        </div>
      )}
    </section>
  );
}

function TraceCard({
  trace,
  description,
}: {
  trace: SkillTrace;
  description: string;
}) {
  const failed = trace.ok === false;
  const args = trace.args ?? {};
  const data = trace.data ?? {};
  const truncated = (data as Record<string, unknown>)._truncated === true;

  return (
    <div
      className="overflow-hidden rounded-lg border bg-[#221e17]"
      style={{
        borderColor: failed
          ? "rgba(224,121,106,0.45)"
          : trace.skipped
            ? "rgba(224,168,106,0.35)"
            : "rgba(155,191,106,0.35)",
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <code className="text-[12px] font-semibold text-[#fcf58b]">{trace.skill}</code>
        {trace.step != null && <Badge>라운드 {trace.step + 1}</Badge>}
        {trace.skipped ? (
          <Badge tone="warn">중복 생략</Badge>
        ) : failed ? (
          <Badge tone="bad">실패{trace.error_code ? ` · ${trace.error_code}` : ""}</Badge>
        ) : (
          <Badge tone="ok">성공</Badge>
        )}
        <span className="ml-auto text-[10px] text-[#9a948a]">{ms(trace.duration_ms)}</span>
      </div>

      <div className="flex flex-col gap-2 px-2.5 py-2">
        {description && (
          <p className="text-[11px] leading-relaxed text-[#9a948a]">
            <span className="text-[#cfc9bd]">이 스킬은</span> {description}
          </p>
        )}

        <div className="flex flex-wrap items-start gap-2 text-[11px]">
          <span className="mt-0.5 shrink-0 text-[10px] uppercase tracking-wide text-[#9a948a]">
            입력
          </span>
          <code className="min-w-0 flex-1 break-all rounded bg-[#15120d] px-2 py-1 font-mono text-[10px] text-[#cfc9bd]">
            {Object.keys(args).length === 0 ? "(인자 없음)" : JSON.stringify(args, null, 0)}
          </code>
        </div>

        <div className="flex items-start gap-2 text-[11px]">
          <ArrowRight size={12} className="mt-0.5 shrink-0 text-[#9a948a]" />
          <span className="min-w-0 flex-1 text-[#cfc9bd]">{trace.message || "—"}</span>
        </div>

        {Object.keys(data).length > 0 && (
          <Collapse
            label={truncated ? "결과 (일부만 저장됨)" : "결과 데이터"}
          >
            {truncated && (
              <p className="mb-1 text-[10px] text-[#e0a86a]">
                원본 {n((data as Record<string, number>)._chars)}자 중 앞부분만
                기록했습니다. 로그 한 행이 수만 자가 되는 것을 막기 위한 상한입니다.
              </p>
            )}
            <Code max="max-h-64">{JSON.stringify(data, null, 2)}</Code>
          </Collapse>
        )}
      </div>
    </div>
  );
}

// ── 시스템 프롬프트 + 블록 하이라이트 (D34에서 이어짐) ────────────────
const BLOCK_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  system_base: { label: "기본 지시", color: "#b6b0a4", bg: "rgba(182,176,164,0.18)" },
  rag: { label: "자료 (RAG)", color: "#3fb0aa", bg: "rgba(42,125,122,0.30)" },
  session_files: { label: "세션 파일", color: "#d98a3d", bg: "rgba(194,112,42,0.28)" },
  tag_guide: { label: "분류 태그", color: "#8fb37a", bg: "rgba(108,140,80,0.28)" },
};
function blockStyle(kind: string) {
  return (
    BLOCK_STYLE[kind] ?? { label: kind, color: "#8fa0bf", bg: "rgba(126,138,160,0.25)" }
  );
}

function SystemPrompt({
  prompt,
  blocks,
}: {
  prompt: string;
  blocks: LogContextBlock[];
}) {
  if (!prompt) return null;
  const kinds = Array.from(
    new Set(blocks.filter((b) => Array.isArray(b.prompt_span)).map((b) => b.kind)),
  );
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
          실제로 보낸 시스템 프롬프트
        </h4>
        <CopyButton text={prompt} />
      </div>
      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => {
            const st = blockStyle(k);
            return (
              <span
                key={k}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: st.bg, color: st.color }}
              >
                {st.label}
              </span>
            );
          })}
        </div>
      )}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#15120d] p-3 font-mono text-[11px] leading-relaxed text-[#cfc9bd]">
        {blocks.length > 0 ? highlight(prompt, blocks) : prompt}
      </pre>
    </section>
  );
}

/** prompt_span 구간을 kind별 색으로. 겹침은 순차 클램프로 안전하게 처리. */
function highlight(prompt: string, blocks: LogContextBlock[]) {
  const spans = blocks
    .filter(
      (b): b is LogContextBlock & { prompt_span: [number, number] } =>
        Array.isArray(b.prompt_span) && b.prompt_span.length === 2,
    )
    .map((b) => ({ start: b.prompt_span[0], end: b.prompt_span[1], kind: b.kind }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const out: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    const start = Math.max(s.start, cursor);
    const end = Math.min(s.end, prompt.length);
    if (start >= end) return;
    if (start > cursor) out.push(<span key={`p${i}`}>{prompt.slice(cursor, start)}</span>);
    const st = blockStyle(s.kind);
    out.push(
      <mark
        key={`m${i}`}
        title={st.label}
        className="rounded px-0.5"
        style={{ backgroundColor: st.bg, color: st.color }}
      >
        {prompt.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < prompt.length) out.push(<span key="tail">{prompt.slice(cursor)}</span>);
  return out;
}

function ContextBlocks({ blocks }: { blocks: LogContextBlock[] }) {
  const ordered = [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
        컨텍스트 블록 ({ordered.length})
      </h4>
      {ordered.map((b, i) => {
        const st = blockStyle(b.kind);
        const sources = (b.sources ?? []) as RagSource[];
        return (
          <div
            key={`${b.kind}-${i}`}
            className="overflow-hidden rounded-lg border bg-[#221e17]"
            style={{ borderColor: `${st.color}55` }}
          >
            <div
              className="flex items-center gap-2 px-2.5 py-1.5"
              style={{ backgroundColor: st.bg }}
            >
              <span className="text-[11px] font-semibold" style={{ color: st.color }}>
                {st.label}
              </span>
              {b.source && <span className="truncate text-[10px] text-[#9a948a]">{b.source}</span>}
              <span className="ml-auto text-[10px] text-[#9a948a]">#{b.order}</span>
            </div>
            <div className="px-2.5 py-2">
              {sources.length > 0 && (
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="text-[#9a948a]">
                      <th className="py-1 pr-2 font-medium">파일</th>
                      <th className="py-1 pr-2 font-medium">#seq</th>
                      <th className="py-1 pr-2 font-medium">거리</th>
                      <th className="py-1 font-medium">발췌</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sources.map((s, j) => (
                      <tr key={j} className="align-top">
                        <td className="py-1 pr-2 text-[#cfc9bd]">{s.name || "—"}</td>
                        <td className="py-1 pr-2 text-[#9a948a]">{s.seq ?? "—"}</td>
                        <td className="py-1 pr-2 text-[#9a948a]">
                          {s.distance != null ? s.distance.toFixed(3) : "—"}
                        </td>
                        <td className="py-1 text-[#9a948a]">
                          <span className="line-clamp-2">{s.snippet ?? ""}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {b.raw_text && (
                <Collapse label="원문">
                  <Code max="max-h-48">{b.raw_text}</Code>
                </Collapse>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
