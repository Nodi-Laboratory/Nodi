"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  Braces,
  Brain,
  Database,
  Eye,
  FileSearch,
  GitBranch,
  Layers,
  MonitorPlay,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { getAdminFlow } from "@/lib/api";
import type { AdminFlow, FlowNode } from "@/lib/types";
import { Badge, C, Failed, Loading, Panel, n } from "./ui";

/**
 * AI 흐름 탭 (D113) — 채팅 한 턴이 실제로 어떻게 도는지.
 *
 * 그래프 정의는 **서버가 준다**(services/admin_console.flow_spec). 스킬 이름과
 * 활성 경로를 프론트에 적어 두면 코드가 바뀔 때 그림만 옛말이 되기 때문이다 —
 * 문서가 거짓말하는 가장 흔한 방식이다.
 *
 * 꺼진 경로도 흐리게 함께 그린다. 지우면 "롤백하면 뭐가 도는지"를 화면만 봐서는
 * 알 수 없다.
 */

const KIND_ICON: Record<string, typeof Brain> = {
  io: MonitorPlay,
  guard: ShieldCheck,
  read: FileSearch,
  decision: GitBranch,
  logic: Braces,
  llm: Brain,
  skill: Wrench,
  render: Eye,
  store: Database,
};

const KIND_LABEL: Record<string, string> = {
  io: "입출력",
  guard: "권한",
  read: "조회",
  decision: "분기",
  logic: "조립",
  llm: "LLM 호출",
  skill: "스킬",
  render: "화면",
  store: "저장",
};

const KIND_COLOR: Record<string, string> = {
  io: "#8fa0bf",
  guard: "#bd86c4",
  read: "#3fb0aa",
  decision: C.gold,
  logic: "#b6b0a4",
  llm: "#e0796a",
  skill: "#9bbf6a",
  render: "#7fb2c4",
  store: "#d98a3d",
};

