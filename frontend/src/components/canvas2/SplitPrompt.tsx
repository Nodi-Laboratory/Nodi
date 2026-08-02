"use client";

/**
 * 가지 한가운데를 떼어낼 때 **아래를 어떻게 할지** 묻는다 (D156).
 *
 * 학생이 중간 노드의 분류를 바꾸면 그 노드는 원래 트리에서 빠진다(간선은
 * 같은 태그끼리만 성립한다 — D151). 문제는 **그 아래 가지**다. 답이 둘 다
 * 말이 되고, 어느 쪽인지는 학생만 안다:
 *
 *   같이 끊기        이 이야기 전체를 따로 떼어 놓겠다
 *   부모에 잇고 끊기  이 한 장만 빼고 나머지는 원래 흐름에 남기겠다
 *
 * 그래서 묻는다(사용자 지시 2026-08-02). 자식이 없거나 뿌리라서 고를 것이
 * 없으면 이 상자는 뜨지 않는다 — 물을 것이 하나뿐이면 묻지 않는다.
 */

import { CornerDownRight, Scissors, X } from "lucide-react";

interface Props {
  /** 떼어낼 글의 제목(또는 앞부분). 무엇을 만지는지 보여 준다. */
  title: string;
  /** 딸린 가지의 글 수. */
  kidCount: number;
  /** 새 분류. null이면 분류를 없애는 것이다. */
  tag: string | null;
  onDetachAll: () => void;
  onReattach: () => void;
  onCancel: () => void;
}

export function SplitPrompt({
  title,
  kidCount,
  tag,
  onDetachAll,
  onReattach,
  onCancel,
}: Props) {
  return (
    <div
      data-no-pan
      role="dialog"
      aria-label="가지 분리 방식"
      className="ui absolute left-1/2 top-20 z-40 w-[min(460px,calc(100%-80px))] -translate-x-1/2 rounded-xl border p-4"
      style={{
        background: "var(--c-raised)",
        borderColor: "var(--c-rule)",
        boxShadow: "var(--c-shadow-lg)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[14px] font-medium" style={{ color: "var(--c-ink)" }}>
          &ldquo;{title}&rdquo;를 {tag ? `[${tag}]로` : "분류 없음으로"} 옮깁니다
        </p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="그만두기"
          style={{ color: "var(--c-ink-faint)" }}
        >
          <X size={14} />
        </button>
      </div>
      <p className="mt-1 text-[13px]" style={{ color: "var(--c-ink-soft)" }}>
        이 글에 딸린 가지가 {kidCount}개 있어요. 그 가지를 어떻게 할까요?
      </p>

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={onDetachAll}
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors"
          style={{ borderColor: "var(--c-rule)", background: "var(--c-sunk)" }}
        >
          <Scissors size={14} style={{ color: "var(--c-hand)", marginTop: 2 }} />
          <span>
            <span className="block text-[13px] font-medium" style={{ color: "var(--c-ink)" }}>
              자식 노드들도 같이 끊기
            </span>
            <span className="block text-[12px]" style={{ color: "var(--c-ink-faint)" }}>
              가지 전체가 함께 옮겨 가 새 트리가 됩니다
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onReattach}
          className="flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors"
          style={{ borderColor: "var(--c-rule)", background: "var(--c-sunk)" }}
        >
          <CornerDownRight size={14} style={{ color: "var(--c-live)", marginTop: 2 }} />
          <span>
            <span className="block text-[13px] font-medium" style={{ color: "var(--c-ink)" }}>
              자식 노드를 부모 노드에 연결하고 끊기
            </span>
            <span className="block text-[12px]" style={{ color: "var(--c-ink-faint)" }}>
              이 글만 빠지고 가지는 원래 흐름에 이어집니다
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
