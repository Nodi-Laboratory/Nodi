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

/**
 * 머리표 없이 온 글을 카드로 살릴 최소 길이(자).
 *
 * 짧은 군더더기("네, 알겠어요")까지 카드로 만들면 캔버스가 지저분해진다.
 * 실측한 누락 답들은 전부 200자를 넘었다 — 40자는 넉넉한 하한이다.
 */
const RECOVER_MIN_CHARS = 40;

/**
 * **말풍선으로만 온 답**을 카드로 살릴 최소 길이(자) — 사용자 보고 2026-08-12.
 *
 * 모델이 `@concept:`을 빠뜨리는 것은 이미 아는 일이고(위 그물), 그래서 개념 밖
 * 줄을 모아 뒀다 살린다. 그런데 **그 줄들이 `CHAT:`을 달고 오면** 여기서 말풍선
 * 으로 흘러가 `orphan`이 빈 채로 끝난다 — 되살릴 것이 없으니 카드가 안 생긴다.
 * 서버 로그에는 `missing_concept_envelope`만 남고(계기판은 정상 작동했다),
 * 학생 화면에는 말풍선 한 덩이만 뜬다. 사용자 눈에는 **"질문했는데 응답이
 * 안 생긴다"**이고, 우리 눈에는 "답은 왔는데"라 서로 다른 것을 보고 있었다.
 *
 * 하한이 orphan(40)보다 높은 이유는 **진짜 말풍선을 지키기 위해서**다. 인사와
 * "자료만 추천한 턴"의 안내는 카드가 되면 안 된다 — 형식이 깨진 게 아니라
 * 의도된 답이다. 값은 그 문구들을 실제로 재서 잡았다: 가장 긴 안내가 55자
 * ("이 대화방에는 찾아볼 교과서·강의 자료가 없어요…"), 인사가 30~55자다.
 * 90자면 그 위로 넉넉히 떠 있으면서, **두세 문장짜리 짧은 설명**도 건진다.
 *
 * 어느 쪽으로 틀릴지도 정해 뒀다 — 애매하면 **살린다.** 말풍선이 카드가 되면
 * 학생이 지우면 그만이지만, 답이 통째로 사라지면 학생은 그런 답이 있었다는
 * 것조차 모른다.
 */
const CHAT_RECOVER_MIN_CHARS = 90;

/** 되살린 카드의 제목으로 쓸 첫 **굵은** 낱말. 없으면 제목 없이 둔다. */
const FIRST_BOLD_RE = /\*\*(.+?)\*\*/;

export function createStreamParser(emit: (ev: StreamEvent) => void): StreamParser {
  let line = "";
  let inConcept = false;
  /** 개념 안에서 아직 본문이 하나도 없는가. 앞쪽 빈 줄을 버리는 데 쓴다. */
  let bodyEmpty = true;
  /** 이 턴에 개념이 한 번이라도 열렸나 (되살리기 판정용). */
  let sawConcept = false;
  /** 개념 밖에서 흘러나온 줄들 — 버리지 않고 모아 둔다. */
  const orphan: string[] = [];
  /**
   * 말풍선으로 보낸 줄들 — **개념이 하나도 안 열렸을 때만** 쓰인다.
   *
   * 말풍선은 그대로 띄우고(여기서 가로채지 않는다), 끝에 가서 카드가 하나도
   * 안 생겼으면 이 글이 마지막 근거가 된다.
   */
  const chat: string[] = [];

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
      const text = trimmed.slice(CHAT_PREFIX.length).trim();
      emit({ t: "reply", text });
      // 말풍선은 말풍선대로 뜬다. 여기 모으는 것은 **끝에 카드가 하나도 안
      // 생겼을 때**의 마지막 근거다(아래 `end`).
      if (text) chat.push(text);
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
      sawConcept = true;
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

    /**
     * ⚠️ **개념 밖의 줄을 버리지 않는다** (2026-08-07 실측).
     *
     * 예전에는 "모델의 군더더기"로 보고 조용히 버렸다. 그런데 모델은
     * `@concept:` 머리표를 **가끔 통째로 빠뜨린다** — 실측 18턴 중 4턴(22%)이
     * 그랬고, 특히 이어 묻는 턴에서 몰려 났다. 그때 답 전체가 이 줄에서
     * 사라졌다: 생성은 됐고 토큰도 다 왔는데 **학생 화면에는 아무것도 안 뜨고**
     * 오류도 로그도 없다. 학생 눈에는 "보냈는데 아무 일도 안 일어남"이다.
     *
     * 모아 뒀다가 `end()`에서 되살린다 — 형식이 깨졌다고 학생의 답을 버리는
     * 것보다, 제목이 없는 카드라도 보여 주는 편이 낫다.
     */
    if (!inConcept) {
      orphan.push(trimmed.replace(END_TAIL_RE, ""));
      return;
    }

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
      /**
       * 머리표 없이 온 답을 카드로 되살린다.
       *
       * **개념이 한 번도 안 열렸을 때만** 한다. 카드 사이의 잡담까지 살리면
       * 한 턴에 카드가 둘 생기고, 그건 "한 턴 한 노드"(D162)를 깬다.
       */
      if (!sawConcept) {
        /**
         * 되살릴 글을 고른다.
         *
         *   1순위 `orphan` — 머리표 없이 그냥 흘러나온 줄들.
         *   2순위 `chat`   — **전부 `CHAT:`을 달고 온 답**(사용자 보고
         *                    2026-08-12). 긴 설명이 통째로 말풍선으로만 오면
         *                    카드가 하나도 안 생긴다.
         *
         * 순서가 있는 이유는 하한이 다르기 때문이다. 말풍선은 **정상적으로도**
         * 쓰이는 형식이라(인사·자료만 추천한 턴의 안내) 훨씬 긴 글일 때만
         * 카드로 본다.
         */
        const orphanText = orphan.join("\n").trim();
        const chatText = chat.join("\n").trim();
        const 살릴것 =
          orphanText.length >= RECOVER_MIN_CHARS
            ? orphan
            : chatText.length >= CHAT_RECOVER_MIN_CHARS
              ? chat
              : null;
        if (살릴것) {
          const text = 살릴것.join("\n").trim();
          // 제목은 첫 굵은 낱말에서 빌린다 — 모델이 개념 이름을 거기 쓴다.
          // 없으면 제목 없이 둔다(메모 카드와 같은 모양이라 화면은 멀쩡하다).
          const title = (text.match(FIRST_BOLD_RE)?.[1] ?? "").trim().slice(0, 40);
          emit({ t: "cstart", title, tag: "" });
          inConcept = true;
          bodyEmpty = true;
          for (const l of 살릴것) appendBody(l);
        }
      }
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
