"use client";

import dynamic from "next/dynamic";
import type { NodeRow } from "@/lib/types";

/**
 * D3 세션 그래프는 클라이언트 전용(SSR 비활성). window/SVG 측정 의존.
 */
const Canvas = dynamic(() => import("./SessionGraphCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-bg-elevated text-sm text-fg-muted">
      그래프 로딩 중…
    </div>
  ),
});

interface Props {
  nodes: NodeRow[];
  rootNodeId: string | null;
  activeNodeId: string | null;
  onNodeClick: (id: string) => void;
}

export function SessionGraph(props: Props) {
  if (props.nodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-elevated p-4 text-center text-sm text-fg-muted">
        아직 노드가 없습니다.
        <br />
        질문을 보내면 세션 그래프가 자라납니다.
      </div>
    );
  }
  return <Canvas {...props} />;
}
