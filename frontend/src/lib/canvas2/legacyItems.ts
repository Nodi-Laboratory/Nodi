/**
 * 구 세션 폴백 — `nodes.answer`를 파싱해 캔버스 아이템으로 (D122).
 *
 * v1은 개념 카드를 DB에 저장하지 않았다. `nodes` 1행 = 턴 1개이고 카드는
 * `answer` 텍스트 안의 `@concept:` 줄 형식으로만 존재했다. 그래서 v2 이전에
 * 만들어진 세션에는 `canvas_items`가 **한 행도 없다.**
 *
 * 폴백이 없으면 학생이 지난 대화를 열었을 때 **빈 캔버스**를 본다. 대화는
 * 멀쩡히 남아 있는데 화면에서만 사라진 것이라, 데이터가 날아간 것처럼 보인다.
 *
 * ## 읽기는 되지만 저장은 아직 아니다
 *
 * 여기서 만든 아이템은 `_legacy: true`다. 화면에는 정상으로 보이고 편집도
 * 되지만, 서버에는 아직 없다 — `useCanvasItems`가 `_legacy` 아이템의 PATCH를
 * 건너뛴다. **첫 편집 시점에 승격**하는 것이 자연스러운 마이그레이션이다
 * (전 세션을 한 번에 옮기면 안 쓰는 세션까지 행을 만든다).
 */

import { appendLine, createStreamParser } from "./streamParser";
import type { CanvasItem } from "./types";

interface NodeLike {
  id: string;
  answer?: string | null;
  created_at?: string;
}

/**
 * 노드 목록 → 아이템. `created_at.asc` 정렬을 전제한다(서버가 그렇게 준다).
 *
 * 파서를 그대로 재사용한다 — 구 형식을 읽는 두 번째 구현을 만들면 관용성이
 * 갈린다(v1은 이미 파싱 구현이 셋으로 갈려 있었다).
 */
export function itemsFromNodes(
  sessionId: string,
  nodes: readonly NodeLike[],
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
          seq: out.length,
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
