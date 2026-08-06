"use client";

/**
 * 지도 옆 대화 목록 (D191) — 폴더로 접었다 펴고, 체크로 켰다 끈다.
 *
 * 컴퓨터의 폴더 목록과 같은 물건이다(사용자 지시 2026-08-06). 공간 하나가
 * 폴더 하나고, 그 안이 대화다. 체크는 **지도에 보일지**를 정한다 — 대화를
 * 지우는 것이 아니다.
 *
 * ## 체크박스를 `<input>`으로 안 만든다
 *
 * 3상태(전부·일부·없음)는 `indeterminate`라는 **DOM 속성**으로만 켜진다 —
 * 프로퍼티라 JSX로 못 주고 ref로 써야 하는데, 이 저장소는 React Compiler
 * 규칙이 켜져 있어 렌더 중 ref 쓰기가 에러다. `role="checkbox"` +
 * `aria-checked="mixed"`가 같은 뜻을 표준으로 전하고 ref가 필요 없다.
 */

import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Minus,
} from "lucide-react";
import {
  folderCheckState,
  type CheckState,
  type SessionFolder,
} from "@/lib/home/sessionTree";

export interface MapSessionTreeProps {
  folders: SessionFolder[];
  /** 지도에서 **숨긴** 대화. 부정 목록인 이유는 `mapPrefs.ts` 참조. */
  hidden: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggleSession: (id: string) => void;
  onToggleFolder: (folder: SessionFolder) => void;
  onToggleCollapse: (key: string) => void;
  onShowAll: () => void;
}

/** 3상태 상자 하나. 글자는 부모가 그리고 여기는 표시만 한다. */
function CheckBox({
  state,
  label,
  onClick,
}: {
  state: CheckState;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      onClick={onClick}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep ${
        state === "none"
          ? "border-accent-border/60 bg-transparent"
          : "border-accent-deep bg-accent-deep text-white"
      }`}
    >
      {state === "all" && <Check size={11} strokeWidth={3.5} aria-hidden />}
      {state === "some" && <Minus size={11} strokeWidth={3.5} aria-hidden />}
    </button>
  );
}

export function MapSessionTree({
  folders,
  hidden,
  collapsed,
  onToggleSession,
  onToggleFolder,
  onToggleCollapse,
  onShowAll,
}: MapSessionTreeProps) {
  const hiddenCount = folders.reduce(
    (n, f) => n + f.sessions.filter((s) => hidden.has(s.id)).length,
    0,
  );

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-r border-accent-border/40 bg-bg">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-accent-border/30 px-3 py-2">
        <span className="text-xs font-semibold text-fg">대화</span>
        {/*
          숨긴 것이 있을 때만 낸다. 늘 떠 있으면 "전부 보기"가 무엇을 바꾸는지
          알 수 없고, 없을 때 눌러도 아무 일이 안 일어나 고장으로 읽힌다.
        */}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={onShowAll}
            className="rounded px-1.5 py-0.5 text-[11px] text-accent-deep transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
          >
            전부 보기
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
        {folders.length === 0 ? (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
            지도에 올라간 대화가 아직 없습니다.
          </p>
        ) : (
          folders.map((f) => {
            const state = folderCheckState(f, hidden);
            const open = !collapsed.has(f.key);
            return (
              <div key={f.key} className="px-1">
                <div className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent-soft/50">
                  <CheckBox
                    state={state}
                    label={`${f.name} 전체 표시`}
                    onClick={() => onToggleFolder(f)}
                  />
                  <button
                    type="button"
                    onClick={() => onToggleCollapse(f.key)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
                  >
                    {open ? (
                      <ChevronDown size={12} className="shrink-0 text-fg-muted" aria-hidden />
                    ) : (
                      <ChevronRight size={12} className="shrink-0 text-fg-muted" aria-hidden />
                    )}
                    {open ? (
                      <FolderOpen size={13} className="shrink-0 text-accent-deep" aria-hidden />
                    ) : (
                      <Folder size={13} className="shrink-0 text-accent-deep" aria-hidden />
                    )}
                    <span className="truncate text-xs font-medium text-fg">{f.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-muted">
                      {f.count}
                    </span>
                  </button>
                </div>

                {open &&
                  f.sessions.map((s) => {
                    const shown = !hidden.has(s.id);
                    return (
                      <div
                        key={s.id}
                        className="flex items-center gap-1.5 rounded-md py-1 pl-7 pr-2 hover:bg-accent-soft/50"
                      >
                        <CheckBox
                          state={shown ? "all" : "none"}
                          label={`${s.title} 표시`}
                          onClick={() => onToggleSession(s.id)}
                        />
                        <button
                          type="button"
                          onClick={() => onToggleSession(s.id)}
                          className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
                        >
                          {/* 꺼진 대화는 흐리게 — 목록에서 사라지면 되돌릴 수가 없다. */}
                          <span
                            className={`truncate text-xs ${shown ? "text-fg" : "text-fg-muted/60"}`}
                          >
                            {s.title}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-muted">
                            {s.count}
                          </span>
                        </button>
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
