/**
 * 질문 필기를 **기존 펜(Excalidraw 자유선)으로 받는다** (D176).
 *
 * ## 왜 우리 캔버스를 버렸나
 *
 * 처음에는 투명한 캔버스를 얹고 포인터를 직접 받아 그렸다. 기하도 손날 판정도
 * 다 갖췄는데 **획과 획 사이가 끊겨 보였다**(사용자 보고 2026-08-04: "다음
 * 획마다 끊긴다. 하지만 기존 펜은 자연스럽게 써진다").
 *
 * 이미 자연스럽게 써지는 것이 같은 화면에 있는데 그걸 두고 흉내를 고치는 것은
 * 순서가 틀렸다. 질문하는 펜은 **자유선 도구를 물려 쓴다** — 형광펜이 그러는
 * 것과 같은 방식이다(D150). 우리가 하는 일은 그 획을 **글자로 바꾸는 것**뿐이다.
 *
 * ## 질문 획과 그림 획은 **획 자신이** 구분한다
 *
 * (사용자 지시 2026-08-05: "글자인식 펜과 일반 펜의 획은 구분되어야 한다".)
 *
 * 처음에는 **시점**으로 갈랐다 — 도구를 켠 순간의 id를 적어 두고 그 뒤에 생긴
 * 자유선을 질문으로 봤다. 그런데 도구를 잠깐 다른 것으로 바꿨다 돌아오면
 * 기준선이 새로 찍혀 **앞서 쓴 질문 획이 영영 미아가 된다** — 인식도 안 되고
 * 지워지지도 않은 채 캔버스에 남는다.
 *
 * 그래서 획에 표시를 남긴다(`customData.nodiAsk`). Excalidraw가 요소와 함께
 * 저장·복원하므로 도구를 오가든 새로고침을 하든 **질문 획은 계속 질문 획이다.**
 * 판정이 시간이 아니라 데이터에 있다.
 *
 * ## 이 파일은 순수 함수만 둔다
 *
 * Excalidraw 요소가 들어오고 획·경계·id가 나간다. 좌표 변환이 틀려도 화면에는
 * 그럴싸한 그림이 나오므로 눈으로는 못 잡는다.
 */

import { NO_PRESSURE } from "./penPad";
import type { PenStroke } from "./penPad";

/** 질문 획 표시. Excalidraw의 `customData`에 얹는다(요소와 함께 저장된다). */
export const ASK_MARK = "nodiAsk";

/** 여기서 필요한 최소한의 요소 모양. */
export interface SceneStroke {
  id: string;
  type?: string;
  x: number;
  y: number;
  isDeleted?: boolean;
  points?: readonly (readonly number[])[];
  pressures?: readonly number[];
  customData?: Record<string, unknown> | null;
}

/** 살아 있는 자유선인가. 지운 것(`isDeleted`)은 배열에 남으므로 함께 거른다. */
function liveStroke(e: Pick<SceneStroke, "type" | "isDeleted">): boolean {
  return e.type === "freedraw" && !e.isDeleted;
}

/** 질문하는 펜으로 쓴 획인가. */
export function isAskStroke<T extends Pick<SceneStroke, "type" | "isDeleted" | "customData">>(
  e: T,
): boolean {
  return liveStroke(e) && e.customData?.[ASK_MARK] === true;
}

/** 캔버스에 남아 있는 질문 획 전부 — **시점과 무관하게.** */
export function askStrokes<
  T extends Pick<SceneStroke, "type" | "isDeleted" | "customData">,
>(elements: readonly T[]): T[] {
  return elements.filter(isAskStroke);
}

/**
 * **아직 표시를 못 받은 질문 획** — 질문하는 펜을 켠 뒤 그은 것들.
 *
 * 표시를 찍는 일은 **그리는 중에 하면 안 된다.** Excalidraw의
 * `updateScene({elements})`는 `replaceAllElements`라, 공식 문서가 드래그·리사이즈
 * 중에는 쓰지 말라고 명시한다 — 실제로 그리던 획이 끊긴다(사용자 보고
 * 2026-08-05: "글자인식 펜이 작성되지 않는다").
 *
 * 그래서 그리는 동안에는 **세기만** 하고, 표시는 도구를 바꾸거나 인식할 때
 * (둘 다 획이 끝난 뒤의 discrete한 순간) 한 번에 찍는다.
 *
 * `baseline`은 펜을 켠 순간 있던 id들 — 그 전에 일반 펜으로 그린 그림에 표시가
 * 번지는 것을 막는다.
 */
