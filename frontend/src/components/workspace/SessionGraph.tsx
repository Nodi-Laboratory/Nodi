"use client";

import dynamic from "next/dynamic";
import type { FileLink, FileRow, NodeRow } from "@/lib/types";

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
  onConnectNodes: (sourceId: string, targetId: string) => void;
  onRemoveConnection: (targetId: string, sourceId: string) => void;
  fileLinks: FileLink[];
  fileNodes: FileRow[];
  fileTags: Record<string, string[]>;
  fileLinkMode: boolean;
  onLinkTarget: (nodeId: string) => void;
  onRemoveFileLink: (fileId: string, nodeId: string) => void;
  onConnectFileToNode: (fileId: string, nodeId: string) => void;
  onDeleteFile: (fileId: string) => void;
  onFilePosition: (fileId: string, x: number, y: number) => void;
  onDropUpload: (files: File[], x: number, y: number) => void;
  onPersistPositions: (
    positions: { node_id: string; x: number; y: number }[],
  ) => void;
  trackMode: boolean;
  selectedTrackIds: string[];
  onToggleTrack: (nodeId: string) => void;
  onEnterTrack: (nodeId: string) => void;
}

export function SessionGraph(props: Props) {
  // 대화 노드도 자료 노드도 없을 때만 빈 안내. (자료만 있어도 캔버스 렌더 — D22)
  if (props.nodes.length === 0 && props.fileNodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-elevated p-4 text-center text-sm text-fg-muted">
        아직 노드가 없습니다.
        <br />
        질문을 보내거나 자료를 올리면 그래프가 자라납니다.
      </div>
    );
  }
  return <Canvas {...props} />;
}
