"use client";

/**
 * 최근 대화 팝업 (UI 개편 2026-08-11, 참조 시안 p05).
 *
 * 세션 화면 **하단에 늘 펼쳐져 있던 목록**을 여기로 옮겼다. 그 목록은 "어디로
 * 갈까"(세션 카드)와 "하던 것 잇기"라는 다른 일을 한 화면에 나란히 두고 있어서,
 * 카드를 고르러 온 사람에게도 늘 자리를 차지했다. 이제 우상단 버튼을 눌렀을
 * 때만 뜬다.
 *
 * ⚠️ **팝업은 새로 만들지 않았다.** 앱 공통 `Dialog`가 ESC·바깥 클릭·dim·
 * "팝업이 키의 주인"(`lib/ui/modalLayer.ts`)을 이미 갖고 있다 — 여기서 다시
 * 만들면 그 규칙이 이 팝업에서만 어긋난다.
 */

import { useMemo, useState } from "react";
import { Loader2, MessageSquare, RotateCw, Search } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { pastelForTag } from "@/lib/ui/pastel";
import type { RoomRow } from "@/lib/api/rooms";

/** 필터 칩. `all`은 언제나 첫 칸이다. */
type Filter = "all" | "personal" | "class";

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "personal", label: "개인 세션" },
  { key: "class", label: "학급" },
];

/** "5분 전"처럼. 절대 시각은 이 화면에서 쓸 일이 없다. */
function 지난때(iso: string | null | undefined): string {
  if (!iso) return "";
  const 초 = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (초 < 60) return "방금";
  if (초 < 3600) return `${Math.floor(초 / 60)}분 전`;
  if (초 < 86400) return `${Math.floor(초 / 3600)}시간 전`;
  if (초 < 86400 * 30) return `${Math.floor(초 / 86400)}일 전`;
  return `${Math.floor(초 / (86400 * 30))}달 전`;
}

export function RecentChatsDialog({
  open,
  onClose,
  rooms,
  loading,
  error,
  onRetry,
  onOpenRoom,
  onSeeAll,
}: {
  open: boolean;
  onClose: () => void;
  rooms: readonly RoomRow[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onOpenRoom: (r: RoomRow) => void;
  onSeeAll: () => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const 목록 = useMemo(() => {
    const 글 = q.trim().toLowerCase();
    return rooms
      .filter((r) => (filter === "all" ? true : r.space_kind === filter))
      .filter((r) => !글 || (r.title ?? "").toLowerCase().includes(글))
      .slice();
  }, [rooms, q, filter]);

  /** 빈 상태는 **이유마다 다른 말**이어야 한다 — 둘을 하나로 쓰면 오해한다. */
  const 빈말 =
    rooms.length === 0 ? "최근 대화가 아직 없어요." : "검색 결과가 없어요.";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="최근 대화"
      header={<span className="text-[17px] font-bold text-fg">최근 대화</span>}
      width="max-w-lg"
    >
      <div className="flex min-h-0 flex-col gap-3">
        {/* 찾기 */}
        <label
          className="flex items-center gap-2 rounded-xl px-3 py-2.5"
          style={{ background: "var(--surface)" }}
        >
          <Search size={16} style={{ color: "var(--fg-muted)" }} aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="대화 검색"
            aria-label="대화 검색"
            className="w-full bg-transparent text-[14px] outline-none"
          />
        </label>

        {/* 필터 칩 — **선택된 것만** 연한 라임이다(요구사항 §7). */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="대화 거르기">
          {FILTERS.map((f) => {
            const on = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(f.key)}
                className="rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors"
                style={
                  on
                    ? { background: "var(--accent-soft)", color: "var(--accent-deep)" }
                    : {
                        background: "var(--surface)",
                        color: "var(--fg-muted)",
                      }
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {/**
         * 목록 — **팝업이 늘어나지 않고 여기서 구른다**(요구사항 4-3).
         * 팝업 자체가 길어지면 작은 화면에서 위아래가 잘린다.
         */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[14px] text-fg-muted">
              <Loader2 size={15} className="animate-spin" aria-hidden />
              불러오는 중…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-[14px] text-fg-muted">대화를 불러오지 못했어요.</p>
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium"
                style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
              >
                <RotateCw size={13} aria-hidden />
                다시 시도
              </button>
            </div>
          ) : 목록.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-fg-muted">{빈말}</p>
          ) : (
            <ul className="flex flex-col">
              {목록.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpenRoom(r)}
                    data-recent-row
                    className="flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-accent-soft/40"
                  >
                    <span
                      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
                      aria-hidden
                    >
                      <MessageSquare size={16} />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-[14px] font-semibold text-fg">
                        {r.title?.trim() || "제목 없는 대화"}
                      </span>
                      <span className="truncate text-[12px] text-fg-muted">
                        {r.space_name ?? (r.space_kind === "personal" ? "개인 세션" : "학급")}
                      </span>
                      {/**
                       * 태그 칩은 **지도와 같은 색표**를 쓴다(`lib/ui/pastel.ts`).
                       * 색이 갈리면 "지도에서 본 그 무리"와 이 줄을 눈으로 이을
                       * 수 없다 — 요구사항의 "카테고리 색을 줄여라"는 UI 크롬의
                       * 초록 테두리를 가리키지 이 칩이 아니다.
                       */}
                      {r.concepts && r.concepts.length > 0 && (
                        <span className="flex flex-wrap gap-1.5">
                          {r.concepts.slice(0, 2).map((c) => (
                            <span
                              key={c}
                              className="truncate rounded-full px-2 py-0.5 text-[11px] text-fg"
                              style={{ background: pastelForTag(c) }}
                            >
                              {c}
                            </span>
                          ))}
                          {r.concepts.length > 2 && (
                            <span className="text-[11px] text-fg-muted">
                              +{r.concepts.length - 2}
                            </span>
                          )}
                        </span>
                      )}
                    </span>

                    <span className="shrink-0 pt-0.5 text-[12px] text-fg-muted">
                      {지난때(r.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={onSeeAll}
          className="relative pt-4 text-center text-[13px] font-medium text-fg-muted transition-colors before:absolute before:inset-x-1 before:top-0 before:h-px before:bg-[var(--line)] before:content-[''] hover:text-fg"
        >
          전체 대화 보기 ›
        </button>
      </div>
    </Dialog>
  );
}
