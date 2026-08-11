"use client";

/**
 * 답변을 **읽는 모습**과 **원문** 사이에서 고르게 하는 상자 (2026-08-10).
 *
 * ## 왜 필요한가
 *
 * `ai_logs.answer`·`nodes.answer`에는 전선 위 원문이 들어간다 — `CHAT:` 접두사와
 * `@concept: 제목 | 분류` 표시가 섞여 있다. 그걸 그대로 박스에 넣으면 운영자
 * 눈에는 **답변에 다른 내용이 끼어든 것**으로 보인다(사용자 보고 2026-08-10).
 *
 * 그런데 원문을 없앨 수도 없다. 형식이 깨진 턴(모델이 `@concept:`를 빠뜨리는
 * 일이 실측 22%였다)을 찾으려면 **날것을 봐야** 한다.
 *
 * 그래서 둘 다 준다. 기본값만 자리에 따라 다르다:
 *
 *   · **턴 로그** — 읽는 모습. 무슨 답을 했는지 확인하러 오는 자리다.
 *   · **대화** — 원문. 형식 위반을 찾으러 오는 자리다(그 탭의 원래 결정).
 */

import { useState } from "react";
import { readAnswer } from "@/lib/admin/readAnswer";

export function AnswerBox({
  raw,
  defaultRaw = false,
  className = "",
}: {
  raw: string | null | undefined;
  /** 처음에 원문을 보여 줄까. */
  defaultRaw?: boolean;
  className?: string;
}) {
  const [showRaw, setShowRaw] = useState(defaultRaw);
  const parsed = readAnswer(raw);
  /** 풀어 봐야 달라지는 것이 없으면 토글을 만들지 않는다. */
  const 볼것이있다 = Boolean(parsed.reply || parsed.cards.length);

  return (
    <div className={className}>
      {볼것이있다 && (
        <div className="mb-1.5 flex items-center gap-1">
          {(["읽는 모습", "원문"] as const).map((label, i) => {
            const on = showRaw === (i === 1);
            return (
              <button
                key={label}
                type="button"
                onClick={() => setShowRaw(i === 1)}
                aria-pressed={on}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  on ? "bg-[#e0a32e] text-[#1b1813]" : "bg-[#332d23] text-[#9a948a] hover:text-[#e7e3d8]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {showRaw || !볼것이있다 ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#221e17] p-2 font-sans text-xs leading-relaxed text-[#cfc9bd]">
          {parsed.rest || raw || "(답변 없음)"}
        </pre>
      ) : (
        <div className="flex flex-col gap-2">
          {parsed.reply && (
            <p className="rounded bg-[#221e17] px-2.5 py-2 text-xs leading-relaxed text-[#cfc9bd]">
              {parsed.reply}
            </p>
          )}
          {parsed.cards.map((c, i) => (
            <div
              key={`${c.title}-${i}`}
              className="rounded border-l-2 border-[#c88a2e] bg-[#221e17] px-2.5 py-2"
            >
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <span className="text-xs font-semibold text-[#e7e3d8]">
                  {c.title || "(제목 없음)"}
                </span>
                {c.tag && (
                  <span className="rounded-full bg-[#332d23] px-1.5 py-px text-[10px] text-[#9a948a]">
                    {c.tag}
                  </span>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[#cfc9bd]">
                {c.body}
              </pre>
            </div>
          ))}
          {/**
           * 카드가 하나도 없으면 **그 사실이 곧 정보다** — 모델이 형식을
           * 어겼다는 뜻이라, 조용히 넘기면 운영자가 찾으러 온 것을 못 찾는다.
           */}
          {parsed.cards.length === 0 && (
            <p className="text-[10px] text-[#e0a32e]">
              개념 카드가 없는 턴입니다 — 인사이거나 형식을 어긴 답입니다.
              원문을 보세요.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
