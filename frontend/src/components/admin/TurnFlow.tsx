"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAdminFlow, getAdminSkills } from "@/lib/api";
import type {
  AdminFlow,
  AdminLog,
  AdminSkillsResponse,
  FlowNode,
  SkillTrace,
} from "@/lib/types";
import { Badge, Code, Collapse, Failed, Loading, Panel, ms, n } from "./ui";
import {
  Arrow,
  FLOW_HEAD,
  FLOW_LEGACY,
  FLOW_REACT,
  FLOW_TAIL,
  KIND_LABEL,
  Legend,
  NodeIcon,
  nodeRouteLabel,
} from "./flowView";

/**
 * 이 턴이 파이프라인의 어디를 탔는가 (D113).
 *
 * AI 흐름 탭이 "이 서비스는 이렇게 돈다"라면, 여기는 **"이 턴은 그중 어디를
 * 탔다"**이다. 같은 그림 위에 실행 여부를 덧칠한다 — 스킬을 하나도 안 쓴
 * 턴에서도 전체 흐름이 그대로 보이고, 대신 어느 칸을 건너뛰었는지가 드러난다.
 * (인사 턴에서 검색이 안 나가는 게 설계인데, 그 사실은 "건너뜀"으로 보여야
 * 확인이 된다. 빈 화면은 정상인지 고장인지 구분해 주지 못한다.)
 *
 * 그림 정의는 서버에서 온다 — 스킬 이름·활성 경로를 프론트에 적어 두면 코드가
 * 바뀔 때 그림만 옛말이 된다.
 */

type RunState = "ran" | "skipped" | "off-route" | "unknown";