export function pendingStrokes<
  T extends Pick<SceneStroke, "id" | "type" | "isDeleted" | "customData">,
>(elements: readonly T[], baseline: ReadonlySet<string>): T[] {
  return elements.filter(
    (e) =>
      liveStroke(e) && e.customData?.[ASK_MARK] !== true && !baseline.has(e.id),
  );
}

/**
 * 지금 질문으로 볼 획 전부 — 이미 표시된 것 + 방금 그은 것.
 *
 * 화면(버튼 활성·개수)과 인식이 같은 목록을 본다. 둘이 갈리면 "버튼은 켜졌는데
 * 아무것도 안 보내진다"가 된다.
 */
export function allAskStrokes<
  T extends Pick<SceneStroke, "id" | "type" | "isDeleted" | "customData">,
>(elements: readonly T[], baseline: ReadonlySet<string>): T[] {
  return elements.filter(
    (e) => isAskStroke(e) || (liveStroke(e) && !baseline.has(e.id) && e.customData?.[ASK_MARK] !== true),
  );
}

/** 표시를 찍은 사본. 원본을 고치지 않는다(Excalidraw가 불변 요소를 기대한다). */
export function markAsk<T extends SceneStroke>(el: T): T {
  return { ...el, customData: { ...(el.customData ?? {}), [ASK_MARK]: true } };
}

/**
 * 자유선 요소 → 우리 획.
 *
 * Excalidraw의 `points`는 **요소 원점 기준 상대 좌표**다. 절대 좌표로 펴야
 * 여러 요소가 한 종이 위에 제자리로 모인다 — 안 그러면 모든 글자가 왼쪽 위에
 * 겹쳐 쌓인다.
 *
 * 필압은 있으면 쓰고(자유선은 `pressures`를 따로 들고 있다) 없으면 기본값.
 */
export function toStrokes(elements: readonly SceneStroke[]): PenStroke[] {
  const out: PenStroke[] = [];
  for (const el of elements) {
    const pts = el.points ?? [];
    if (!pts.length) continue;
    const stroke: PenStroke = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.length < 2) continue;
      const pressure = el.pressures?.[i];
      stroke.push({
        x: el.x + p[0],
        y: el.y + p[1],
        p: typeof pressure === "number" && pressure > 0 ? pressure : NO_PRESSURE,
      });
    }
    if (stroke.length) out.push(stroke);
  }
  return out;
}

/** 두 점으로 나타낸 사각형. */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * 질문 획 전체를 감싸는 사각형 — **min(x,y)와 max(x,y)** (사용자 지시 2026-08-05).
 *
 * 획이 없으면 null. 점 하나짜리 획(톡 찍은 꼭지)도 센다 — 그것도 글자의 일부다.
 */
export function strokesBBox(strokes: readonly PenStroke[]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * 두 점을 **네 점으로 펴** 사각형을 만든다 (사용자 지시 2026-08-05).
 *
 * 좌상 → 우상 → 우하 → 좌하 순서. OCR로 보내는 그림이 이 사각형이다.
 */
export function bboxCorners(b: BBox): ReadonlyArray<readonly [number, number]> {
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
}

/**
 * 질문 필기를 씬에서 뺀 나머지.
 *
 * **지우지 않고 걸러 낸다** — `isDeleted`로 표시하면 Excalidraw가 배열에
 * 남겨 두고, 다음에 다시 질문 획으로 잡힌다.
 */
export function withoutStrokes<T extends Pick<SceneStroke, "id">>(
  elements: readonly T[],
  remove: ReadonlySet<string>,
): T[] {
  return elements.filter((e) => !remove.has(e.id));
}
