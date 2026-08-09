/**
 * **카드가 없는 답을 카드로 되살린다** (D122 → 2026-08-10 확장).
 *
 * 카드를 만드는 것은 화면이다(D125). 서버는 답을 `nodes`에 적고, 화면이
 * 스트림을 다 받은 **뒤에** `canvas_items`를 저장한다. 그 사이가 비면 답만
 * 남는다. 두 경로가 여기로 온다:
 *
 *   1. **끊긴 턴** — 답을 기다리다 탭을 닫거나, 새로고침하거나, 신호가
 *      끊겼다. 답은 DB에 있는데 캔버스에는 없다. 지도에는 개념이 뜨고 다음
 *      질문의 문맥으로도 쓰이니, 캔버스만 거짓말을 하는 상태다
 *      (실측 2026-08-10: 세 턴이 이 꼴이었다).
 *   2. **v2 이전 세션** — 카드라는 개념 자체가 없던 시절이다. `nodes` 1행이
 *      턴 하나이고 카드는 `answer` 안의 `@concept:` 줄로만 존재했다.
 *
 * 둘은 같은 결함의 두 얼굴이라 **한 길로 고친다.** 서버가 스냅샷에
 * `orphan_nodes`로 실어 주고(`canvas_items._orphan_answers`) 여기서 판다.
 *
 * ## 읽기는 되지만 저장은 아직 아니다
 *
 * 여기서 만든 아이템은 `_legacy: true`다 — **화면에만 있고 서버에는 없다**는
 * 표시다. 화면에는 정상으로 보이고 편집도 되지만 `useCanvasItems`가 PATCH를
 * 건너뛰고, **첫 편집 때 승격**한다. 손대지 않은 턴까지 행을 만들지 않는다.
 */

import { appendLine, createStreamParser } from "./streamParser";
import type { CanvasItem } from "./types";

interface NodeLike {
  id: string;
  answer?: string | null;
  created_at?: string;
}

/**
 * 답 목록 → 아이템. `created_at.asc` 정렬을 전제한다(서버가 그렇게 준다).
 *
 * 스트림 파서를 그대로 재사용한다 — 같은 형식을 읽는 두 번째 구현을 만들면
 * 관용성이 갈린다(v1은 이미 파싱 구현이 셋으로 갈려 있었다).
 */
export function itemsFromAnswers(
  sessionId: string,
  nodes: readonly NodeLike[],
  /**
   * 이 세션에 **이미 저장된 카드 수**. 되살린 카드의 seq가 그 뒤에서 시작한다.
   *
   * 0에서 시작하면 살아남은 카드와 seq가 겹친다 — 순서가 뒤엉키고, 다음 턴의
   * `nextSeq`도 어긋난다. 예전엔 캔버스가 텅 빈 세션에서만 불렸으니 문제가
   * 안 됐지만, 이제는 카드가 있는 세션에도 섞여 들어온다.
   */
  seqBase = 0,
): CanvasItem[] {
  const out: CanvasItem[] = [];

  for (const node of nodes) {
    if (!node.answer) continue;
    let current: CanvasItem | null = null;

    const parser = createStreamParser((ev) => {
      if (ev.t === "cstart") {
        current = {
          // 결정론적 id — 같은 노드를 다시 읽어도 같은 id가 나와야
          // 리액트 키가 안정적이고, 승격 전에 편집해도 어긋나지 않는다.
          id: `legacy-${node.id}-${out.length}`,
          sessionId,
          nodeId: node.id,
          parentItemId: null,
          kind: "concept",
          source: "ai",
          title: ev.title || null,
          body: "",
          tag: ev.tag || null,
          x: 0,
          y: 0,
          pinned: false,
          seq: seqBase + out.length,
          data: {},
          _legacy: true,
        };
        out.push(current);
      } else if (ev.t === "body" && current) {
        current.body = appendLine(current.body, ev.text);
      } else if (ev.t === "cend") {
        current = null;
      }
    });

    parser.push(node.answer);
    parser.end();
  }

  // 본문이 빈 아이템은 버린다 — 모델이 `@concept:`만 뱉고 끊긴 턴이 있다.
  return out.filter((i) => i.body.trim() || i.title);
}
