"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { addConnection, removeConnection, spaceTargetFromId } from "@/lib/api";
import { sessionKey, useSessionDetail } from "@/lib/queries";
import { useWorkspaceChat } from "@/lib/useWorkspaceChat";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { SessionDetail } from "@/lib/types";
import { SessionList } from "./SessionList";
import { ChatPanel } from "./ChatPanel";
import { SessionGraph } from "./SessionGraph";

/**
 * 공간 워크스페이스 3분할 오케스트레이터.
 * spaceId로 key를 주어 공간 전환 시 깨끗이 리마운트한다.
 */
export function WorkspaceInner({ spaceId }: { spaceId: string }) {
  const target = spaceTargetFromId(spaceId);
  const queryClient = useQueryClient();

  const reset = useWorkspaceStore((s) => s.reset);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeNodeId = useWorkspaceStore((s) => s.activeNodeId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  // 공간 진입 시 선택 상태 초기화 + 활성 공간 기록(개념 페이지가 참조)
  useEffect(() => {
    reset();
    setActiveSpace(spaceId);
  }, [reset, setActiveSpace, spaceId]);

  const chat = useWorkspaceChat(target);

  const { data: detail } = useSessionDetail(activeSessionId);
  const nodes = useMemo(() => detail?.nodes ?? [], [detail?.nodes]);
  const rootNodeId = detail?.session?.root_node_id ?? null;

  // 그래프 노드 클릭: 네비게이터 노드는 활성화(질문 생성+삭제), 일반 노드는 분기점 이동
  const handleNodeClick = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (node?.is_navigator) {
        void chat.activateNavigator(node);
      } else {
        setActiveNode(id);
      }
    },
    [nodes, chat, setActiveNode],
  );

  // 세션 상세 캐시의 특정 노드 connections 패치
  const patchConnections = useCallback(
    (nodeId: string, connections: string[]) => {
      queryClient.setQueryData<SessionDetail>(
        sessionKey(activeSessionId),
        (old) =>
          old
            ? {
                ...old,
                nodes: old.nodes.map((n) =>
                  n.id === nodeId ? { ...n, connections } : n,
                ),
              }
            : old,
      );
    },
    [queryClient, activeSessionId],
  );

  // 기억 연결: source 노드를 현재 노드(target=activeNodeId)로 연결
  const handleConnectSource = useCallback(
    async (sourceId: string) => {
      const targetId = activeNodeId;
      if (!targetId || targetId === sourceId) return;
      try {
        const resp = await addConnection(targetId, sourceId);
        patchConnections(targetId, resp.connections);
      } catch {
        /* 실패 시 캐시 유지(백엔드가 self/소유권 검증) */
      }
    },
    [activeNodeId, patchConnections],
  );

  const handleRemoveConnection = useCallback(
    async (targetId: string, sourceId: string) => {
      try {
        const resp = await removeConnection(targetId, sourceId);
        patchConnections(targetId, resp.connections);
      } catch {
        /* 무시 */
      }
    },
    [patchConnections],
  );

  const spaceLabel = spaceId === "personal" ? "개인 공간" : "학급 공간";

  return (
    <div className="flex h-full w-full flex-col">
      <header className="border-b border-accent-border/30 bg-bg-elevated px-5 py-3">
        <h1 className="text-sm font-semibold text-fg">
          공간 워크스페이스
          <span className="ml-2 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
            {spaceLabel}
          </span>
        </h1>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_380px]">
        <SessionList target={target} />
        <div className="flex min-h-0 flex-col border-x border-accent-border/30">
          <ChatPanel chat={chat} />
        </div>
        <div className="min-h-0 border-l border-accent-border/30">
          <SessionGraph
            nodes={nodes}
            rootNodeId={rootNodeId}
            activeNodeId={activeNodeId}
            onNodeClick={handleNodeClick}
            onConnectSource={handleConnectSource}
            onRemoveConnection={handleRemoveConnection}
          />
        </div>
      </div>
    </div>
  );
}
