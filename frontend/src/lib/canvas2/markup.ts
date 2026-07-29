/**
 * 본문 원문 → 렌더 블록 (D125).
 *
 * 스트리밍 증분 파서(`streamParser.ts`)와 **역할이 다르다.** 저쪽은 글자가
 * 도착하는 대로 이벤트를 내야 해서 줄 버퍼와 상태 기계가 필요하고, 여기는
 * 완성된 문자열 하나를 받아 한 번에 변환한다.
 *
 * ## 두 형식을 모두 받는다
 *
 * v1 프롬프트는 본문 줄마다 `- ` 접두사를 강제했다. v2는 문단을 쓰게 한다.
 * 이미 저장된 세션이 구 형식이므로 **둘 다 유효하게** 처리한다:
 *
 *     - 로 시작하는 줄   →  목록 항목(li)
 *     그 외              →  문단(p), 빈 줄이 문단 경계
 *
 * 마이그레이션이 필요 없다.
 *
 * ## 마크업
 *
 * `**굵게**` · `==형광펜==`. 상태 기계로 벗겨낸다 — 정규식으로 하면 짝이
 * 안 맞는 마커(모델이 흔히 흘린다)에서 본문이 통째로 사라진다.
 */

import type { MarkToken, RenderBlock } from "./types";

/** 한 줄을 토큰으로. 마커는 제거하고 상태만 남긴다. */
function scanLine(text: string, out: MarkToken[]): void {
  let bold = false;
  let hl = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("**", i)) {
      bold = !bold;
      i += 2;
      continue;
    }
    if (text.startsWith("==", i)) {
      hl = !hl;
      i += 2;
      continue;
    }
    const t: MarkToken = { ch: text[i] };
    if (bold) t.b = true;
    if (hl) t.h = true;
    out.push(t);
    i += 1;
  }
}

/**
 * 목록 항목 접두사. `- `, `* `, `• ` 모두 받는다(모델이 섞어 쓴다).
 *
 * 기호 뒤에 공백이나 줄끝을 **요구한다.** 그래야 `-5도까지 떨어진다` 같은
 * 문장이 목록으로 오인되지 않는다. 줄끝을 허용하는 건 기호만 있는 빈 줄
 * (모델이 흘리는 형식 잔재)을 목록으로 잡아 버리기 위해서다 — 문단으로
 * 새면 화면에 하이픈 한 글자가 덩그러니 남는다.
 */
const LI_RE = /^\s*[-*•](?:\s+|$)/;

export function toBlocks(body: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let para: MarkToken[] | null = null;

  const flushPara = () => {
    if (para && para.length) blocks.push({ type: "p", tokens: para });
    para = null;
  };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");

    if (!line.trim()) {
      flushPara(); // 빈 줄 = 문단 경계
      continue;
    }

    if (LI_RE.test(line)) {
      flushPara();
      const tokens: MarkToken[] = [];
      scanLine(line.replace(LI_RE, ""), tokens);
      if (tokens.length) blocks.push({ type: "li", tokens });
      continue;
    }

    // 같은 문단의 이어지는 줄은 공백으로 잇는다 — 모델이 임의로 넣은 줄바꿈이
    // 그대로 렌더되면 폭 460px 안에서 들쭉날쭉해진다.
    if (para) para.push({ ch: " " });
    else para = [];
    scanLine(line, para);
  }
  flushPara();
  return blocks;
}

/** 블록 → 평문(미리보기·검색용). */
export function blocksToText(blocks: readonly RenderBlock[]): string {
  return blocks.map((b) => b.tokens.map((t) => t.ch).join("")).join("\n");
}

/**
 * 같은 서식이 이어지는 구간을 하나로 합친다.
 *
 * 글자마다 `<span>`을 만들면 긴 문단에서 DOM이 폭발한다(v1의 `renderTokens`가
 * 같은 이유로 런 병합을 한다 — 그 처리는 유지할 가치가 있다).
 */
export interface Run {
  text: string;
  b: boolean;
  h: boolean;
}

export function toRuns(tokens: readonly MarkToken[]): Run[] {
  const runs: Run[] = [];
  for (const t of tokens) {
    const b = !!t.b;
    const h = !!t.h;
    const last = runs[runs.length - 1];
    if (last && last.b === b && last.h === h) last.text += t.ch;
    else runs.push({ text: t.ch, b, h });
  }
  return runs;
}
