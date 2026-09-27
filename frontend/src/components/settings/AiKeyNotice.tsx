"use client";

/**
 * "이 기능에는 키가 필요해요" 한 줄 + [키 입력] (공개판 C 분류, 2026-09-27).
 *
 * 키가 없을 때 기능을 **조용히** 막으면 고장으로 보인다. 무엇이 왜 잠겼고
 * 어떻게 여는지를 그 자리에서 말한다. 팝업은 이 컴포넌트가 직접 연다 —
 * 부르는 쪽(입력창·홈)이 상태를 따로 들 필요가 없다.
 */

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { ApiKeyDialog } from "./ApiKeyDialog";

export function AiKeyNotice({
  message,
  className = "",
}: {
  message: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        role="status"
        data-testid="ai-key-notice"
        className={`flex items-center gap-2 rounded-full bg-bg-elevated px-3.5 py-1.5 text-[13px] text-fg-muted shadow-sm ${className}`}
      >
        <KeyRound size={14} className="shrink-0" />
        <span className="min-w-0">{message}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-full bg-accent-deep px-2.5 py-0.5 text-[12px] font-medium text-accent-fg hover:brightness-95"
        >
          키 입력
        </button>
      </div>
      <ApiKeyDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