export function FlowTab() {
  const { data, isLoading, isError } = useQuery<AdminFlow>({
    queryKey: ["admin", "flow"],
    queryFn: getAdminFlow,
  });
  const [selected, setSelected] = useState<string | null>(null);

  if (isLoading) return <Loading />;
  if (isError || !data) return <Failed />;

  const active = data.active_route;
  const byId = new Map(data.nodes.map((nd) => [nd.id, nd]));
  const detail = selected ? byId.get(selected) : null;

  // 세로 흐름으로 그린다. 분기 구간(catalog…evidence / prefetch)만 두 열로 나눈다.
  const head = ["question", "authz", "history", "route"];
  const tail = ["compose", "answer", "parse", "layout", "persist", "log"];
  const reactCol = ["catalog", "decide", "tools_needed", "skills", "evidence"];
  const legacyCol = ["prefetch"];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">채팅 한 턴의 흐름</h2>
        <Badge tone="gold">
          현재 경로: {active === "react" ? "ReAct 스킬 루프" : "단발(레거시)"}
        </Badge>
        <Badge>도구 라운드 상한 {data.react_max_steps}</Badge>
        {Object.entries(data.observed_routes ?? {}).map(([k, v]) => (
          <Badge key={k} tone={k === active ? "ok" : "default"}>
            로그상 {k === "unknown" ? "기록 이전" : k} {n(v)}턴
          </Badge>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="파이프라인">
          <div className="flex flex-col items-stretch gap-1.5">
            {head.map((id) => (
              <NodeRow
                key={id}
                node={byId.get(id)}
                active={active}
                onSelect={setSelected}
                selected={selected === id}
                arrow
              />
            ))}

            {/* 분기 — 두 경로를 나란히 */}
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-dashed border-white/15 p-2.5 md:grid-cols-2">
              <BranchColumn
                title="react_enabled = on"
                ids={reactCol}
                route="react"
                active={active}
                byId={byId}
                onSelect={setSelected}
                selected={selected}
              />
              <BranchColumn
                title="react_enabled = off (롤백 경로)"
                ids={legacyCol}
                route="legacy"
                active={active}
                byId={byId}
                onSelect={setSelected}
                selected={selected}
              />
            </div>

            <div className="flex justify-center py-0.5">
              <ArrowDown size={14} className="text-[#9a948a]" />
            </div>

            {tail.map((id, i) => (
              <NodeRow
                key={id}
                node={byId.get(id)}
                active={active}
                onSelect={setSelected}
                selected={selected === id}
                arrow={i < tail.length - 1}
              />
            ))}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title={detail ? detail.label : "단계 상세"}>
            {detail ? (
              <NodeDetail node={detail} />
            ) : (
              <p className="text-xs leading-relaxed text-[#9a948a]">
                단계를 누르면 어디 코드에서 도는지, 어떤 설정이 걸려 있는지,
                왜 그렇게 만들었는지가 여기 나옵니다.
              </p>
            )}
          </Panel>

          <Panel title="범례">
            <div className="flex flex-wrap gap-1.5">
              {Object.keys(KIND_LABEL).map((k) => {
                const Icon = KIND_ICON[k] ?? Layers;
                return (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                    style={{
                      backgroundColor: `${KIND_COLOR[k]}22`,
                      color: KIND_COLOR[k],
                    }}
                  >
                    <Icon size={11} />
                    {KIND_LABEL[k]}
                  </span>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-[#9a948a]">
              흐린 칸은 지금 꺼져 있는 경로입니다. 지우지 않고 남겨 둡니다 —
              롤백했을 때 무엇이 도는지 화면에서 바로 보이도록.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function BranchColumn({
  title,
  ids,
  route,
  active,
  byId,
  onSelect,
  selected,
}: {
  title: string;
  ids: string[];
  route: "react" | "legacy";
  active: string;
  byId: Map<string, FlowNode>;
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  const on = active === route;
  return (
    <div className={on ? "" : "opacity-45"}>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#9a948a]">
          {title}
        </span>
        {on && <Badge tone="ok">활성</Badge>}
      </div>
      <div className="flex flex-col gap-1.5">
        {ids.map((id, i) => (
          <NodeRow
            key={id}
            node={byId.get(id)}
            active={active}
            onSelect={onSelect}
            selected={selected === id}
            arrow={i < ids.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function NodeRow({
  node,
  active,
  onSelect,
  selected,
  arrow,
}: {
  node: FlowNode | undefined;
  active: string;
  onSelect: (id: string) => void;
  selected: boolean;
  arrow?: boolean;
}) {
  if (!node) return null;
  const Icon = KIND_ICON[node.kind] ?? Layers;
  const color = KIND_COLOR[node.kind] ?? "#8fa0bf";
  const dim = node.route !== "both" && node.route !== active;
  return (
    <>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
          selected
            ? "border-[#e0a32e]/60 bg-[#2c2820]"
            : "border-white/10 bg-[#221e17] hover:border-white/25"
        } ${dim ? "opacity-45" : ""}`}
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
          style={{ backgroundColor: `${color}22`, color }}
        >
          <Icon size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[#e7e3d8]">
          {node.label}
        </span>
        {node.tunables?.length ? (
          <Badge tone="gold" title={node.tunables.join(", ")}>
            설정 {node.tunables.length}
          </Badge>
        ) : null}
        {node.skills?.length ? <Badge tone="ok">스킬 {node.skills.length}</Badge> : null}
      </button>
      {arrow && (
        <div className="flex justify-center">
          <ArrowDown size={12} className="text-[#5f5a52]" />
        </div>
      )}
    </>
  );
}

function NodeDetail({ node }: { node: FlowNode }) {
  return (
    <div className="flex flex-col gap-2.5 text-xs">
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="info">{KIND_LABEL[node.kind] ?? node.kind}</Badge>
        <Badge>
          {node.route === "both" ? "두 경로 공통" : node.route === "react" ? "ReAct 전용" : "레거시 전용"}
        </Badge>
      </div>
      {node.detail && (
        <p className="leading-relaxed text-[#cfc9bd]">{node.detail}</p>
      )}
      {node.where && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[#9a948a]">
            코드
          </div>
          <code className="block break-all rounded bg-[#15120d] px-2 py-1 font-mono text-[10px] text-[#9bbf6a]">
            {node.where}
          </code>
        </div>
      )}
      {node.tunables?.length ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[#9a948a]">
            걸린 설정
          </div>
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
        </div>
      ) : null}
      {node.skills?.length ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[#9a948a]">
            등록된 스킬
          </div>
          <div className="flex flex-wrap gap-1">
            {node.skills.map((s) => (
              <code
                key={s}
                className="rounded bg-[#6e8a3c]/25 px-1.5 py-0.5 font-mono text-[10px] text-[#9bbf6a]"
              >
                {s}
              </code>
            ))}
          </div>
        </div>
      ) : null}
      {node.params ? (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[#9a948a]">
            호출 파라미터
          </div>
          <div className="flex flex-col gap-0.5">
            {Object.entries(node.params).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-[#9a948a]">{k}</span>
                <span className="text-[#cfc9bd]">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
