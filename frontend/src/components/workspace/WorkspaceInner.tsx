"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addConnection,
  addFileLink,
  removeConnection,
  removeFileLink,
  spaceTargetFromId,
} from "@/lib/api";
import {
  fileLinksKey,
  sessionKey,
  useSessionDetail,
  useSessionFileLinks,
} from "@/lib/queries";
import { useWorkspaceChat } from "@/lib/useWorkspaceChat";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { SessionDetail } from "@/lib/types";
import { SessionList } from "./SessionList";
import { FilesPanel } from "./FilesPanel";
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
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pendingSession = useWorkspaceStore((s) => s.pendingSession);
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  // 공간 진입 시 선택 상태 초기화 + 활성 공간 기록(개념 페이지가 참조)
  useEffect(() => {
    reset();
    setActiveSpace(spaceId);
  }, [reset, setActiveSpace, spaceId]);

  const chat = useWorkspaceChat(target);

  // 홈에서 넘긴 보류 작업 소비: 세션 선택(+ 시드 질문 전송)
  // 같은 커밋의 reset effect가 store.activeSessionId를 null로 만들 수 있으므로,
  // stale 클로저(activeSessionId) 대신 store의 현재값(getState)을 비교해 선택 누락을 막는다.
  useEffect(() => {
    if (!pendingSession || pendingSession.spaceId !== spaceId) return;
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current !== pendingSession.sessionId) {
      setActiveSession(pendingSession.sessionId);
      return;
    }
    if (pendingSession.seed) {
      if (chat.streaming) return;
      const seed = pendingSession.seed;
      setPendingSession(null);
      void chat.send(seed, null);
    } else {
      setPendingSession(null);
    }
  }, [
    pendingSession,
    spaceId,
    activeSessionId,
    chat,
    setActiveSession,
    setPendingSession,
  ]);

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

  // ── 시각적 RAG: 파일↔분기 연결 ──
  const { data: fileLinks = [] } = useSessionFileLinks(activeSessionId);
  // 자료 패널에서 시작한 "분기에 연결" 중인 파일 id (그래프 클릭으로 target 선택)
  const [linkFileId, setLinkFileId] = useState<string | null>(null);

  const refreshFileLinks = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: fileLinksKey(activeSessionId),
    });
  }, [queryClient, activeSessionId]);

  const handleLinkTarget = useCallback(
    async (nodeId: string) => {
      if (!linkFileId) return;
      const fileId = linkFileId;
      setLinkFileId(null);
      try {
        await addFileLink(fileId, nodeId);
        refreshFileLinks();
      } catch {
        /* 무시(백엔드가 소유권 검증) */
      }
    },
    [linkFileId, refreshFileLinks],
  );

  const handleRemoveFileLink = useCallback(
    async (fileId: string, nodeId: string) => {
      try {
        await removeFileLink(fileId, nodeId);
        refreshFileLinks();
      } catch {
        /* 무시 */
      }
    },
    [refreshFileLinks],
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
        <div className="flex min-h-0 flex-col border-r border-accent-border/30">
          <SessionList target={target} />
          <FilesPanel
            target={target}
            fileLinks={fileLinks}
            linkFileId={linkFileId}
            onStartLink={setLinkFileId}
            onCancelLink={() => setLinkFileId(null)}
          />
        </div>
        <div className="flex min-h-0 flex-col border-x border-accent-border/30">
          <ChatPanel chat={chat} fileLinks={fileLinks} />
        </div>
        <div className="min-h-0 border-l border-accent-border/30">
          <SessionGraph
            nodes={nodes}
            rootNodeId={rootNodeId}
            activeNodeId={activeNodeId}
            onNodeClick={handleNodeClick}
            onConnectSource={handleConnectSource}
            onRemoveConnection={handleRemoveConnection}
            fileLinks={fileLinks}
            fileLinkMode={!!linkFileId}
            onLinkTarget={handleLinkTarget}
            onRemoveFileLink={handleRemoveFileLink}
          />
        </div>
      </div>
    </div>
  );
}
