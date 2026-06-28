"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addConnection,
  addFileLink,
  patchFilePosition,
  putNodePositions,
  removeConnection,
  removeFileLink,
  spaceTargetFromId,
  uploadFile,
} from "@/lib/api";
import {
  fileLinksKey,
  filesKey,
  sessionKey,
  useFiles,
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

  // 그래프 노드 클릭: 네비게이터=활성화, 일반=분기점 이동
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

  // ── 기억 연결(D14): source=우클릭 노드, target=클릭 노드 ──
  const patchConnections = useCallback(
    (nodeId: string, connections: string[]) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(activeSessionId), (old) =>
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

  const handleConnectNodes = useCallback(
    async (sourceId: string, targetId: string) => {
      if (!targetId || targetId === sourceId) return;
      try {
        const resp = await addConnection(targetId, sourceId);
        patchConnections(targetId, resp.connections);
      } catch {
        /* 백엔드가 self/소유권/유효성 검증 */
      }
    },
    [patchConnections],
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

  // ── 좌표 영속(D20) ──
  const handlePersistPositions = useCallback(
    (positions: { node_id: string; x: number; y: number }[]) => {
      if (!activeSessionId || positions.length === 0) return;
      void putNodePositions(activeSessionId, positions);
    },
    [activeSessionId],
  );

  // ── 파일(D13/D16): 세션 파일을 그래프 노드로 ──
  const { data: spaceFiles = [] } = useFiles(target);
  const fileNodes = useMemo(
    () =>
      activeSessionId
        ? spaceFiles.filter((f) => f.session_id === activeSessionId)
        : [],
    [spaceFiles, activeSessionId],
  );

  const { data: fileLinks = [] } = useSessionFileLinks(activeSessionId);
  const [linkFileId, setLinkFileId] = useState<string | null>(null);

  const refreshFiles = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: filesKey(target) });
  }, [queryClient, target]);
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
        /* 무시 */
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

  const handleFilePosition = useCallback(
    (fileId: string, x: number, y: number) => {
      void patchFilePosition(fileId, x, y).catch(() => {});
    },
    [],
  );

  const handleDropUpload = useCallback(
    async (files: File[], x: number, y: number) => {
      if (!activeSessionId) return;
      for (const file of files) {
        try {
          await uploadFile(target, file, {
            sessionId: activeSessionId,
            positionX: x,
            positionY: y,
          });
        } catch {
          /* 503 등은 자료 패널 업로드에서 안내 */
        }
      }
      refreshFiles();
    },
    [target, activeSessionId, refreshFiles],
  );

  // ── 브랜치 참조(D15) ──
  const [trackMode, setTrackMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);

  const enterTrack = useCallback((nodeId?: string) => {
    setTrackMode(true);
    if (nodeId) {
      setSelectedTrackIds((prev) =>
        prev.includes(nodeId) ? prev : [...prev, nodeId],
      );
    }
  }, []);
  const toggleTrack = useCallback((nodeId: string) => {
    setTrackMode(true);
    setSelectedTrackIds((prev) =>
      prev.includes(nodeId)
        ? prev.filter((id) => id !== nodeId)
        : [...prev, nodeId],
    );
  }, []);
  const clearTracks = useCallback(() => {
    setTrackMode(false);
    setSelectedTrackIds([]);
  }, []);
  const toggleTrackMode = useCallback(() => {
    setTrackMode((v) => {
      if (v) setSelectedTrackIds([]);
      return !v;
    });
  }, []);

  // 전송에 실을 참조 노드들(head 포함, 중복 제거)
  const referenceNodeIds = useMemo(() => {
    if (!trackMode) return [];
    return Array.from(
      new Set([activeNodeId, ...selectedTrackIds].filter(Boolean) as string[]),
    );
  }, [trackMode, activeNodeId, selectedTrackIds]);

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
          <ChatPanel
            chat={chat}
            fileLinks={fileLinks}
            trackMode={trackMode}
            referenceNodeIds={referenceNodeIds}
            onToggleTrackMode={toggleTrackMode}
            onClearTracks={clearTracks}
          />
        </div>
        <div className="min-h-0 border-l border-accent-border/30">
          <SessionGraph
            nodes={nodes}
            rootNodeId={rootNodeId}
            activeNodeId={activeNodeId}
            onNodeClick={handleNodeClick}
            onConnectNodes={handleConnectNodes}
            onRemoveConnection={handleRemoveConnection}
            fileLinks={fileLinks}
            fileNodes={fileNodes}
            fileLinkMode={!!linkFileId}
            onLinkTarget={handleLinkTarget}
            onRemoveFileLink={handleRemoveFileLink}
            onFilePosition={handleFilePosition}
            onDropUpload={handleDropUpload}
            onPersistPositions={handlePersistPositions}
            trackMode={trackMode}
            selectedTrackIds={selectedTrackIds}
            onToggleTrack={toggleTrack}
            onEnterTrack={enterTrack}
          />
        </div>
      </div>
    </div>
  );
}
