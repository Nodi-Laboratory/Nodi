"use client";

/**
 * 수식 한 덩어리 (D210 3-1).
 *
 * ## 왜 KaTeX인가
 *
 * MathJax보다 가볍고 **동기 렌더**다. 스트리밍 중에는 글자가 들어올 때마다
 * 문단이 다시 그려지는데, 비동기 렌더러면 그때마다 한 프레임 늦게 나타나
 * 수식이 깜빡인다. 폰트는 자체 호스팅한다 — 이 저장소는 외부 CDN을 쓰지
 * 않는다(`katex/dist/katex.min.css`가 번들러를 통해 폰트를 함께 싣는다).
 *
 * ## 이것은 wipe 애니메이션의 예외다
 *
 * `ink.ts`는 방금 드러난 꼬리를 **글자마다 span으로** 쪼개 각자 나타나게
 * 한다. 수식은 쪼갤 수 없다 — KaTeX가 만든 DOM을 글자 span으로 찢으면
 * 수식이 통째로 깨진다. 그래서 한 덩어리로 두고, 차례가 오면 짧게
 * 페이드인시킨다(`c2-math-in`).
 *
 * ## 못 읽는 수식은 원문으로 둔다
 *
 * `throwOnError: false`면 KaTeX가 빨간 글씨로 오류를 그린다. 학생 화면에
 * 빨간 LaTeX 오류가 뜨는 것보다 **원문 그대로** 보이는 편이 낫다 — 적어도
 * 무엇을 쓰려 했는지는 읽힌다.
 */

import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

export function MathSpan({
  tex,
  display,
  animate,
}: {
  tex: string;
  /** 블록 수식이면 가운데 크게. */
  display?: boolean;
  /** 지금 써지는 중이면 페이드인시킨다. */
  animate?: boolean;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: true,
        strict: "ignore",
        /**
         * ⚠️ **여기가 안전의 전부다.**
         *
         * 아래에서 `dangerouslySetInnerHTML`을 쓰는데, 그 HTML은 학생이나
         * 모델이 준 문자열이 아니라 **KaTeX가 자기 AST에서 만든 것**이다.
         * KaTeX는 입력을 통과시키지 않고 파싱해 다시 그린다.
         *
         * 통과가 생기는 유일한 길이 `trust`다 — 켜면 링크·이미지 명령이
         * URL을 그대로 싣는다(`javascript:`를 포함해서). 기본값이 false지만
         * **명시한다**: 다음 사람이 '수식에 링크를 넣고 싶다'며 켜는 순간
         * XSS가 열리고, 그 위험이 여기 적혀 있지 않으면 아무도 모른다.
         */
        trust: false,
      });
    } catch {
      return null;
    }
  }, [tex, display]);

  if (html === null) {
    // 못 읽은 수식 — 원문을 그대로 보여 준다.
    return <span className="c2-math-raw">{display ? `$$${tex}$$` : `$${tex}$`}</span>;
  }
  return (
    <span
      data-math={display ? "block" : "inline"}
      className={animate ? "c2-math c2-math-in" : "c2-math"}
      // KaTeX가 만든 마크업이다. 입력은 모델이 낸 LaTeX 원문이고 KaTeX가
      // 자체적으로 이스케이프한다(`trust` 기본값이 false라 \\href 같은 것도 막힌다).
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
