"use client";

/**
 * 신원이 **영원히 같은** 이벤트 콜백 (D145).
 *
 * ## 왜 필요한가
 *
 * 아이템 핸들러 묶음은 `items`·`layout`·`selectedIds`에 의존했다. 그 중 하나만
 * 바뀌어도 묶음 객체가 새로 생기고, 그걸 prop으로 받는 **모든** 아이템에서
 * `memo`가 깨진다. 실측: 글 21개짜리 캔버스에서 **하나를 클릭할 때마다 128회**
 * 렌더됐다(21개 × 부모 렌더 여러 번). 글이 늘수록 그대로 곱해진다.
 *
 * 최신 값을 ref에 담아 두고, 밖으로는 그 ref를 부르는 껍데기만 내보낸다.
 * 껍데기는 의존성이 없으므로 신원이 변하지 않는다.
 *
 * ## 왜 안전한가
 *
 * ref는 **커밋 뒤에** 갱신되고, 이벤트 핸들러는 커밋 뒤에만 불린다. 즉 호출
 * 시점에는 언제나 마지막으로 화면에 반영된 값을 본다. 렌더 도중에 부르면
 * 한 박자 뒤진 값을 보게 되므로 **렌더 중에는 쓰지 않는다** — 이름 그대로
 * 이벤트에서만 쓴다.
 *
 * React Compiler 규칙과도 어긋나지 않는다: ref 쓰기는 이펙트 안이고, ref
 * 읽기는 껍데기가 실제로 호출될 때(=렌더 밖)다.
 */

import { useCallback, useEffect, useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEventCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  // useCallback의 첫 인자는 **인라인 함수 그대로**여야 한다(React Compiler
  // 규칙). 타입 단언은 밖에서 한다.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stable = useCallback((...args: any[]) => ref.current(...args), []);
  return stable as T;
}
