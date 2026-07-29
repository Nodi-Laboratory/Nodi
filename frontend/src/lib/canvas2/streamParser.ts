/**
 * 스트리밍 증분 파서 v2 — `conceptParser.ts`를 대체한다.
 *
 * ## v1과의 결정적 차이: 본문을 **원문 그대로** 모은다
 *
 * v1은 글자마다 `delta{ch, b, h}` 이벤트를 내고 리듀서가 토큰 배열을 쌓았다.
 * 그래서 마크업이 파싱 시점에 벗겨졌고, 원문은 어디에도 남지 않았다 — 학생이
 * 본문을 수정하려 해도 되돌릴 원본이 없었다.
 *
 * v2는 `body` 문자열 하나를 키운다. 그게 곧 DB에 저장되는 값이고, 렌더는
 * `markup.ts`가 그때그때 한다. 진실이 한 곳이다.
 *
 * ## 형식 (backend/app/services/solar.py와 1:1 계약)
 *
 *     CHAT: 한 문장                  → 말풍선
 *     @concept: 제목 | 분류          → 개념 시작
 *     본문 문단…                     → 본문(빈 줄이 문단 경계)
 *     - 목록 항목                    → 본문(목록)
 *     @related: a, b                 → 관련 개념
 *     @end                           → 개념 끝
 *
 * **구 형식도 그대로 받는다** — 저장된 세션이 전부 `- ` 접두사 형식이다.
 * 본문을 원문으로 모으므로 두 형식을 구분할 필요조차 없다(`markup.ts`가 렌더
 * 시점에 판단한다).
 *
 * ## 실측으로 하드닝된 관용성은 유지한다
 *
 * 모델이 `@end` 대신 `/end`·`[end]`를 쓰고, 심지어 **본문 줄 끝에 붙여** 보내는
 * 일이 실제로 관측됐다(2026-07-27 학생 세션). 못 알아보면 제어 토큰이 학생
 * 화면에 그대로 찍힌다. v1의 두 정규식을 그대로 가져온다.
 */

const CONCEPT_RE = /^@concept:\s*(.*)$/;
const RELATED_RE = /^@related:\s*(.*)$/;
const CHAT_PREFIX = "CHAT:";

/** `@end` / `/end` / `[end]` / `(end)` — 한 줄이 통째로 종료 토큰인 경우. */
const END_LINE_RE = /^[@/\\[(]?end[\])]?$/i;
/**
 * 본문 꼬리에 붙은 종료 토큰. 접두 기호를 **필수**로 둬서 "…the end"처럼
 * end로 끝나는 정상 문장을 잘라먹지 않는다.
 */
const END_TAIL_RE = /\s*[@/\\[(]end[\])]?\s*$/i;

export type StreamEvent =
  | { t: "reply"; text: string }
  | { t: "cstart"; title: string; tag: string }
  | { t: "body"; text: string }
  | { t: "related"; titles: string[] }
  | { t: "cend" }
  | { t: "done" };

export interface StreamParser {
  push(chunk: string): void;
  end(): void;
}

export function createStreamParser(emit: (ev: StreamEvent) => void): StreamParser {
  let line = "";
  let inConcept = false;
  /** 개념 안에서 아직 본문이 하나도 없는가. 앞쪽 빈 줄을 버리는 데 쓴다. */
  let bodyEmpty = true;

  function closeConcept(): void {
    if (!inConcept) return;
    inConcept = false;
    bodyEmpty = true;
    emit({ t: "cend" });
  }

  function appendBody(text: string): void {
    // 개념 시작 직후의 빈 줄은 버린다 — 모델이 `@concept:` 다음에 한 줄 띄우는
    // 일이 흔한데, 그대로 두면 본문이 빈 문단으로 시작한다.
    if (bodyEmpty && !text.trim()) return;
    bodyEmpty = false;
    emit({ t: "body", text });
  }

  function flushLine(): void {
    const raw = line;
    line = "";
    const trimmed = raw.trim();

    if (trimmed.startsWith(CHAT_PREFIX)) {
      emit({ t: "reply", text: trimmed.slice(CHAT_PREFIX.length).trim() });
      return;
    }

    const cm = trimmed.match(CONCEPT_RE);
    if (cm) {
      closeConcept();
      // `|` split의 두 번째가 분류다. 정규식으로 잡으면 개행을 넘어 다음 줄을
      // 삼킨다(D89 하드닝) — 백엔드 extract_used_tags와 같은 규약이다.
      const parts = cm[1].split("|").map((s) => s.trim());
      emit({ t: "cstart", title: parts[0] ?? "", tag: parts[1] ?? "" });
      inConcept = true;
      bodyEmpty = true;
      return;
    }

    if (END_LINE_RE.test(trimmed)) {
      closeConcept();
      return;
    }

    const rm = trimmed.match(RELATED_RE);
    if (rm) {
      const titles = rm[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (inConcept && titles.length) emit({ t: "related", titles });
      return;
    }

    // 개념이 열리기 전의 줄은 조용히 버린다(모델의 군더더기).
    if (!inConcept) return;

    // 꼬리에 붙은 종료 토큰을 떼고, 떼였다면 그 자리가 개념의 끝이다.
    const cleaned = trimmed.replace(END_TAIL_RE, "");
    const hadTail = cleaned !== trimmed;

    // **원문 그대로** 모은다. 마크업도 `- ` 접두사도 벗기지 않는다 —
    // 렌더는 markup.ts가, 저장은 이 문자열이 담당한다.
    appendBody(cleaned);
    if (hadTail) closeConcept();
  }

  return {
    push(chunk: string): void {
      for (const ch of chunk) {
        if (ch === "\n") flushLine();
        else line += ch;
      }
    },
    end(): void {
      flushLine();
      closeConcept();
      emit({ t: "done" });
    },
  };
}

/**
 * 이벤트를 이어붙일 때 쓰는 본문 누적기.
 *
 * 줄 사이에 개행을 넣는 책임을 한 곳에 둔다 — 호출부마다 `+ "\n"`을 하면
 * 문단 경계가 어긋난다(빈 줄이 하나 모자라거나 둘이 된다).
 */
export function appendLine(body: string, line: string): string {
  return body ? `${body}\n${line}` : line;
}
