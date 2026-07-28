"use client";

/**
 * AI 흐름의 시각 언어 (D113).
 *
 * **AI 흐름 탭과 턴별 흐름이 같은 그림이어야 한다.** 하나는 "이 서비스는 이렇게
 * 돈다", 다른 하나는 "이 턴은 그중 어디를 탔다"인데, 아이콘·색·배치가 다르면
 * 두 화면을 오갈 때 같은 단계라는 걸 알아볼 수 없다. 그래서 노드 렌더를 여기
 * 한 곳에 두고 둘이 함께 쓴다.
 */

import { ArrowDown } from "lucide-react";
import {
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
import type { FlowNode } from "@/lib/types";
import { C } from "./ui";

export const KIND_ICON: Record<string, typeof Brain> = {
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

export const KIND_LABEL: Record<string, string> = {
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

export const KIND_COLOR: Record<string, string> = {
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

/** 파이프라인 세로 배치. 분기 구간만 두 열로 나뉜다. */
export const FLOW_HEAD = ["question", "authz", "history", "route"];
export const FLOW_REACT = ["catalog", "decide", "tools_needed", "skills", "evidence"];
export const FLOW_LEGACY = ["prefetch"];
export const FLOW_TAIL = [
  "compose",
  "answer",
  "parse",
  "layout",
  "persist",
  "log",
];

export function Arrow({ small = false }: { small?: boolean }) {
  return (
    <div className="flex justify-center py-0.5">
      <ArrowDown size={small ? 12 : 14} className="text-[#5f5a52]" />
    </div>
  );
}

export function NodeIcon({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] ?? Layers;
  const color = KIND_COLOR[kind] ?? "#8fa0bf";
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
      style={{ backgroundColor: `${color}22`, color }}
    >
      <Icon size={13} />
    </span>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.keys(KIND_LABEL).map((k) => {
        const Icon = KIND_ICON[k] ?? Layers;
        return (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
            style={{ backgroundColor: `${KIND_COLOR[k]}22`, color: KIND_COLOR[k] }}
          >
            <Icon size={11} />
            {KIND_LABEL[k]}
          </span>
        );
      })}
    </div>
  );
}

export function nodeRouteLabel(node: FlowNode): string {
  return node.route === "both"
    ? "두 경로 공통"
    : node.route === "react"
      ? "ReAct 전용"
      : "레거시 전용";
}
