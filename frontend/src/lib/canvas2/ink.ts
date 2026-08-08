/**
 * 잉크가 얹히는 순간만 글자 단위로 쪼갠다 (D164).
 *
 * ## 왜 이 모듈이 따로 있나
 *
 * `useTypewriter`는 **몇 글자를 드러낼지**만 정하고, `markup.toRuns`는 같은
 * 서식이 이어지는 구간을 **하나로 합친다**(글자마다 `<span>`을 만들면 긴
 * 문단에서 DOM이 폭발하므로). 그런데 "써지는" 애니메이션은 글자마다 각자
 * 시작해야 하므로 두 요구가 정면으로 부딪힌다.
 *
 * 타협점은 **꼬리만 쪼개는 것**이다. 방금 드러난 마지막 몇 글자만 개별
 * `<span>`으로 만들고, 그보다 앞선 글자는 다시 런으로 합쳐 둔다. 화면에
 * 동시에 존재하는 개별 span은 항상 `TAIL` 개 이하다.
 *
 * ## 절대 색인이 애니메이션의 전부다
 *
 * 각 글자 span의 key는 **문서 전체에서 몇 번째 글자인가**(`start + i`)여야
 * 한다. 배열 안 위치로 key를 매기면 꼬리가 한 칸 나아갈 때마다 모든 span이
 * 다른 글자로 재사용되어 **이미 다 써진 글자가 매 프레임 다시 써진다** —
 * 화면 전체가 깜빡이는 것처럼 보인다. 절대 색인이면 React가 같은 DOM 노드를
 * 그대로 유지하므로 애니메이션이 한 번만 돈다.
 *
 * 색인은 **덧붙이기에 안정적**이어야 한다. 스트리밍은 뒤에만 글자를 더하므로
 * 앞선 블록·런의 시작 색인은 변하지 않는다. (서식 마커가 짝을 못 맞춰
 * 굵기 상태가 뒤집히면 `b`/`h`만 바뀌고 색인은 그대로다.)
 */

import { toRuns, type Run } from "./markup";
import type { RenderBlock } from "./types";

/**
 * 동시에 애니메이션할 수 있는 최대 글자 수.
 *
 * `useTypewriter`의 최대 속도(프레임당 MAX_PER_FRAME) × 애니메이션 길이보다
 * 넉넉해야 한다. 좁으면 아직 다 써지지 않은 글자가 창 밖으로 밀려나며
 * **완성 상태로 툭 튄다.** 실측 기준: 6자/프레임 × 60fps × 0.22s ≈ 80자.
 */
export const INK_TAIL = 96;

/** 서식 런에 절대 시작 색인을 붙인 것. */
export interface InkRun extends Run {
  /** 문서 전체에서 이 런의 첫 글자가 몇 번째인가. */
  start: number;
}

export interface InkBlock {
  type: RenderBlock["type"];
  /** 문서 전체에서 이 블록의 첫 글자가 몇 번째인가 (key로 쓴다). */
  start: number;
  runs: InkRun[];
}

export interface InkDoc {
  blocks: InkBlock[];
  /** 렌더되는 글자의 총 개수. 꼬리 경계는 `total - INK_TAIL`이다. */
  total: number;
}

/**
 * 블록들에 절대 색인을 매긴다.
 *
 * 블록 사이의 줄바꿈은 세지 않는다 — 화면에 글자로 나오지 않으므로 셀 이유가
 * 없고, 세면 `total`이 실제 글자 수와 어긋나 꼬리 길이가 흔들린다.
 */
export function toInkDoc(blocks: readonly RenderBlock[]): InkDoc {
  const out: InkBlock[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const runs: InkRun[] = [];
    const start = cursor;
    for (const r of toRuns(b.tokens)) {
      runs.push({ ...r, start: cursor });
      cursor += r.text.length;
    }
    out.push({ type: b.type, start, runs });
  }
  return { blocks: out, total: cursor };
}

/** 런을 "이미 마른 앞부분"과 "지금 써지는 글자들"로 가른다. */
export interface RunSplit {
  /** 합쳐서 렌더할 앞부분. 빈 문자열이면 렌더하지 않는다. */
  dry: string;
  /** 글자 하나씩 렌더할 꼬리. `[절대색인, 글자]` 쌍. */
  wet: Array<[number, string]>;
}

/**
 * @param tailFrom 이 절대 색인부터가 꼬리다. `Infinity`면 아무것도 쪼개지 않는다
 *                 (재수화된 글 — 애니메이션이 아예 일어나면 안 된다).
 *
 * 서로게이트 쌍(이모지)은 `Array.from`으로 코드포인트 단위로 자른다. 코드
 * 유닛으로 자르면 반쪽짜리 글자가 `<span>` 둘로 갈려 깨진 문자가 보인다.
 * 그 대신 절대 색인은 **코드 유닛 기준**을 유지한다 — `start`가 코드 유닛으로
 * 누적되므로 섞으면 어긋난다.
 */
export function splitRun(run: InkRun, tailFrom: number): RunSplit {
  if (!Number.isFinite(tailFrom) || run.start + run.text.length <= tailFrom) {
    return { dry: run.text, wet: [] };
  }
  /**
   * **수식은 쪼개지 않는다** (D210 3-1).
   *
   * KaTeX가 만든 DOM을 글자 span으로 찢으면 수식이 통째로 깨진다. 한 덩어리로
   * 두고, 차례가 오면 호출부가 짧게 페이드인시킨다. `dry`로 돌려주면 "이미
   * 다 써진 글"로 취급돼 아무 연출도 안 붙으므로 `wet`에 통째로 싣는다 —
   * 호출부는 조각 수가 1이면 수식임을 안다.
   */
  if (run.m) return { dry: "", wet: [[run.start, run.text]] };
  const wet: Array<[number, string]> = [];
  let dryEnd = 0;
  let i = 0;
  for (const ch of Array.from(run.text)) {
    const at = run.start + i;
    if (at >= tailFrom) wet.push([at, ch]);
    else dryEnd = i + ch.length;
    i += ch.length;
  }
  return { dry: run.text.slice(0, dryEnd), wet };
}
