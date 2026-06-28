"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteNode, streamChat, type SpaceTarget } from "@/lib/api";
import { sessionKey, sessionsKey } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type { ChatNavigatorEvent, NodeRow, SessionDetail } from "@/lib/types";

/**
 * 워크스페이스 채팅 컨트롤러. WorkspaceInner에서 1개 인스턴스를 만들어
 * ChatPanel(입력/스트리밍 표시)과 그래프(네비게이터 활성화)가 공유한다.
 *
 * - send: 질문을 /chat/stream으로 전송, 토큰 누적, done 시 노드 점진 반영(+태그),
 *   navigator 이벤트 수신 시 네비게이터 노드를 캐시에 추가.
 * - activateNavigator: 네비게이터 노드의 질문으로 실제 노드를 생성(일반 흐름 재사용)한 뒤
 *   그 네비게이터 노드를 삭제(DELETE /nodes/{id})하고 캐시에서도 제거.
 */
export interface WorkspaceChat {
  streaming: boolean;
  draftQ: string;
  streamAnswer: string;
  error: string | null;
  busyNavId: string | null;
  send: (
    question: string,
    parentNodeId: string | null,
    opts?: { referenceNodeIds?: string[] },
  ) => Promise<{ ok: boolean }>;
  activateNavigator: (node: NodeRow) => Promise<void>;
}

export function useWorkspaceChat(target: SpaceTarget): WorkspaceChat {
  const queryClient = useQueryClient();
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  const [streaming, setStreaming] = useState(false);
  const [draftQ, setDraftQ] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyNavId, setBusyNavId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const appendNavigators = useCallback(
    (sessionId: string, data: ChatNavigatorEvent) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(sessionId), (old) => {
        if (!old) return old;
        const existing = new Set(old.nodes.map((n) => n.id));
        const toAdd: NodeRow[] = data.nodes
          .filter((n) => !existing.has(n.id))
          .map((n) => ({
            id: n.id,
            session_id: sessionId,
            parent_id: n.parent_id,
            question: "",
            answer: "",
            label: n.navigator_question,
            is_navigator: true,
            navigator_question: n.navigator_question,
            position_x: null,
            position_y: null,
            created_at: new Date().toISOString(),
            tags: null,
          }));
        return toAdd.length ? { ...old, nodes: [...old.nodes, ...toAdd] } : old;
      });
    },
    [queryClient],
  );

  const removeNode = useCallback(
    (sessionId: string, nodeId: string) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(sessionId), (old) =>
        old ? { ...old, nodes: old.nodes.filter((n) => n.id !== nodeId) } : old,
      );
    },
    [queryClient],
  );

  const send = useCallback(
    async (
      question: string,
      parentNodeId: string | null,
      opts?: { referenceNodeIds?: string[] },
    ): Promise<{ ok: boolean }> => {
      const q = question.trim();
      if (!q || !activeSessionId || streaming) return { ok: false };

      setError(null);
      setDraftQ(q);
      setStreamAnswer("");
      setStreaming(true);

      const sessionId = activeSessionId;
      const parent = parentNodeId;
      const controller = new AbortController();
      abortRef.current = controller;
      let acc = "";
      let okFlag = false;

      const refIds = opts?.referenceNodeIds?.length
        ? opts.referenceNodeIds
        : undefined;

      await streamChat(
        {
          session_id: sessionId,
          question: q,
          parent_node_id: parent ?? undefined,
          reference_node_ids: refIds,
        },
        {
          onToken: (delta) => {
            acc += delta;
            setStreamAnswer(acc);
          },
          onNavigator: (data) => appendNavigators(sessionId, data),
          onDone: (data) => {
            const newNode: NodeRow = {
              id: data.node.id,
              session_id: sessionId,
              parent_id: data.node.parent_id ?? parent ?? null,
              question: q,
              answer: acc,
              label: data.node.label,
              is_navigator: false,
              navigator_question: null,
              position_x: null,
              position_y: null,
              created_at: new Date().toISOString(),
              tags: data.node.tags ?? null,
            };

            queryClient.setQueryData<SessionDetail>(
              sessionKey(sessionId),
              (old) => {
                if (!old) return old;
                const exists = old.nodes.some((n) => n.id === newNode.id);
                return {
                  session: {
                    ...old.session,
                    current_head_id: data.current_head_id ?? newNode.id,
                    root_node_id:
                      old.session.root_node_id ??
                      data.root_node_id ??
                      newNode.id,
                  },
                  nodes: exists ? old.nodes : [...old.nodes, newNode],
                };
              },
            );

            setActiveNode(data.node.id);
            setStreaming(false);
            setDraftQ("");
            setStreamAnswer("");
            okFlag = true;
            void queryClient.invalidateQueries({
              queryKey: sessionsKey(target),
            });
          },
          onError: (detail) => {
            setError(detail);
            setDraftQ("");
            setStreamAnswer("");
            setStreaming(false);
          },
        },
        controller.signal,
      );

      return { ok: okFlag };
    },
    [activeSessionId, streaming, queryClient, target, setActiveNode, appendNavigators],
  );

  const activateNavigator = useCallback(
    async (node: NodeRow) => {
      if (streaming || busyNavId) return;
      setBusyNavId(node.id);
      try {
        const { ok } = await send(
          node.navigator_question ?? node.question,
          node.parent_id,
        );
        if (ok) {
          try {
            await deleteNode(node.id);
          } catch {
            /* 삭제 실패는 무시 — 캐시 정리는 진행 */
          }
          removeNode(node.session_id, node.id);
        }
      } finally {
        setBusyNavId(null);
      }
    },
    [streaming, busyNavId, send, removeNode],
  );

  return { streaming, draftQ, streamAnswer, error, busyNavId, send, activateNavigator };
}
