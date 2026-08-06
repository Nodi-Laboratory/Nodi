/**
 * 질문 방향성 코치 — 언제 말을 걸지 (D194).
 *
 * ## 왜 만드나
 *
 * 사용자 인터뷰에서 나온 공통 문제가 **"스스로 질문하기"가 안 된다**는 것이다.
 * 그런데 예상 질문을 보여 주면 학생은 그걸 베낀다 — 베낀 질문은 자기 질문이
 * 아니라서 이 문제를 하나도 안 푼다.
 *
 * 그래서 **방향만** 말한다. "비교하는 질문을 해 보라"까지가 우리 몫이고,
 * 무엇을 어떻게 비교할지는 학생이 정한다.
 *
 * D138이 조사해 둔 결론과 같은 자리다: 학습 이득은 캔버스 자체가 아니라
 * **인출·구성 행위**에서 온다(Chi & Wylie의 Constructive 등급). 드래그·태그는
 * Active에 머문다. 이 기능은 그 위로 올리려는 첫 장치이고, D138이 다음 후보로
 * 적어 둔 "학생이 먼저 쓰게 하기"의 한 형태다.
 *
 * ## 이 파일이 정하는 것
 *
 * **말을 걸 때인가**만 정한다. 무슨 말을 할지는 서버가 LLM으로 정하고
 * (`services/question_coach.py`), 어떻게 보일지는 컴포넌트가 정한다.
 * 발동 규칙은 눈으로 못 잡는다 — 안 떠도 화면은 멀쩡하고, 잘못 떠도 그럴싸하다.
 */

export interface CoachItem {
  id: string;
  parentItemId: string | null;
  kind: string;
  source: string;
  seq: number;
}

/** 기본 n. 관리자가 콘솔에서 바꾼다. */
export const DEFAULT_MIN_CARDS = 3;

/**
 * 다시 말을 걸기까지 더 필요한 카드 수 (n + REARM_GAP).
 *
 * 사용자 지시: "n + 3개의 직계 자식 카드가 추가로 생성된 후에는 다시 작동".
 * 한 브랜치에서 계속 말을 걸면 권유가 아니라 잔소리가 된다.
 *
 * ⚠️ **관리자 콘솔이 이 수를 보여 준다** — 서버가 노브 옆에 "재발동까지 n+3장"을
 * 붙여 내려보내고(`services/question_coach.py`의 같은 이름 상수 → admin_console의
 * `derived`), 판정은 여기서만 한다. 한쪽만 고치면 **콘솔이 거짓말을 한다**:
 * 화면에도 로그에도 안 드러나고, 관리자는 안 뜨는 이유를 다른 데서 찾게 된다.
 */
export const REARM_GAP = 3;

/**
 * 이 카드의 **조상 사슬** — 뿌리부터 자기까지.
 *
 * "브랜치"를 이렇게 읽는다: 학생이 이어 물어 온 하나의 줄기. 트리 전체가
 * 아니라 이 줄기가 판정 단위다 — 옆 가지에서 몇 개를 물었든 이 줄기의
 * 방향성과는 상관이 없다.
 *
 * 순환은 `seen`이 막는다. 데이터가 꼬여도 화면이 멈추면 안 된다(D151 동형).
 */
export function chainOf(
  items: readonly CoachItem[],
  id: string,
): CoachItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: CoachItem[] = [];
  const seen = new Set<string>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentItemId ? byId.get(cur.parentItemId) : undefined;
  }
  return out.reverse();
}

/** 이 사슬에서 코치가 마지막으로 말을 건 깊이. 없으면 null. */
function lastSpokeDepth(chain: readonly CoachItem[], spokenAt: ReadonlySet<string>): number | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (spokenAt.has(chain[i].id)) return i + 1; // 깊이는 1부터 센다
  }
  return null;
}

export interface CoachDecision {
  /** 지금 말을 걸까. */
  should: boolean;
  /** 사슬 깊이(카드 수) — 진단·테스트용. */
  depth: number;
  /** 안 거는 이유. 화면에는 안 쓰지만 왜 조용한지 설명할 수 있어야 한다. */
  reason: "ok" | "too-shallow" | "already-spoke" | "not-a-tree-node";
}

/**
 * 지금 만들어진 카드에 말을 걸까 (D194).
 *
 * ```
 * 사슬이 n+1에 못 미친다        → 아직 (방향성을 볼 만큼 안 쌓였다)
 * 이 사슬에서 이미 말을 걸었다  → 그 뒤로 n+3만큼 더 깊어졌을 때만 다시
 * 그 밖                          → 건다
 * ```
 *
 * **한 번 건 자리(`spokenAt`)를 사슬에서 되짚는다.** "이 브랜치에서 걸었나"를
 * 따로 저장하지 않는 이유: 브랜치는 id가 없는 개념이라(카드들의 줄기일 뿐)
 * 이름을 붙이는 순간 카드가 옮겨지거나 떼어질 때(D180) 어긋난다. 말을 건 **카드**를
 * 기억하면 그 카드가 살아 있는 한 사슬을 따라 자연히 찾아진다.
 *
 * @param spokenAt 코치가 말을 건 적 있는 카드 id들(중단한 경우도 포함 —
 *                 중단도 "이 브랜치는 봤다"이므로 바로 다시 묻지 않는다).
 */
export function decideCoach(
  items: readonly CoachItem[],
  newCardId: string,
  minCards: number,
  spokenAt: ReadonlySet<string>,
): CoachDecision {
  const chain = chainOf(items, newCardId);
  const depth = chain.length;
  const head = chain[chain.length - 1];
  // AI 개념 카드만 트리 노드다(D151) — 메모·도판·클립은 줄기가 아니다.
  if (!head || head.kind !== "concept" || head.source !== "ai") {
    return { should: false, depth, reason: "not-a-tree-node" };
  }
  const n = Math.max(1, minCards);
  if (depth < n + 1) return { should: false, depth, reason: "too-shallow" };

  const spoke = lastSpokeDepth(chain, spokenAt);
  if (spoke !== null && depth < spoke + n + REARM_GAP) {
    return { should: false, depth, reason: "already-spoke" };
  }
  return { should: true, depth, reason: "ok" };
}


/**
 * 모델에게 보낼 카드 id들 — 뿌리부터 이 카드까지, 순서대로.
 *
 * 사슬 전체를 보낸다(사용자 지시: "n+1번째 카드까지 포함한 내용"). 뒤에서
 * 몇 장만 자르면 앞에서 이미 물은 방향이 안 보여서, 모델이 **정의를 또**
 * 권하게 된다.
 */
export function chainForCoach(items: readonly CoachItem[], id: string): string[] {
  return chainOf(items, id).map((c) => c.id);
}
