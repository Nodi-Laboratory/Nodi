"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import { Send, GitFork } from "lucide-react";
import { streamChat, type SpaceTarget } from "@/lib/api";
import { sessionKey, sessionsKey, useSessionDetail } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { ancestorChain, buildById } from "@/lib/tree";
import type { NodeRow, SessionDetail } from "@/lib/types";

/**
 * 대화 패널(중): 선택 세션의 현재 포커스 노드 기준 조상체인 스레드 표시 +
 * /chat/stream SSE 호출(토큰 실시간 누적). done 시 그래프/스레드에 노드 점진 반영.
 * 과거 노드를 클릭하면 그 지점에서 분기(parent_node_id = 포커스 노드).
 */
export function ChatPanel({ target }: { target: SpaceTarget }) {
  const queryClient = useQueryClient();
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeNodeId = useWorkspaceStore((s) => s.activeNodeId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  const { data: detail, isLoading } = useSessionDetail(activeSessionId);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [draftQ, setDraftQ] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 세션이 바뀌면 포커스 노드를 그 세션의 현재 head로 초기화
  const sessionId = detail?.session?.id;
  useEffect(() => {
    if (detail?.session) {
      setActiveNode(detail.session.current_head_id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const nodes: NodeRow[] = detail?.nodes ?? [];
  const byId = buildById(nodes);
  const thread = ancestorChain(activeNodeId, byId);
  const branching = nodes.some((n) => n.parent_id === activeNodeId);

  // 새 메시지/스트리밍 시 하단으로 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length, streamAnswer, streaming]);

  // 언마운트 시 스트림 중단
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || !activeSessionId || streaming) return;

    setError(null);
    setInput("");
    setDraftQ(q);
    setStreamAnswer("");
    setStreaming(true);

    const parent = activeNodeId;
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";

    await streamChat(
      {
        session_id: activeSessionId,
        question: q,
        parent_node_id: parent ?? undefined,
      },
      {
        onToken: (delta) => {
          acc += delta;
          setStreamAnswer(acc);
        },
        onDone: (data) => {
          const newNode: NodeRow = {
            id: data.node.id,
            session_id: activeSessionId,
            parent_id: data.node.parent_id ?? parent ?? null,
            question: q,
            answer: acc,
            label: data.node.label,
            is_navigator: false,
            navigator_question: null,
            position_x: null,
            position_y: null,
            created_at: new Date().toISOString(),
          };

          queryClient.setQueryData<SessionDetail>(
            sessionKey(activeSessionId),
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
          void queryClient.invalidateQueries({
            queryKey: sessionsKey(target),
          });
        },
        onError: (detail) => {
          // 질문 유실 방지: 사용자가 입력했던 원문을 입력창에 복원해 바로 재전송 가능하게
          setInput(q);
          setDraftQ("");
          setStreamAnswer("");
          setError(detail);
          setStreaming(false);
        },
      },
      controller.signal,
    );
  };

  if (!activeSessionId) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-fg-muted">
          왼쪽에서 대화를 선택하거나 &quot;새 대화&quot;로 시작하세요.
        </p>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* 스레드 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
          <p className="text-sm text-fg-muted">불러오는 중…</p>
        ) : thread.length === 0 && !streaming ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-fg-muted">
            첫 질문을 입력해 대화를 시작하세요.
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {thread.map((n) => (
              <ExchangeBubble
                key={n.id}
                node={n}
                active={n.id === activeNodeId}
                onFocus={() => setActiveNode(n.id)}
              />
            ))}

            {streaming && (
              <div className="flex flex-col gap-2">
                <UserBubble text={draftQ} />
                <AnswerBubble>
                  {streamAnswer ? (
                    <ReactMarkdown>{streamAnswer}</ReactMarkdown>
                  ) : (
                    <span className="text-fg-muted">생각하는 중…</span>
                  )}
                </AnswerBubble>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* 입력 */}
      <div className="border-t border-accent-border/30 px-6 py-4">
        {branching && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-warning">
            <GitFork size={13} />이 노드에서 새 분기를 만듭니다.
          </div>
        )}
        {error && (
          <div className="mx-auto mb-2 max-w-2xl text-xs text-danger">
            {error}
          </div>
        )}
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder="질문을 입력하세요 (Enter 전송, Shift+Enter 줄바꿈)"
            disabled={streaming}
            className="max-h-40 flex-1 resize-none rounded-xl border border-accent-border/50 bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={streaming || !input.trim()}
            className="flex items-center gap-1 rounded-xl bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            <Send size={15} />
            전송
          </button>
        </div>
      </div>
    </section>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2 text-sm text-accent-fg">
        {text}
      </div>
    </div>
  );
}

function AnswerBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="markdown-body max-w-[85%] rounded-2xl rounded-tl-sm border border-accent-border/30 bg-bg-elevated px-4 py-2 text-sm text-fg">
        {children}
      </div>
    </div>
  );
}

function ExchangeBubble({
  node,
  active,
  onFocus,
}: {
  node: NodeRow;
  active: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl p-2 transition-colors ${
        active ? "bg-accent/15" : ""
      }`}
      onClick={onFocus}
    >
      <UserBubble text={node.question} />
      <AnswerBubble>
        {node.answer ? (
          <ReactMarkdown>{node.answer}</ReactMarkdown>
        ) : node.is_navigator && node.navigator_question ? (
          <span className="text-fg-muted">
            제안된 질문: {node.navigator_question}
          </span>
        ) : (
          <span className="text-fg-muted">…</span>
        )}
      </AnswerBubble>
    </div>
  );
}
