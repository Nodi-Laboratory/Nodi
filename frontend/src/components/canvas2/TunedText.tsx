"use client";

/**
 * 손글씨 폰트가 못 그리는 글자만 골라 크기를 맞춰 렌더한다 (D165).
 *
 * 판정은 `lib/canvas2/handScript.ts`가 하고(순수 함수라 테스트가 붙는다) 여기는
 * 그 구간을 `<span>`으로 감싸기만 한다. 실제 배율은 `globals.css`의
 * `.c2-tune[data-tune="cjk"]`에 있다 — 값 하나를 고치면 캔버스 전체에 먹는다.
 *
 * **보정할 글자가 없으면 span을 만들지 않는다.** 한국어 문장은 거의 전부 이
 * 경우라, 평소에는 이 컴포넌트가 문자열을 그대로 흘려보내는 것과 같다.
 */

import { toScriptSegs } from "@/lib/canvas2/handScript";

export function TunedText({ text }: { text: string }) {
  const segs = toScriptSegs(text);
  if (segs.length <= 1 && !segs[0]?.script) return <>{text}</>;

  // key는 구간의 시작 오프셋(`seg.at`)이다. 배열 위치로 매기면 앞 구간이 자랄
  // 때 뒤 span이 다른 글자로 재사용된다 — `ink.ts`가 절대 색인을 쓰는 이유와 같다.
  return (
    <>
      {segs.map((s) =>
        s.script ? (
          <span key={s.at} className="c2-tune" data-tune={s.script}>
            {s.text}
          </span>
        ) : (
          <span key={s.at}>{s.text}</span>
        ),
      )}
    </>
  );
}
