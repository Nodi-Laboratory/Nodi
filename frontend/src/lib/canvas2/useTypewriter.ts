"use client";

/**
 * 글자 단위 타이핑 페이싱 (v1의 체감을 되살린다).
 *
 * ## 왜 필요한가
 *
 * v1은 파서가 글자마다 `delta{ch}` 이벤트를 냈고 리듀서가 토큰을 하나씩
 * 쌓아서, 글이 실제로 **써지는** 것처럼 보였다. v2는 본문을 원문 문자열로
 * 모으는데(편집 가능하려면 원문이 있어야 한다) 그 대가로 줄 단위로 뭉텅
 * 나타난다 — 사용자가 지적한 "글자가 하나씩 생성되는 기능이 사라졌다"가 이것이다.
 *
 * ## 해결: 저장값과 표시값을 분리한다
 *
 * 파서는 원문을 그대로 쌓고(저장·편집용), 렌더는 여기서 **드러낼 글자 수**만
 * 세어 잘라 보여 준다. 두 관심사를 섞지 않으므로 v1처럼 마크업이 파싱 시점에
 * 소실되는 일이 없다.
 *
 * 속도는 남은 글자 수에 비례해 정한다 — 고정 간격이면 긴 응답에서 한없이
 * 늘어진다. 스트림이 끝났는데 아직 드러낼 글자가 남아 있으면 서둘러 흘려
 * 보내 사용자를 기다리게 하지 않는다.
 *
 * 구현 주의: **렌더 중 ref를 쓰지 않는다.** 진행 상태를 ref에만 두고 rAF에서
 * 갱신하고, 화면에 필요한 값만 state로 미러링한다(React Compiler 규칙).
 */

import { useEffect, useRef, useState } from "react";

/** 한 프레임에 드러낼 최소 글자 수. */
const MIN_PER_FRAME = 1;
/** 한 프레임 최대. 이 이상이면 "타이핑"이 아니라 그냥 붙는 것으로 보인다. */
const MAX_PER_FRAME = 12;
/**
 * 목표 소요 시간(ms). 남은 글자를 이 시간 안에 다 드러내도록 속도를 정한다.
 * 짧은 답은 또박또박, 긴 답은 빠르게 — 어느 쪽도 지루하지 않다.
 */
const TARGET_MS = 900;
/** 스트림이 끝난 뒤에는 이 배수로 서둘러 끝낸다. */
const CATCHUP = 4;

export interface Typewriter {
  /** 지금 드러낼 글자 수. 본문을 이 길이로 잘라 렌더한다. */
  shown: number;
  /** 아직 다 드러내지 못했나(캐럿을 보일지 결정). */
  typing: boolean;
}

/**
 * @param full   현재까지 도착한 전체 길이
 * @param active 스트림이 계속되고 있나(속도만 결정한다)
 *
 * **래치가 필요 없다.** 마운트 시점에 `active`가 아니면(재수화된 아이템)
 * 처음부터 전부 드러난 상태로 시작하므로 타이핑이 아예 일어나지 않는다.
 * 스트리밍으로 태어난 아이템은 0에서 시작하고, 스트림이 끝나도 계속 진행해
 * CATCHUP 속도로 마무리한다 — 남은 글자가 한 번에 튀지 않는다.
 */
export function useTypewriter(full: number, active: boolean): Typewriter {
  // 초기값만 마운트 시점의 상태로 정한다(useState 초기화 함수는 1회만 돈다).
  const [shown, setShown] = useState(() => (active ? 0 : full));
  /** rAF 루프의 진행 상태. 렌더는 이 값을 읽지 않는다. */
  const progress = useRef(active ? 0 : full);
  const rafRef = useRef(0);

  useEffect(() => {
    // 본문이 짧아졌으면(편집) 맞춘다. 이펙트 본문에서 동기 setState를 하면
    // 연쇄 렌더가 되므로 rAF 한 프레임에 처리한다.
    if (progress.current > full) {
      progress.current = full;
      rafRef.current = requestAnimationFrame(() => setShown(full));
      return () => cancelAnimationFrame(rafRef.current);
    }
    if (progress.current >= full) return;

    let last = 0;
    const step = (ts: number) => {
      const dt = last ? ts - last : 16;
      last = ts;

      const remain = full - progress.current;
      if (remain <= 0) return;

      const budget = active ? TARGET_MS : TARGET_MS / CATCHUP;
      const add = Math.max(
        MIN_PER_FRAME,
        Math.min(MAX_PER_FRAME, Math.round((remain / budget) * dt)),
      );
      progress.current = Math.min(full, progress.current + add);
      setShown(progress.current);
      if (progress.current < full) rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [full, active]);

  const clamped = Math.min(shown, full);
  return { shown: clamped, typing: clamped < full };
}
