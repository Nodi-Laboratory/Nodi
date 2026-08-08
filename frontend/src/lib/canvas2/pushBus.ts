/**
 * 밀려난 카드의 임시 이동량을 알리는 통로 (D210 4-5).
 *
 * ## 왜 `dragBus`로는 부족한가
 *
 * `dragBus`는 **손에 들린** 카드의 이동량을 나른다. 밀려나는 카드는 손에
 * 들려 있지 않으므로 거기 실리지 않는다. 그래서 연결선과 붙기 예고 테두리가
 * 밀린 카드를 못 따라갔다 — 화면에서는 선이 끊겨 보이고, 점선 상자가 카드와
 * 어긋나 **어디에 붙는지 알 수 없었다**(사용자 보고 2026-08-08).
 *
 * 통로를 하나 더 두는 이유는 두 이동량의 **뜻이 다르기** 때문이다. 손에 들린
 * 것은 곧 그 자리에 놓이고, 밀린 것은 손이 멀어지면 되돌아간다. 합쳐 두면
 * 손을 뗄 때 무엇을 저장할지 가릴 수 없다.
 *
 * 구조는 `dragBus`와 같다 — 발신자(useCardPush)와 수신자(ConnectorLayer)가
 * 형제라 공통 부모를 거치지 않으면 못 만나고, context로 이으면 값이 바뀔
 * 때마다 구독자가 리렌더되어 목적을 잃는다.
 */

export interface PushOffset {
  dx: number;
  dy: number;
}

let offsets: ReadonlyMap<string, PushOffset> = new Map();
type Listener = (o: ReadonlyMap<string, PushOffset>) => void;
const listeners = new Set<Listener>();

export function setPushOffsets(next: ReadonlyMap<string, PushOffset>): void {
  offsets = next;
  for (const cb of listeners) cb(offsets);
}

/** 비어 있으면 알리지 않는다 — 클릭마다 연결선을 헛되이 다시 그리지 않게. */
export function clearPushOffsets(): void {
  if (!offsets.size) return;
  offsets = new Map();
  for (const cb of listeners) cb(offsets);
}

export function getPushOffsets(): ReadonlyMap<string, PushOffset> {
  return offsets;
}

export function subscribePush(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
