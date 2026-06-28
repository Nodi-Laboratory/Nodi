"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, GitFork, Paperclip } from "lucide-react";
import { useSessionDetail } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { ancestorChain, buildById, pathIdSet } from "@/lib/tree";
import type { WorkspaceChat } from "@/lib/useWorkspaceChat";
import type { FileLink, NodeRow } from "@/lib/types";

/**
 * 대화 패널(중): 포커스 노드 기준 조상체인 스레드 표시 + 입력.
 * 실제 SSE 전송/스트리밍 상태는 공유 컨트롤러(chat)에서 관리한다
 * (그래프의 네비게이터 활성화와 동일 인스턴스를 공유).
 * 현재 분기가 자료에 연결돼 있으면 RAG 배너로 가시화(시각적 RAG).
 */
export function ChatPanel({
  chat,
  fileLinks,
}: {
  chat: WorkspaceChat;
  fileLinks: FileLink[];
}) {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeNodeId = useWorkspaceStore((s) => s.activeNodeId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  const { data: detail, isLoading } = useSessionDetail(activeSessionId);

  const [input, setInput] = useState("");
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
  const branching = nodes.some(
    (n) => n.parent_id === activeNodeId && !n.is_navigator,
  );

  // 현재 분기(루트→포커스 노드 경로)에 연결된 자료 개수 (자손 분기에도 적용되므로 조상 포함)
  const branchPath = pathIdSet(activeNodeId, byId);
  const linkedFileCount = new Set(
    fileLinks
      .filter((l) => branchPath.has(l.target_node_id))
      .map((l) => l.file_id),
  ).size;

  // 새 메시지/스트리밍 시 하단으로 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length, chat.streamAnswer, chat.streaming]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || chat.streaming) return;
    setInput("");
    const { ok } = await chat.send(q, activeNodeId);
    if (!ok) setInput(q); // 실패 시 원문 복원
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
        ) : thread.length === 0 && !chat.streaming ? (
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

            {chat.streaming && (
              <div className="flex flex-col gap-2">
                <UserBubble text={chat.draftQ} />
                <AnswerBubble>
                  {chat.streamAnswer ? (
                    <ReactMarkdown>{chat.streamAnswer}</ReactMarkdown>
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
        {linkedFileCount > 0 && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-[#2a7d7a]">
            <Paperclip size={13} />연결된 자료 {linkedFileCount}개 — 이 분기의
            답변에 참고됩니다.
          </div>
        )}
        {branching && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-warning">
            <GitFork size={13} />이 노드에서 새 분기를 만듭니다.
          </div>
        )}
        {chat.error && (
          <div className="mx-auto mb-2 max-w-2xl text-xs text-danger">
            {chat.error}
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
            disabled={chat.streaming}
            className="max-h-40 flex-1 resize-none rounded-xl border border-accent-border/50 bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={chat.streaming || !input.trim()}
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

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-start gap-1 pl-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full border border-accent-border/50 bg-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent-fg"
        >
          #{t}
        </span>
      ))}
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
      {node.tags && node.tags.length > 0 ? <TagChips tags={node.tags} /> : null}
    </div>
  );
}
