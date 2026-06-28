"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addConnection,
  addFileLink,
  createSession,
  deleteFile,
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
  sessionsKey,
  useFiles,
  useFileTagsMap,
  useSessionDetail,
  useSessionFileLinks,
} from "@/lib/queries";
import { useWorkspaceChat } from "@/lib/useWorkspaceChat";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { FileLink, SessionDetail } from "@/lib/types";
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

  // 그래프 파일 노드 툴팁용 태그 맵(indexed 파일만)
  const indexedFileIds = useMemo(
    () => fileNodes.filter((f) => f.status === "indexed").map((f) => f.id),
    [fileNodes],
  );
  const fileTags = useFileTagsMap(indexedFileIds);

  const { data: fileLinks = [] } = useSessionFileLinks(activeSessionId);
  const [linkFileId, setLinkFileId] = useState<string | null>(null);
  // D31: 자료 연결 실패 시 짧게 뜨는 토스트(롤백 안내).
  const [linkToast, setLinkToast] = useState<string | null>(null);

  const refreshFiles = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: filesKey(target) });
  }, [queryClient, target]);
  const refreshFileLinks = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: fileLinksKey(activeSessionId),
    });
  }, [queryClient, activeSessionId]);

  // ── D31: 자료 연결선 낙관적 렌더 ──────────────────────────────────
  // 확정 즉시 provisional FileLink를 캐시에 삽입 → 캔버스가 흐린 선을 바로 그림.
  // 성공 시 invalidate로 실데이터(선명한 선)로 교체, 실패 시 provisional 제거(롤백).
  const insertProvisionalLink = useCallback(
    (fileId: string, nodeId: string): boolean => {
      const key = fileLinksKey(activeSessionId);
      const current = queryClient.getQueryData<FileLink[]>(key) ?? [];
      // 중복 가드: 같은 file→node 링크(실데이터·pending)가 이미 있으면 재삽입 안 함.
      if (
        current.some(
          (l) => l.file_id === fileId && l.target_node_id === nodeId,
        )
      ) {
        return false;
      }
      const f = spaceFiles.find((sf) => sf.id === fileId);
      const provisional: FileLink = {
        id: `pending:${fileId}->${nodeId}`,
        file_id: fileId,
        target_node_id: nodeId,
        created_at: new Date().toISOString(),
        files: f
          ? {
              id: f.id,
              storage_path: f.storage_path ?? null,
              mime: f.mime ?? null,
              status: f.status,
              chunk_total: f.chunk_total ?? null,
              chunk_done: f.chunk_done ?? null,
              session_id: f.session_id ?? null,
              position_x: f.position_x ?? null,
              position_y: f.position_y ?? null,
            }
          : null,
        _pending: true,
      };
      queryClient.setQueryData<FileLink[]>(key, [provisional, ...current]);
      return true;
    },
    [queryClient, activeSessionId, spaceFiles],
  );

  const rollbackProvisionalLink = useCallback(
    (fileId: string, nodeId: string) => {
      const key = fileLinksKey(activeSessionId);
      queryClient.setQueryData<FileLink[]>(key, (old) =>
        (old ?? []).filter(
          (l) =>
            !(
              l._pending &&
              l.file_id === fileId &&
              l.target_node_id === nodeId
            ),
        ),
      );
    },
    [queryClient, activeSessionId],
  );

  // 자료 연결 공통: 낙관적 삽입 → 서버 확정 → (성공)실데이터 교체 / (실패)롤백.
  const linkFileOptimistic = useCallback(
    async (fileId: string, nodeId: string) => {
      const inserted = insertProvisionalLink(fileId, nodeId);
      try {
        await addFileLink(fileId, nodeId);
        refreshFileLinks();
      } catch {
        if (inserted) rollbackProvisionalLink(fileId, nodeId);
        setLinkToast("자료 연결에 실패했습니다.");
      }
    },
    [insertProvisionalLink, rollbackProvisionalLink, refreshFileLinks],
  );

  // 자료 패널 버튼 경로(파일 선택 → 분기 노드 클릭).
  const handleLinkTarget = useCallback(
    async (nodeId: string) => {
      if (!linkFileId) return;
      const fileId = linkFileId;
      setLinkFileId(null);
      await linkFileOptimistic(fileId, nodeId);
    },
    [linkFileId, linkFileOptimistic],
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

  // 채팅 제안 / 파일 노드 우클릭 추적선에서 현재 노드에 연결(낙관적).
  const handleLinkFile = useCallback(
    (fileId: string, nodeId: string) => {
      void linkFileOptimistic(fileId, nodeId);
    },
    [linkFileOptimistic],
  );

  // 링크 실패 토스트 자동 소멸
  useEffect(() => {
    if (!linkToast) return;
    const t = setTimeout(() => setLinkToast(null), 2600);
    return () => clearTimeout(t);
  }, [linkToast]);

  // 자료 패널 삭제/재시도 후: 파일 목록 + 링크 갱신(그래프 반영)
  const handleFilesChanged = useCallback(() => {
    refreshFiles();
    refreshFileLinks();
  }, [refreshFiles, refreshFileLinks]);

  const handleFilePosition = useCallback(
    (fileId: string, x: number, y: number) => {
      void patchFilePosition(fileId, x, y).catch(() => {});
    },
    [],
  );

  // 활성 세션 보장(빈 워크스페이스면 먼저 생성, D22)
  const ensureSession = useCallback(async (): Promise<string> => {
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current) return current;
    const session = await createSession(target);
    await queryClient.invalidateQueries({ queryKey: sessionsKey(target) });
    setActiveSession(session.id);
    return session.id;
  }, [target, queryClient, setActiveSession]);

  // 자료 패널 업로드: 현재 세션 + 노드로 표시(좌표 미지정 → 그래프가 head 근처 배치)
  const handlePanelUpload = useCallback(
    async (file: File) => {
      const sid = await ensureSession();
      await uploadFile(target, file, { sessionId: sid });
      refreshFiles();
    },
    [ensureSession, target, refreshFiles],
  );

  // OS 드래그&드롭 업로드: 세션 보장 + 드롭 좌표
  const handleDropUpload = useCallback(
    async (files: File[], x: number, y: number) => {
      let sid: string;
      try {
        sid = await ensureSession();
      } catch {
        return;
      }
      for (const file of files) {
        try {
          await uploadFile(target, file, {
            sessionId: sid,
            positionX: x,
            positionY: y,
          });
        } catch {
          /* 503 등은 자료 패널 업로드에서 안내 */
        }
      }
      refreshFiles();
    },
    [ensureSession, target, refreshFiles],
  );

  // 파일 노드 삭제(D22)
  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      if (!window.confirm("이 자료를 삭제할까요?")) return;
      try {
        await deleteFile(fileId);
        refreshFiles();
        refreshFileLinks();
      } catch {
        /* 무시 */
      }
    },
    [refreshFiles, refreshFileLinks],
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
    <div className="relative flex h-full w-full flex-col">
      {linkToast && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-danger/50 bg-bg px-3 py-1.5 text-xs text-danger shadow-lg"
        >
          {linkToast}
        </div>
      )}
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
            onRefresh={handleFilesChanged}
            onUpload={handlePanelUpload}
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
            onLinkFile={handleLinkFile}
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
            fileTags={fileTags}
            fileLinkMode={!!linkFileId}
            onLinkTarget={handleLinkTarget}
            onRemoveFileLink={handleRemoveFileLink}
            onConnectFileToNode={handleLinkFile}
            onDeleteFile={handleDeleteFile}
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
