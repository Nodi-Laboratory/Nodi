"use client";

/**
 * AI API 키 입력 (공개판 C 분류, 2026-09-27).
 *
 * 서버 `.env`에 키가 **없는 칸만** 보인다 — 운영자가 키를 넣어 둔 서버에서는
 * 이 팝업 자체가 열릴 일이 없다(`useAiReadiness().needs*Input`).
 *
 * 키는 이 브라우저의 localStorage에만 저장된다. 서버는 요청마다 헤더로 받아
 * 그 요청 동안만 쓰고 DB·로그에 남기지 않는다. 그 사실을 화면에 적는다 —
 * 모르는 사이트에 키를 넣으라고 하면서 어디로 가는지 말하지 않으면 안 된다.
 *
 * 입력칸은 password 타입이다 — 스크린 공유·스크린샷에 키가 찍히지 않게.
 */

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import {
  GEMINI_VISION_MODELS,
  KEY_LINKS,
  loadApiKeys,
  saveApiKeys,
} from "@/lib/apiKeys";
import { useAiReadiness } from "@/lib/aiConfig";

export function ApiKeyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ready = useAiReadiness();
  // 열릴 때마다 저장된 값에서 시작한다(닫았다 열면 고치던 값을 버린다).
  const [draft, setDraft] = useState(loadApiKeys);
  const [openedAt, setOpenedAt] = useState(open);
  if (open !== openedAt) {
    setOpenedAt(open);
    if (open) setDraft(loadApiKeys());
  }

  const save = () => {
    saveApiKeys(draft);
    onClose();
  };

  const clearAll = () => {
    const empty = { ...draft, upstage: "", gemini: "" };
    setDraft(empty);
    saveApiKeys(empty);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="AI API 키 설정"
      width="max-w-lg"
      header={
        <>
          <h2 className="text-[19px] font-bold text-fg">AI API 키 설정</h2>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            서버에 키가 설정되어 있지 않아 직접 입력해야 하는 기능입니다.
          </p>
        </>
      }
    >
      <div className="flex flex-col gap-5" data-testid="api-key-dialog">
        {ready.needsUpstageInput && (
          <section>
            <h3 className="text-sm font-semibold text-fg">Upstage API 키</h3>
            <p className="mt-0.5 text-xs text-fg-muted">
              AI 답변(개념 카드)·질문 코치·자료 검색에 쓰입니다.
            </p>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.upstage}
              onChange={(e) => setDraft({ ...draft, upstage: e.target.value })}
              placeholder="up_로 시작하는 키"
              aria-label="Upstage API 키"
              className="mt-2.5 w-full rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-muted"
            />
            <a
              href={KEY_LINKS.upstage}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent-deep underline-offset-2 hover:underline"
            >
              Upstage 콘솔에서 키 발급 <ExternalLink size={11} />
            </a>
          </section>
        )}

        {ready.needsGeminiInput && (
          <section>
            <h3 className="text-sm font-semibold text-fg">Gemini API 키</h3>
            <p className="mt-0.5 text-xs text-fg-muted">
              손글씨 질문 인식과 펜 표시 해석에 쓰입니다.
            </p>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.gemini}
              onChange={(e) => setDraft({ ...draft, gemini: e.target.value })}
              placeholder="Gemini API 키"
              aria-label="Gemini API 키"
              className="mt-2.5 w-full rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-sm text-fg placeholder:text-fg-muted"
            />
            <label className="mt-2.5 block text-xs font-medium text-fg-muted">
              비전 모델
              <select
                value={draft.geminiModel}
                onChange={(e) => setDraft({ ...draft, geminiModel: e.target.value })}
                aria-label="Gemini 비전 모델"
                className="mt-1 block w-full rounded-xl bg-[var(--surface)] px-3 py-2.5 text-sm text-fg"
              >
                {GEMINI_VISION_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <a
              href={KEY_LINKS.gemini}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent-deep underline-offset-2 hover:underline"
            >
              Google AI Studio에서 키 발급 <ExternalLink size={11} />
            </a>
          </section>
        )}

        {!ready.uploadEnabled && (
          <p className="rounded-xl bg-[var(--surface)] px-3.5 py-2.5 text-xs text-fg-muted">
            파일 업로드는 백그라운드에서 처리되어 여기서 넣은 키를 쓸 수 없습니다.
            업로드가 필요하면 서버 <code>.env</code>의 <code>UPSTAGE_API_KEY</code>를
            채워 주세요.
          </p>
        )}

        <p className="text-xs text-fg-muted">
          키는 이 브라우저(localStorage)에만 저장됩니다. 서버는 요청을 처리하는
          동안에만 사용하고 저장하거나 기록하지 않습니다.
        </p>
      </div>

      <footer className="relative mt-5 flex shrink-0 items-center justify-between gap-2 pt-4 before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[var(--line)] before:content-['']">
        <button
          type="button"
          onClick={clearAll}
          className="rounded-xl px-3.5 py-2 text-sm text-fg-muted transition-colors hover:bg-[var(--surface)]"
        >
          저장된 키 지우기
        </button>
        <button
          type="button"
          onClick={save}
          className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:brightness-95"
        >
          저장
        </button>
      </footer>
    </Dialog>
  );
}
