/**
 * 끊기고 붙는 중인 연결선 하나를 알리는 통로 (D180).
 *
 * ## 왜 dragBus와 따로인가
 *
 * `dragBus`는 "이 아이템들이 이만큼 움직였다"만 나른다. 여기서 나르는 것은
 * **관계의 상태**다 — 지금 무엇에 매여 있고, 얼마나 팽팽하고, 어디에 붙으려
 * 하는지. 둘을 한 통로에 섞으면 아이템을 그냥 옮기는 흔한 경우까지 관계
 * 계산을 지고 다니게 된다.
 *
 * ## 왜 하나뿐인가
 *
 * 한 번에 끌 수 있는 카드는 하나다. 목록으로 두면 "언제 비우나"가 새 문제가
 * 되고, 남은 찌꺼기가 화면에 유령 선으로 남는다 — 이 기능에서 가장 흔한
 * 그래픽 사고가 그것이다.
 *
 * ## 왜 React를 안 거치나
 *
 * 팽팽함은 **매 프레임** 바뀐다. state로 두면 60fps로 아이템 트리와 연결선이
 * 통째로 다시 돈다(D124가 팬에서 겪은 그것). 발신자(아이템 드래그)와
 * 수신자(ConnectorLayer)가 형제라 모듈 전역이 가장 짧은 길이다 — `dragBus`가
 * 같은 이유로 그렇게 돼 있다.
 */

export interface LiveLink {
  /** 끌리는 카드. */
  childId: string;
  /**
   * 지금 선이 향하는 상대.
   *
   *   매여 있을 때  원래 부모 (선이 팽팽해진다)
   *   자석일 때     붙으려는 후보 (예고선)
   *   그 밖         null (선을 안 그린다)
   */
  parentId: string | null;
  /** 0~1. 1에 가까울수록 끊기기 직전이다. */
  strain: number;
  /** 붙을 수 있는 거리인가 — 실선으로 그린다. */
  snapped: boolean;
  /**
   * 방금 끊겼나.
   *
   * **한 프레임만 참이다.** 연출(끊김 섬광)을 트리거하는 신호라 상태가 아니다 —
   * 상태로 두면 다음 프레임에 누가 끄는지가 새 문제가 된다.
   */
  broke: boolean;
}

let live: LiveLink | null = null;

type Listener = (l: LiveLink | null) => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const cb of listeners) cb(live);
}

export function setLiveLink(next: LiveLink): void {
  live = next;
  emit();
}

/** 드래그가 끝났다. 이미 비어 있으면 알리지 않는다(헛된 다시 그리기 방지). */
export function clearLiveLink(): void {
  if (!live) return;
  live = null;
  emit();
}

export function getLiveLink(): LiveLink | null {
  return live;
}

export function subscribeLink(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