export function TurnFlow({ log }: { log: AdminLog }) {
  const { data: flow, isLoading, isError } = useQuery<AdminFlow>({
    queryKey: ["admin", "flow"],
    queryFn: getAdminFlow,
    staleTime: 5 * 60_000,
  });
  const { data: catalog } = useQuery<AdminSkillsResponse>({
    queryKey: ["admin", "skills"],
    queryFn: () => getAdminSkills(30),
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) return <Panel title="이 턴의 흐름"><Loading /></Panel>;
  if (isError || !flow) return <Panel title="이 턴의 흐름"><Failed /></Panel>;

  const run = buildRun(log);
  const byId = new Map(flow.nodes.map((nd) => [nd.id, nd]));
  const traces = log.skill_calls ?? [];
  const describe = (name: string) =>
    catalog?.skills.find((s) => s.name === name)?.description ?? "";

  const row = (id: string, arrow: boolean) => {
    const node = byId.get(id);
    if (!node) return null;
    return (
      <NodeRow
        key={id}
        node={node}
        state={run.state[id] ?? "unknown"}
        note={run.note[id]}
        selected={open === id}
        onSelect={() => setOpen(open === id ? null : id)}
        arrow={arrow}
      />
    );
  };

  return (
    <Panel
      title="이 턴의 흐름"
      right={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge tone={run.route === "unknown" ? "warn" : "gold"}>
            {run.route === "react"
              ? "ReAct 경로"
              : run.route === "legacy"
                ? "단발(레거시) 경로"
                : "경로 기록 이전"}
          </Badge>
          <Badge tone={traces.length > 0 ? "ok" : "default"}>
            {traces.length > 0 ? `스킬 ${traces.length}회` : "스킬 미사용"}
          </Badge>
          {log.duration_ms != null && <Badge>{ms(log.duration_ms)}</Badge>}
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-1.5">
          {FLOW_HEAD.map((id) => row(id, true))}

          <div className="grid grid-cols-1 gap-3 rounded-lg border border-dashed border-white/15 p-2.5 md:grid-cols-2">
            <BranchColumn
              title="ReAct 경로"
              ids={FLOW_REACT}
              taken={run.route === "react"}
              row={row}
            />
            <BranchColumn
              title="단발(레거시) 경로"
              ids={FLOW_LEGACY}
              taken={run.route === "legacy"}
              row={row}
            />
          </div>

          <Arrow />
          {FLOW_TAIL.map((id, i) => row(id, i < FLOW_TAIL.length - 1))}
        </div>

        <div className="flex flex-col gap-3">
          <SidePanel
            node={open ? byId.get(open) : undefined}
            state={open ? run.state[open] : undefined}
            note={open ? run.note[open] : undefined}
            traces={open === "skills" ? traces : []}
            describe={describe}
          />
          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a948a]">
              범례
            </div>
            <Legend />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="ok">실행됨</Badge>
              <Badge tone="warn">건너뜀</Badge>
              <Badge>다른 경로</Badge>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * 로그 한 행에서 "어느 칸이 실제로 돌았는가"를 만든다.
 *
 * **추측하지 않는다.** route가 없는 옛 로그(D113 이전)는 경로를 모르므로 분기
 * 이후를 전부 `unknown`으로 둔다 — 그럴듯하게 채우면 없는 사실을 보여 주게 된다.
 */
function buildRun(log: AdminLog): {
  route: "react" | "legacy" | "unknown";
  state: Record<string, RunState>;
  note: Record<string, string>;
} {
  const route: "react" | "legacy" | "unknown" =
    log.route === "react" ? "react" : log.route === "legacy" ? "legacy" : "unknown";
  const traces = log.skill_calls ?? [];
  const calls = log.tokens?.calls ?? [];
  const decideCalls = calls.filter((c) => c.stage === "decide");
  const answerCall = calls.find((c) => c.stage === "answer");
  const hasAnswer = !!log.answer;

  const state: Record<string, RunState> = {};
  const note: Record<string, string> = {};

  // 분기 전후는 경로와 무관하게 항상 돈다.
  for (const id of [...FLOW_HEAD, ...FLOW_TAIL]) state[id] = "ran";

  note.history =
    log.contexts?.history != null
      ? `이전 ${(log.contexts.history as { turns?: number }).turns ?? 0}턴을 맥락으로 실었다`
      : "";
  note.route =
    route === "unknown"
      ? "이 로그에는 경로가 기록되지 않았다(D113 이전 턴)"
      : route === "react"
        ? "react_enabled = on → ReAct 경로"
        : "react_enabled = off → 단발 경로";
  note.compose = log.system_prompt
    ? `시스템 프롬프트 ${n(log.system_prompt.length)}자`
    : "";
  note.answer = answerCall
    ? `입력 ${n(answerCall.prompt)} · 출력 ${n(answerCall.completion)} tok` +
      (log.model ? ` · ${log.model}` : "")
    : "실측 토큰이 기록되지 않았다";
  note.parse = hasAnswer ? `답변 ${n(log.answer!.length)}자를 카드로 파싱` : "";
  note.log = log.duration_ms != null ? `턴 전체 ${ms(log.duration_ms)}` : "";

  if (!hasAnswer) {
    // 답변이 없으면 저장·파싱까지 가지 못한 턴이다.
    for (const id of ["parse", "layout", "persist"]) state[id] = "skipped";
    note.persist = "답변이 없어 노드를 저장하지 않았다";
  } else if (!log.node_id) {
    state.persist = "skipped";
    note.persist = "노드 저장에 실패했다(로그만 남았다)";
  }

  // ── 분기 ────────────────────────────────────────────────────────
  const reactIds = FLOW_REACT;
  const legacyIds = FLOW_LEGACY;
  if (route === "unknown") {
    for (const id of [...reactIds, ...legacyIds]) state[id] = "unknown";
  } else if (route === "react") {
    for (const id of legacyIds) state[id] = "off-route";
    state.catalog = "ran";
    state.decide = decideCalls.length > 0 ? "ran" : "unknown";
    state.tools_needed = "ran";
    note.decide =
      decideCalls.length > 0
        ? `${decideCalls.length}회 판단 · ${n(
            decideCalls.reduce((a, c) => a + (c.total ?? 0), 0),
          )} tok`
        : "판단 호출의 토큰이 기록되지 않았다";
    if (traces.length > 0) {
      state.skills = "ran";
      const okCount = traces.filter((t) => t.ok !== false && !t.skipped).length;
      note.skills = `${traces.length}회 호출 · 성공 ${okCount}`;
      const evidenceWorthy = traces.some(
        (t) => t.ok !== false && !t.skipped && t.skill !== "think",
      );
      state.evidence = evidenceWorthy ? "ran" : "skipped";
      note.evidence = evidenceWorthy
        ? "스킬이 찾은 내용을 근거 블록으로 붙여 생성 단계에 넘겼다"
        : "근거로 쓸 결과가 없어 블록을 붙이지 않았다";
      note.tools_needed = "도구가 필요하다고 판단했다";
    } else {
      state.skills = "skipped";
      state.evidence = "skipped";
      note.skills =
        "모델이 도구를 부르지 않았다 — 인사·잡담이거나 일반 지식으로 충분한 질문이다. " +
        "이 턴에는 임베딩·벡터 검색이 아예 나가지 않았다.";
      note.evidence = "붙일 근거가 없다";
      note.tools_needed = "도구가 필요 없다고 판단해 곧장 생성으로 넘어갔다";
    }
    note.catalog = "스코프·세션 상태로 노출 도구를 먼저 좁혔다";
  } else {
    for (const id of reactIds) state[id] = "off-route";
    state.prefetch = "ran";
    note.prefetch =
      "질문과 무관하게 자료 검색·세션 파일·도판 검색을 모두 미리 돌렸다";
  }

  return { route, state, note };
}

function BranchColumn({
  title,
  ids,
  taken,
  row,
}: {
  title: string;
  ids: string[];
  taken: boolean;
  row: (id: string, arrow: boolean) => React.ReactNode;
}) {
  return (
    <div className={taken ? "" : "opacity-40"}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#9a948a]">
          {title}
        </span>
        {taken && <Badge tone="ok">이 턴이 탄 경로</Badge>}
      </div>
      <div className="flex flex-col gap-1.5">
        {ids.map((id, i) => row(id, i < ids.length - 1))}
      </div>
    </div>
  );
}

const STATE_BADGE: Record<RunState, { label: string; tone: "ok" | "warn" | "default" }> = {
  ran: { label: "실행됨", tone: "ok" },
  skipped: { label: "건너뜀", tone: "warn" },
  "off-route": { label: "다른 경로", tone: "default" },
  unknown: { label: "기록 없음", tone: "default" },
};

function NodeRow({
  node,
  state,
  note,
  selected,
  onSelect,
  arrow,
}: {
  node: FlowNode;
  state: RunState;
  note?: string;
  selected: boolean;
  onSelect: () => void;
  arrow?: boolean;
}) {
  const badge = STATE_BADGE[state];
  const faded = state === "off-route" || state === "unknown";
  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
          selected
            ? "border-[#e0a32e]/60 bg-[#2c2820]"
            : "border-white/10 bg-[#221e17] hover:border-white/25"
        } ${faded ? "opacity-45" : ""}`}
      >
        <NodeIcon kind={node.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[#e7e3d8]">{node.label}</span>
          {note ? (
            <span className="block truncate text-[10px] text-[#9a948a]">{note}</span>
          ) : null}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </button>
      {arrow && <Arrow small />}
    </>
  );
}

function SidePanel({
  node,
  state,
  note,
  traces,
  describe,
}: {
  node: FlowNode | undefined;
  state: RunState | undefined;
  note: string | undefined;
  traces: SkillTrace[];
  describe: (name: string) => string;
}) {
  if (!node) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#221e17] p-3">
        <p className="text-[11px] leading-relaxed text-[#9a948a]">
          단계를 누르면 이 턴에서 그 단계가 실제로 무엇을 했는지 나옵니다. 스킬을
          쓰지 않은 턴이면 어느 칸을 건너뛰었는지가 보입니다.
        </p>
      </div>
    );
  }
  const badge = state ? STATE_BADGE[state] : null;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-white/10 bg-[#221e17] p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <NodeIcon kind={node.kind} />
        <span className="text-sm font-semibold text-[#e7e3d8]">{node.label}</span>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="info">{KIND_LABEL[node.kind] ?? node.kind}</Badge>
        <Badge>{nodeRouteLabel(node)}</Badge>
      </div>

      {note && (
        <p className="rounded bg-[#15120d] px-2 py-1.5 text-[11px] leading-relaxed text-[#cfc9bd]">
          이 턴: {note}
        </p>
      )}

      {node.detail && (
        <p className="text-[11px] leading-relaxed text-[#9a948a]">{node.detail}</p>
      )}

      {node.where && (
        <code className="block break-all rounded bg-[#15120d] px-2 py-1 font-mono text-[10px] text-[#9bbf6a]">
          {node.where}
        </code>
      )}

      {node.tunables?.length ? (
        <div className="flex flex-wrap gap-1">
          {node.tunables.map((t) => (
            <code
              key={t}
              className="rounded bg-[#e0a32e]/15 px-1.5 py-0.5 font-mono text-[10px] text-[#fcf58b]"
            >
              {t}
            </code>
          ))}
        </div>
      ) : null}

      {/* 스킬 칸을 열면 이 턴이 실제로 부른 스킬이 순서대로 나온다. */}
      {node.id === "skills" && (
        <div className="flex flex-col gap-2">
          {traces.length === 0 ? (
            <p className="rounded border border-[#c2702a]/40 bg-[#c2702a]/10 px-2 py-1.5 text-[11px] leading-relaxed text-[#e0c08e]">
              이 턴은 도구를 하나도 부르지 않았습니다. 노출된 도구 중 모델이 아무것도
              고르지 않은 것이며, 오류가 아닙니다.
            </p>
          ) : (
            traces.map((t, i) => (
              <MiniTrace key={i} trace={t} description={describe(t.skill)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MiniTrace({
  trace,
  description,
}: {
  trace: SkillTrace;
  description: string;
}) {
  const failed = trace.ok === false;
  return (
    <div
      className="overflow-hidden rounded border"
      style={{
        borderColor: failed
          ? "rgba(224,121,106,0.45)"
          : trace.skipped
            ? "rgba(224,168,106,0.35)"
            : "rgba(155,191,106,0.35)",
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5 bg-[#25211a] px-2 py-1">
        <code className="text-[11px] font-semibold text-[#fcf58b]">{trace.skill}</code>
        {trace.skipped ? (
          <Badge tone="warn">중복 생략</Badge>
        ) : failed ? (
          <Badge tone="bad">실패</Badge>
        ) : (
          <Badge tone="ok">성공</Badge>
        )}
        <span className="ml-auto text-[10px] text-[#9a948a]">{ms(trace.duration_ms)}</span>
      </div>
      <div className="flex flex-col gap-1.5 px-2 py-1.5">
        {description && (
          <p className="text-[10px] leading-relaxed text-[#9a948a]">{description}</p>
        )}
        <div>
          <div className="text-[9px] uppercase tracking-wide text-[#6f6a62]">입력</div>
          <code className="block break-all font-mono text-[10px] text-[#cfc9bd]">
            {Object.keys(trace.args ?? {}).length === 0
              ? "(인자 없음)"
              : JSON.stringify(trace.args)}
          </code>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-[#6f6a62]">결과</div>
          <span className="text-[11px] text-[#cfc9bd]">{trace.message || "—"}</span>
        </div>
        {trace.data && Object.keys(trace.data).length > 0 && (
          <Collapse label="결과 데이터">
            <Code max="max-h-48">{JSON.stringify(trace.data, null, 2)}</Code>
          </Collapse>
        )}
      </div>
    </div>
  );
}
