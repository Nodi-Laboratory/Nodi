"use client";

import ReactMarkdown from "react-markdown";
import { useSessionDetail } from "@/lib/queries";
import { ancestorChain, buildById } from "@/lib/tree";
import type { NodeRow } from "@/lib/types";

/**
 * 학생 세션 읽기 전용 보기(교사용). 현재 head 기준 조상체인을 (질문+답변)으로 렌더.
 * 교사는 수정/전송 불가.
 */
export function ReadOnlyThread({ sessionId }: { sessionId: string }) {
  const { data: detail, isLoading } = useSessionDetail(sessionId);

  if (isLoading) {
    return <p className="p-4 text-sm text-fg-muted">대화 불러오는 중…</p>;
  }
  if (!detail) {
    return <p className="p-4 text-sm text-danger">대화를 불러오지 못했습니다.</p>;
  }

  const byId = buildById(detail.nodes);
  let thread = ancestorChain(detail.session.current_head_id ?? null, byId);
  if (thread.length === 0) {
    thread = [...detail.nodes].sort((a, b) =>
      (a.created_at ?? "").localeCompare(b.created_at ?? ""),
    );
  }

  if (thread.length === 0) {
    return <p className="p-4 text-sm text-fg-muted">대화 내용이 없습니다.</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="rounded-md bg-accent/20 px-3 py-1.5 text-xs text-accent-fg">
        읽기 전용 — 학생 대화를 열람만 합니다.
      </div>
      {thread.map((n) => (
        <Exchange key={n.id} node={n} />
      ))}
    </div>
  );
}

function Exchange({ node }: { node: NodeRow }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2 text-sm text-accent-fg">
          {node.question}
        </div>
      </div>
      <div className="flex justify-start">
        <div className="markdown-body max-w-[85%] rounded-2xl rounded-tl-sm border border-accent-border/30 bg-bg-elevated px-4 py-2 text-sm text-fg">
          {node.answer ? (
            <ReactMarkdown>{node.answer}</ReactMarkdown>
          ) : (
            <span className="text-fg-muted">…</span>
          )}
        </div>
      </div>
      {node.tags && node.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 pl-1">
          {node.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-accent-border/50 bg-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent-fg"
            >
              #{t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
