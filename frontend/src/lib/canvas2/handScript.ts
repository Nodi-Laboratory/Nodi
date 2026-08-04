/**
 * 손글씨 폰트가 못 그리는 글자의 크기를 맞춘다 (D165, studdyai.com 참고).
 *
 * ## 왜 필요한가
 *
 * 캔버스 글은 김주임(`--font-hand`)으로 쓰는데, 이 폰트는 **한글과 아스키만**
 * 덮는다(`hand-font.css`의 unicode-range). 한자·가나·그리스·수학기호는 스택
 * 뒤쪽 폴백으로 떨어져 **손글씨 한가운데 인쇄체가 섞인다.**
 *
 * ## 배율 하나로 고칠 수 있는 건 표의문자뿐이다
 *
 * 실측(캔버스 픽셀, 100px, baseline 위 잉크 높이):
 *
 *     기준 한글 `한글묵`   0.67
 *     한자 `漢字語文`      0.80   → 기준의 1.19배
 *     한자 `山`            0.78   → 1.16배
 *     가나 `あいう`        0.76   → 1.13배
 *
 * 표의문자·가나는 글자마다 em 상자를 꽉 채우는 **단일 지표**라 배율 하나가
 * 그대로 맞는다. 0.86을 곱하면 0.80 → 0.69, 0.76 → 0.65로 기준(0.67)에 든다.
 *
 * 나머지는 **일부러 두었다.** 폴백 폰트는 김주임과 대문자/소문자 비율 자체가
 * 달라(대문자는 1.18배 키워야 하고 소문자는 0.79배 줄여야 한다) 배율 하나로는
 * 못 맞춘다. 실측 오차도 표의문자만큼 크지 않다:
 *
 *     그리스 대문자 ΑΒΓΔΩ  라틴 대문자 대비 0.89배
 *     키릴 АБВ              라틴 대문자 대비 0.92배
 *     수학 ±×÷≈            라틴 대문자 대비 0.92배
 *     ∑∫√ · ₂ · ² · ° · ½  큰 연산자·첨자라 원래 크기가 다르다
 *
 * **작아 보이는 건 커 보이는 것보다 덜 튄다** — 확실한 것만 고치고 나머지는
 * 손대지 않는다. 여기를 다시 건드리려거든 위 실측을 다시 재고 시작할 것.
 *
 * ## 스택이 바뀌면 여기도 바뀐다
 *
 * 손글씨 폰트를 교체하면 (a) 어떤 글자가 폴백으로 떨어지는지와 (b) 배율이
 * 둘 다 달라진다. `hand-font.css`를 다시 만들었으면 이 값도 다시 재야 한다.
 */

/** 크기를 맞출 글자 부류. 지금은 표의문자 계열 하나다. */
export type HandScript = "cjk";

/**
 * 표의문자·가나 범위.
 *
 * 한글 호환 자모(U+3131–U+3163)는 김주임이 덮으므로 **들어오면 안 된다** —
 * 다행히 어느 범위와도 겹치지 않는다.
 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x309f], // 히라가나
  [0x30a0, 0x30ff], // 가타카나
  [0x31f0, 0x31ff], // 가타카나 확장
  [0x3400, 0x4dbf], // CJK 확장 A
  [0x4e00, 0x9fff], // CJK 통합 한자
  [0xf900, 0xfaff], // CJK 호환 한자
  [0x20000, 0x2fa1f], // CJK 확장 B~ (서로게이트 쌍)
];

/** 이 코드포인트가 크기 보정 대상인가. 아니면 null. */
export function tuneOf(cp: number): HandScript | null {
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return "cjk";
  }
  return null;
}

/** 같은 부류가 이어지는 구간. */
export interface ScriptSeg {
  text: string;
  /** null이면 손대지 않는다(대부분의 글). */
  script: HandScript | null;
  /**
   * 원문에서 이 구간이 시작하는 오프셋(코드 유닛). 렌더의 key로 쓴다.
   *
   * 여기서 세어 주는 이유는 호출부가 렌더 중에 누산기를 굴리지 않게 하기
   * 위해서다 — React Compiler가 렌더 뒤 변수 재대입을 에러로 막는다.
   */
  at: number;
}

/**
 * 문자열을 부류가 같은 구간으로 나눈다.
 *
 * 보정할 글자가 하나도 없으면 **구간 하나**를 돌려준다 — 한국어 문장이 거의
 * 전부 이 경우라, 호출부는 이걸 보고 `<span>`을 더 만들지 않고 넘어간다.
 *
 * 서로게이트 쌍(CJK 확장 B)은 코드포인트 단위로 읽어 반쪽으로 갈리지 않게 한다.
 */
export function toScriptSegs(text: string): ScriptSeg[] {
  const out: ScriptSeg[] = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const script = tuneOf(cp);
    const last = out[out.length - 1];
    if (last && last.script === script) last.text += text.slice(i, i + len);
    else out.push({ text: text.slice(i, i + len), script, at: i });
    i += len;
  }
  return out;
}
