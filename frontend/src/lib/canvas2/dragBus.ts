/**
 * 드래그 중인 아이템의 임시 이동량을 알리는 통로.
 *
 * ## 왜 필요한가
 *
 * 아이템은 드래그 중 **React를 거치지 않고** DOM transform으로 움직인다
 * (`TextItem`). 60fps로 setState하면 긴 문단에서 즉시 버벅이기 때문이다.
 * 그런데 연결선은 별도 SVG라 그 움직임을 알 길이 없어서, 질문과 답을 함께
 * 끌면 **상자만 가고 선은 제자리에 남았다**(사용자 지적).
 *
 * 선을 React state로 따라가게 하면 드래그 성능을 되돌리는 셈이다. 그래서
 * 이 통로로 이동량만 흘려 보내고, `ConnectorLayer`가 자기 SVG 속성을 직접
 * 고친다 — 양쪽 다 React 밖에 머문다.
 *
 * ## 왜 모듈 전역인가
 *
 * 발신자(TextItem)와 수신자(ConnectorLayer)는 형제라서 공통 부모를 거치지
 * 않으면 못 만난다. context로 잇는 방법도 있지만 그러면 값이 바뀔 때마다
 * 구독자가 리렌더되어 목적을 잃는다. 한 화면에 캔버스는 하나뿐이므로 전역
 * 하나로 충분하다.
 */

export interface DragOffset {
  dx: number;
  dy: number;
}

/** 지금 끌리는 중인 아이템들의 이동량(world). 비어 있으면 드래그가 아니다. */
let offsets: ReadonlyMap<string, DragOffset> = new Map();

type Listener = (o: ReadonlyMap<string, DragOffset>) => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const cb of listeners) cb(offsets);
}

/** 같은 이동량을 여러 아이템에 건다(함께 끌기). */
export function setDragOffsets(ids: readonly string[], dx: number, dy: number): void {
  const next = new Map<string, DragOffset>();
  for (const id of ids) next.set(id, { dx, dy });
  offsets = next;
  emit();
}

/**
 * 드래그가 끝났음을 알린다.
 *
 * 이미 비어 있으면 알리지 않는다 — 클릭(움직이지 않은 드래그)마다 연결선을
 * 헛되이 다시 그리지 않게 한다.
 */
export function clearDragOffsets(): void {
  if (!offsets.size) return;
  offsets = new Map();
  emit();
}

export function getDragOffsets(): ReadonlyMap<string, DragOffset> {
  return offsets;
}

export function subscribeDrag(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
