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
 *
 * ## 수식 (D210 3-1)
 *
 * 인라인 `$…$` · `\(…\)`, 블록 `$$…$$` · `\[…\]`를 모두 받는다. 백엔드
 * 프롬프트가 표기를 하나로 지시하지만 **지시가 안 지켜지는 턴이 반드시
 * 나온다** — 프론트는 둘 다 받는다.
 *
 * ⚠️ **닫히지 않은 수식은 원문으로 둔다.** 스트리밍 중에는 `$`가 하나만 와
 * 있는 순간이 매 턴 생긴다. 그때 렌더를 시도하면 화면이 깜빡인다. 닫는
 * 기호를 찾은 뒤에야 토큰을 만든다.
 */

import type { MarkToken, RenderBlock } from "./types";

/** 인라인 수식의 여는 기호와 그 짝. */
const INLINE_MATH: readonly [string, string][] = [
  ["\\(", "\\)"],
  ["$", "$"],
];

/** 한 줄을 토큰으로. 마커는 제거하고 상태만 남긴다. */
function scanLine(text: string, out: MarkToken[]): void {
  let bold = false;
  let hl = false;
  let i = 0;
  while (i < text.length) {
    /**
     * 인라인 수식 (D210 3-1).
     *
     * `$$`는 여기서 처리하지 않는다 — 블록 수식이라 `toBlocks`가 먼저
     * 걷어낸다. 한 줄 안에 남은 `$$`는 짝이 안 맞는 것이므로 원문으로 둔다.
     */
    let 수식 = false;
    for (const [open, close] of INLINE_MATH) {
      if (!text.startsWith(open, i)) continue;
      if (open === "$" && text.startsWith("$$", i)) break; // 블록 기호는 건너뛴다
      const from = i + open.length;
      const end = text.indexOf(close, from);
      // 닫히지 않았거나 빈 수식이면 렌더하지 않는다 — 원문 그대로 흐른다.
      if (end < 0 || end === from) break;
      const tex = text.slice(from, end);
      const t: MarkToken = { ch: tex, m: "i" };
      if (bold) t.b = true;
      if (hl) t.h = true;
      out.push(t);
      i = end + close.length;
      수식 = true;
      break;
    }
    if (수식) continue;

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

/**
 * 블록 수식의 여는/닫는 기호. 여러 줄에 걸칠 수 있다.
 *
 * 모델은 보통 `$$`를 제 줄에 따로 쓴다. 그래서 줄 단위 파서가 만나기 전에
 * **먼저 걷어내야** 한다 — 안 그러면 여는 줄과 닫는 줄이 각각 문단이 된다.
 */
const BLOCK_MATH: readonly [string, string][] = [
  ["$$", "$$"],
  ["\\[", "\\]"],
];

/** 본문을 (평문 | 블록 수식) 조각으로 가른다. 닫히지 않은 것은 평문이다. */
function splitBlockMath(body: string): { text: string; math?: string }[] {
  const out: { text: string; math?: string }[] = [];
  let i = 0;
  let plain = "";
  while (i < body.length) {
    let 잡음 = false;
    for (const [open, close] of BLOCK_MATH) {
      if (!body.startsWith(open, i)) continue;
      const from = i + open.length;
      const end = body.indexOf(close, from);
      if (end < 0 || !body.slice(from, end).trim()) break;
      if (plain) {
        out.push({ text: plain });
        plain = "";
      }
      out.push({ text: "", math: body.slice(from, end).trim() });
      i = end + close.length;
      잡음 = true;
      break;
    }
    if (잡음) continue;
    plain += body[i];
    i += 1;
  }
  if (plain) out.push({ text: plain });
  return out;
}

export function toBlocks(body: string): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let para: MarkToken[] | null = null;

  const flushPara = () => {
    if (para && para.length) blocks.push({ type: "p", tokens: para });
    para = null;
  };

  for (const 조각 of splitBlockMath(body)) {
    if (조각.math !== undefined) {
      flushPara();
      blocks.push({ type: "math", tokens: [{ ch: 조각.math, m: "b" }] });
      continue;
    }
    scanPlain(조각.text);
  }
  flushPara();
  return blocks;

  function scanPlain(text: string): void {
  for (const rawLine of text.split("\n")) {
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
  }
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
  /** 수식 런이면 그 종류. `text`가 LaTeX 원문이다 (D210 3-1). */
  m?: "i" | "b";
}

export function toRuns(tokens: readonly MarkToken[]): Run[] {
  const runs: Run[] = [];
  for (const t of tokens) {
    const b = !!t.b;
    const h = !!t.h;
    // **수식은 절대 이웃과 합치지 않는다.** 합치면 LaTeX 원문이 옆 글자와
    // 한 문자열이 되어 어디까지가 수식인지 사라진다.
    if (t.m) {
      runs.push({ text: t.ch, b, h, m: t.m });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && !last.m && last.b === b && last.h === h) last.text += t.ch;
    else runs.push({ text: t.ch, b, h });
  }
  return runs;
}
