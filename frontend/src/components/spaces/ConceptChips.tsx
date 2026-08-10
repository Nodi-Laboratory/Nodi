"use client";

/**
 * 개념 칩 한 줄 — **지도와 같은 색** (사용자 지시 2026-08-09).
 *
 * 색이 장식이 아니다. 같은 분류는 홈 지도·미니맵·지도 모달에서 이미 한 가지
 * 색으로 그려진다(`lib/ui/pastel.ts`). 그 색을 여기서도 쓰면 학생이 "지도에서
 * 본 그 파란 무리"와 목록의 방을 눈으로 잇는다 — 색이 다르면 같은 분류라는
 * 사실이 화면마다 새로 배워야 하는 것이 된다.
 *
 * **한 줄을 넘기지 않는다.** 넘치는 것은 세지 않고 `…` 하나로 접는다 —
 * "+3"처럼 수를 보여 주면 그 수가 무엇을 세는지 학생이 알 길이 없다.
 */

import { pastelForTag } from "@/lib/ui/pastel";

interface Props {
  concepts: readonly string[];
  /** 이 개수까지만 보여 준다. 넘치면 `…`. */
  cap: number;
  /** 칩 글자 크기(px). 카드와 목록이 서로 다른 눈금을 쓴다. */
  size?: number;
}

export function ConceptChips({ concepts, cap, size = 12 }: Props) {
  if (concepts.length === 0) return null;
  const shown = concepts.slice(0, cap);
  const more = concepts.length - shown.length;

  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
      {shown.map((c) => (
        <span
          key={c}
          className="shrink-0 truncate rounded-full px-2 py-0.5 font-medium"
          style={{
            fontSize: size,
            /**
             * 파스텔은 배경으로 만든 색이라 그대로 칠하면 글자가 안 읽힌다.
             * 옅게 깔고 **테두리로 그 색을 또렷하게** 남긴다 — 칩이 작아도
             * 색이 무엇인지 알아볼 수 있다.
             */
            background: `${pastelForTag(c)}55`,
            border: `1px solid ${pastelForTag(c)}`,
            color: "var(--fg)",
            maxWidth: 132,
          }}
        >
          {c}
        </span>
      ))}
      {more > 0 && (
        <span
          className="shrink-0 px-0.5 text-fg-muted"
          style={{ fontSize: size }}
          // 접은 것이 무엇인지는 **물어보면** 알 수 있어야 한다.
          title={concepts.slice(cap).join(", ")}
        >
          …
        </span>
      )}
    </div>
  );
}
