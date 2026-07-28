"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  MessagesSquare,
  Search,
  User,
} from "lucide-react";
import {
  getAdminConversation,
  getAdminConversations,
  listAdminUsers,
} from "@/lib/api";
import type {
  AdminConversation,
  AdminConversationDetail,
  AdminConversationNode,
  AdminConversationsResponse,
  AdminLog,
  AdminUser,
} from "@/lib/types";
import { Badge, Collapse, Empty, Failed, Loading, ms, n, when } from "./ui";
import { TurnTrace } from "./TurnTrace";

const LIMIT = 25;

/**
 * 대화 탭 (D113) — 모든 사용자의 대화를 **읽기 좋게**.
 *
 * 참고한 프로젝트의 로그 화면은 대화가 파일 단위로 흩어져 있어 읽기 어려웠다
 * (사용자 지적). 여기서는 한 줄이 곧 한 대화이고, 열면 실제 말풍선 순서대로
 * 질문·답변이 이어진다. 각 턴 아래에 그 턴이 어떻게 만들어졌는지(스킬·토큰·
 * 프롬프트)를 접어 둔다 — 읽는 흐름을 끊지 않으면서 원인 추적이 가능하도록.
 */
export function ConversationsTab() {
  const [ownerId, setOwnerId] = useState("");
  const [space, setSpace] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: users } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });

  const { data, isLoading, isError } = useQuery<AdminConversationsResponse>({
    queryKey: ["admin", "conversations", ownerId, space, query, offset],
    queryFn: () =>
      getAdminConversations({
        ownerId: ownerId || null,
        spaceKind: space || null,
        search: query || null,
        limit: LIMIT,
        offset,
      }),
  });

  if (openId) {
    return <ConversationDetail sessionId={openId} onBack={() => setOpenId(null)} />;
  }

  const rows = data?.conversations ?? [];
  const reset = () => setOffset(0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">대화 기록</h2>
        {data && <Badge tone="gold">{n(data.total)}개 대화</Badge>}

        <select
          value={ownerId}
          onChange={(e) => {
            setOwnerId(e.target.value);
            reset();
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 사용자</option>
          {(users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.email || u.id}
            </option>
          ))}
        </select>

        <select
          value={space}
          onChange={(e) => {
            setSpace(e.target.value);
            reset();
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 공간</option>
          <option value="class">학급</option>
          <option value="personal">개인</option>
        </select>

        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(search.trim());
            reset();
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="제목·이메일·질문·답변 검색"
            className="w-56 rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8] placeholder:text-[#6f6a62]"
          />
          <button
            type="submit"
            className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-sm text-[#cfc9bd] hover:text-[#e7e3d8]"
          >
            <Search size={13} />
            찾기
          </button>
        </form>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <Failed />
      ) : rows.length === 0 ? (
        <Empty>조건에 맞는 대화가 없습니다.</Empty>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((c) => (
            <ConversationRow key={c.session_id} c={c} onOpen={() => setOpenId(c.session_id)} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
          disabled={offset === 0}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          이전
        </button>
        <span className="text-xs text-[#9a948a]">
          {rows.length === 0 ? 0 : offset + 1}–{offset + rows.length} / {n(data?.total ?? 0)}
        </span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + LIMIT)}
          disabled={offset + rows.length >= (data?.total ?? 0)}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          다음
        </button>
      </div>
    </div>
  );
}

function ConversationRow({
  c,
  onOpen,
}: {
  c: AdminConversation;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-[#25211a] px-3 py-2 text-left transition-colors hover:border-white/25"
    >
      <MessagesSquare size={14} className="shrink-0 text-[#e0a32e]" />
      <span className="min-w-0 flex-1 truncate text-sm text-[#e7e3d8]">
        {c.title || "(제목 없음)"}
      </span>
      <Badge tone={c.space_kind === "class" ? "info" : "default"}>
        {c.space_kind === "class" ? c.class_name || "학급" : "개인"}
      </Badge>
      <span className="shrink-0 text-xs text-[#9a948a]">{c.owner_email || c.owner_id}</span>
      <Badge>{n(c.node_count)}턴</Badge>
      {c.token_total > 0 && <Badge tone="gold">{n(c.token_total)} tok</Badge>}
      {c.error_turns > 0 && (
        <Badge tone="bad">
          <AlertTriangle size={10} />
          오류 {n(c.error_turns)}
        </Badge>
      )}
      <span className="shrink-0 text-xs text-[#9a948a]">{when(c.last_activity)}</span>
    </button>
  );
}

// ── 상세: 대화 전문 + 턴별 과정 ──────────────────────────────────────
function ConversationDetail({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const { data, isLoading, isError } = useQuery<AdminConversationDetail>({
    queryKey: ["admin", "conversation", sessionId],
    queryFn: () => getAdminConversation(sessionId),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-sm text-[#cfc9bd] hover:text-[#e7e3d8]"
        >
          <ArrowLeft size={14} />
          목록
        </button>
        <h2 className="text-sm font-semibold text-[#e7e3d8]">
          {data?.session.title || "(제목 없음)"}
        </h2>
        {data?.owner && (
          <Badge tone="info">
            <User size={10} />
            {data.owner.email} · {data.owner.role}
          </Badge>
        )}
        {data && (
          <Badge>{data.session.space_kind === "class" ? "학급" : "개인"}</Badge>
        )}
        <code className="text-[10px] text-[#9a948a]">{sessionId}</code>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <Failed />
      ) : data.nodes.length === 0 ? (
        <Empty>이 대화에는 아직 오간 말이 없습니다.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {data.nodes.map((node, i) => (
            <TurnBlock
              key={node.id}
              index={i + 1}
              node={node}
              log={findLog(data.logs, node)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 노드에 대응하는 턴 로그를 찾는다.
 *
 * node_id로 잇는 게 정확하지만, 저장이 실패한 턴은 node_id가 비어 있다. 그럴
 * 때는 질문 문자열로 되짚는다 — 못 찾으면 `null`이고 화면은 대화만 보여 준다
 * (틀린 로그를 붙이느니 없는 편이 낫다).
 */
function findLog(logs: AdminLog[], node: AdminConversationNode): AdminLog | null {
  return (
    logs.find((l) => l.node_id === node.id) ??
    logs.find((l) => !l.node_id && l.question === node.question) ??
    null
  );
}

function TurnBlock({
  index,
  node,
  log,
}: {
  index: number;
  node: AdminConversationNode;
  log: AdminLog | null;
}) {
  const [showTrace, setShowTrace] = useState(false);
  const real = log?.tokens?.total ?? null;
  return (
    <div className="rounded-lg border border-white/10 bg-[#221e17]">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <Badge tone="gold">턴 {index}</Badge>
        <span className="text-[11px] text-[#9a948a]">{when(node.created_at)}</span>
        {log?.route && <Badge tone="info">{log.route}</Badge>}
        {log?.duration_ms != null && <Badge>{ms(log.duration_ms)}</Badge>}
        {real != null && <Badge tone="gold">{n(real)} tok</Badge>}
        {(log?.skill_calls?.length ?? 0) > 0 && (
          <Badge tone="ok">스킬 {log!.skill_calls!.length}</Badge>
        )}
        {(log?.errors?.length ?? 0) > 0 && <Badge tone="bad">오류</Badge>}
        {log && (
          <button
            type="button"
            onClick={() => setShowTrace((v) => !v)}
            className="ml-auto text-[11px] text-[#9a948a] underline-offset-2 hover:text-[#e7e3d8] hover:underline"
          >
            {showTrace ? "과정 접기" : "이 답이 나온 과정"}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        {/* 학생 말풍선 */}
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-[#e0a32e]/15 px-3 py-2 text-sm text-[#f0e8d2]">
            {node.question || "(질문 없음)"}
          </div>
        </div>
        {/* 노디 답변 — 개념 카드 원문 그대로. 파싱해서 보여 주면 실제로 무엇이
            나왔는지(형식 위반 포함)를 볼 수 없다. */}
        <div className="flex justify-start">
          <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-[#25211a] px-3 py-2">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[#cfc9bd]">
              {node.answer || "(답변 없음)"}
            </pre>
          </div>
        </div>

        {(node.rag_sources?.length ?? 0) > 0 && (
          <Collapse label="이 답에 붙은 출처" count={node.rag_sources!.length}>
            <div className="flex flex-col gap-1">
              {node.rag_sources!.map((s, i) => (
                <div key={i} className="text-[11px] text-[#9a948a]">
                  <span className="text-[#cfc9bd]">{s.name || "자료"}</span>
                  {s.seq != null && <> · #{s.seq}</>}
                  {s.distance != null && <> · dist {s.distance.toFixed(3)}</>}
                </div>
              ))}
            </div>
          </Collapse>
        )}
      </div>

      {showTrace && log && (
        <div className="border-t border-white/10 px-3 py-3">
          <TurnTrace log={log} />
        </div>
      )}
    </div>
  );
}
