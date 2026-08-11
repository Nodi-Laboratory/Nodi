/**
 * 관리자 콘솔에서 **답변을 사람이 읽는 모습으로** 편다 (2026-08-10).
 *
 * ## 무엇이 문제였나
 *
 * `ai_logs.answer`에는 **전선 위 원문**이 그대로 들어간다:
 *
 *     CHAT: 무지개는 햇빛과 물방울이 만나 만들어 내는 …
 *
 *     @concept: 무지개 | 빛의 분산과 굴절
 *     무지개는 **햇빛**이 공기 중의 …
 *
 * 학생 화면은 이걸 파싱해 말풍선 하나와 개념 카드 몇 장으로 나눠 그리는데,
 * 관리자 콘솔은 **문자열을 그대로** 박스에 넣었다. 그래서 운영자 눈에는
 * `CHAT:`이나 `@concept: … | …` 같은 것이 답변에 섞여 들어간 것으로 보인다
 * (사용자 보고 2026-08-10: "응답 박스에 이상하게 다른 내용이 들어간다").
 *
 * 답이 이상한 것이 아니라 **보여 주는 방식이 이상했던 것**이다. 그 둘은
 * 고치는 곳이 다르다 — 원문은 정본이라 그대로 두고, 화면만 편다.
 *
 * ## 파서를 새로 만들지 않는다
 *
 * 이 형식을 읽는 구현이 이미 셋이다(`streamParser.ts` ·
 * `solar.extract_used_tags` · `ai.skills.concepts._parse_cards`). 넷째를 만들면
 * 관용도가 갈리고, 그 어긋남은 **화면에서 그럴싸하게 보인다**(저장소 불변식).
 * 그래서 학생 화면이 쓰는 바로 그 파서를 재사용한다.
 */

import { appendLine, createStreamParser } from "@/lib/canvas2/streamParser";

export interface ReadableCard {
  title: string;
  tag: string;
  body: string;
}

export interface ReadableAnswer {
  /** 말풍선 — 카드 밖에서 학생에게 건넨 말. */
  reply: string;
  /** 개념 카드. 캔버스에 놓이는 것들이다. */
  cards: ReadableCard[];
  /** 파서가 어느 쪽으로도 못 보낸 나머지. 보통 빈 문자열이다. */
  rest: string;
}

/**
 * 원문 → 말풍선 + 카드.
 *
 * 빈 입력이나 형식이 어긋난 입력도 던지지 않는다 — 관리자 콘솔은 **무엇이
 * 잘못됐는지 보러 오는 곳**이라, 여기서 예외가 나면 정작 봐야 할 화면이 안 뜬다.
 */
export function readAnswer(raw: string | null | undefined): ReadableAnswer {
  const text = (raw ?? "").trim();
  if (!text) return { reply: "", cards: [], rest: "" };

  const cards: ReadableCard[] = [];
  let reply = "";
  let current: ReadableCard | null = null;

  try {
    const parser = createStreamParser((ev) => {
      switch (ev.t) {
        case "reply":
          reply = ev.text;
          break;
        case "cstart":
          current = { title: ev.title, tag: ev.tag, body: "" };
          cards.push(current);
          break;
        case "body":
          if (current) current.body = appendLine(current.body, ev.text);
          break;
        case "cend":
          current = null;
          break;
        default:
          break;
      }
    });
    parser.push(text);
    parser.end();
  } catch {
    // 파싱이 깨져도 원문은 보여 준다 — 못 읽는 것보다 낫다.
    return { reply: "", cards: [], rest: text };
  }

  // 말풍선도 카드도 안 나왔으면 형식이 아예 다른 답이다. 통째로 넘긴다.
  if (!reply && cards.length === 0) return { reply: "", cards: [], rest: text };
  return { reply, cards, rest: "" };
}
