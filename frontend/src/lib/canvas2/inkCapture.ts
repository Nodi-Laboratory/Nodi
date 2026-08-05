"use client";

/**
 * 표시·카드를 그림 두 장으로 만든다 (D178) — 기하와 렌더와 네트워크를 잇는 곳.
 *
 * `CanvasWorkspace`에 두지 않는 이유는 그 파일이 이미 크기 때문이다. 여기서
 * 하는 일은 넷이고 각각 다른 모듈이 맡는다:
 *
 *   1. 아이템 → SceneCard      (배치 결과 + DOM 실측)
 *   2. 카드 선정·상자          `inkScene`
 *   3. 도판 바이트             `api/ink`
 *   4. 도식 그리기             `inkRender`
 *
 * **DOM을 새로 재지 않는다** — 위치·크기는 배치 훅이 이미 실측해 들고 있다.
 * 예외가 하나 있다: 도판 `<img>`의 자리는 CSS가 정하므로(캡션이 아래 붙는다)
 * 그것만 DOM에서 읽는다. 레이아웃 규칙을 두 곳에서 계산하지 않기 위해서다.
 */

import { fetchFigureBitmap, type InkCardRef } from "@/lib/api/ink";
import { buildInkScene, rectOverlap, type PickedCard, type SceneCard } from "./inkScene";
import { renderFigurePng, renderScenePng } from "./inkRender";
import type { PenStroke } from "./penPad";
import type { Rect } from "./rect";
import type { CanvasItem } from "./types";

export interface InkCaptureOpts {
  cardMax: number;
  nearPad: number;
  boxMaxScale: number;
  sceneMaxSide: number;
  figureZoomEnabled: boolean;
}

export interface InkCapture {
  scene: Blob | null;
  figure: Blob | null;
  figureN: number | null;
  cards: InkCardRef[];
  /** 상한으로 버린 카드 수. 0이 아니면 알린다 — 조용히 자르지 않는다. */
  dropped: number;
}

/** 표시를 못 만들었을 때의 결과. 호출부가 "글자만 보낸다"로 읽는다. */
export const EMPTY_CAPTURE: InkCapture = {
  scene: null,
  figure: null,
  figureN: null,
  cards: [],
  dropped: 0,
};

/**
 * 도판 `<img>`가 실제로 놓인 월드 rect.
 *
 * 카드 rect와 다르다 — 도판 카드는 그림 아래에 캡션·쪽수가 붙어서 그림이
 * 카드의 위쪽 일부만 차지한다. 카드 전체에 그림을 매핑하면 학생이 그린
 * 동그라미가 그림 기준으로 아래로 밀린다.
 *
 * 오버레이는 `scale(zoom)` 안에 있으므로 화면 좌표 차이를 zoom으로 나누면
 * 월드 단위가 된다.
 */
function imageBoxOf(itemId: string, at: Rect, zoom: number): Rect | undefined {
  if (typeof document === "undefined" || !(zoom > 0)) return undefined;
  const root = document.querySelector(`[data-canvas-item="${CSS.escape(itemId)}"]`);
  const img = root?.querySelector("img");
  if (!root || !img) return undefined;
  const rr = root.getBoundingClientRect();
  const ir = img.getBoundingClientRect();
  if (!(ir.width > 0) || !(ir.height > 0)) return undefined;
  return {
    x: at.x + (ir.left - rr.left) / zoom,
    y: at.y + (ir.top - rr.top) / zoom,
    w: ir.width / zoom,
    h: ir.height / zoom,
  };
}

export interface SceneSource {
  items: readonly CanvasItem[];
  /** 배치 결과(월드 좌표). 없는 아이템은 아직 자리를 못 받은 것이라 건너뛴다. */
  positions: ReadonlyMap<string, { x: number; y: number }>;
  /** 실측 크기. */
  sizes: ReadonlyMap<string, { w: number; h: number }>;
  zoom: number;
}

/** 아이템 → 후보 카드. 자리나 크기를 모르는 것은 그릴 수 없으므로 뺀다. */
export function toSceneCards(src: SceneSource): SceneCard[] {
  const out: SceneCard[] = [];
  for (const it of src.items) {
    const p = src.positions.get(it.id);
    const s = src.sizes.get(it.id);
    if (!p || !s) continue;
    const at = { x: p.x, y: p.y, w: s.w, h: s.h };
    const figureId = it.kind === "figure" ? it.data.figure?.figureId : undefined;
    out.push({
      id: it.id,
      kind: it.kind,
      title: it.title,
      body: it.body,
      // **화면에서 보이는 그대로.** 접촉 판정용 여백은 `buildInkScene`이
      // 얹는다 — 여기서 얹으면 도식의 상자가 실제 카드보다 커져서 닿지
      // 않은 획이 닿은 것처럼 그려진다.
      rect: at,
      figureId,
      imageBox: figureId ? imageBoxOf(it.id, at, src.zoom) : undefined,
    });
  }
  return out;
}

/**
 * 표시가 닿은 도판 중 겹침이 가장 큰 하나. 없으면 null.
 *
 * **`imageBox`가 없으면 후보에서 뺀다.** 그 값이 그림 안에서의 좌표 변환
 * 기준인데, 없으면 카드 상자로 대신 매핑하게 되고 그러면 캡션 높이만큼
 * 표시가 밀린 그림을 보낸다 — **틀린 그림은 안 보내는 것만 못하다**(모델은
 * 그것을 사실로 읽는다). 도식(그림 1)에는 여전히 나오므로 맥락은 안 잃는다.
 */
function zoomTarget(cards: readonly PickedCard[], inkBox: Rect): PickedCard | null {
  let best: PickedCard | null = null;
  let bestArea = 0;
  for (const c of cards) {
    if (!c.touched || !c.figureId || !c.imageBox) continue;
    const area = rectOverlap(inkBox, c.imageBox);
    if (area > bestArea) {
      best = c;
      bestArea = area;
    }
  }
  return best;
}

/**
 * 질문 획 + 캔버스 상태 → 보낼 그림들.
 *
 * 카드가 하나도 안 잡히면 **빈 결과**를 준다 — 도식을 보낼 이유가 없고
 * (가리킬 후보가 없다) 그러면 창구가 비전 모델을 아예 안 부른다.
 *
 * 도판 바이트를 못 받아도 계속 간다. 그 카드는 라벨 상자로 그려진다 —
 * 도판 하나 때문에 질문 전체가 막히면 안 된다.
 */
export async function captureInk(
  strokes: readonly PenStroke[],
  src: SceneSource,
  opts: InkCaptureOpts,
): Promise<InkCapture> {
  const scene = buildInkScene(strokes, toSceneCards(src), opts);
  if (!scene || !scene.cards.length) return EMPTY_CAPTURE;

  // 도식에 그릴 도판들을 먼저 받는다. 실패는 null로 남고 라벨 상자가 된다.
  const figureIds = scene.cards
    .map((c) => c.figureId)
    .filter((v): v is string => !!v);
  const bitmaps = new Map<string, ImageBitmap>();
  await Promise.all(
    figureIds.map(async (id) => {
      const bmp = await fetchFigureBitmap(id);
      if (bmp) bitmaps.set(id, bmp);
    }),
  );

  const scenePng = await renderScenePng(scene, strokes, bitmaps, opts.sceneMaxSide);

  let figurePng: Blob | null = null;
  let figureN: number | null = null;
  if (opts.figureZoomEnabled) {
    const target = zoomTarget(scene.cards, scene.inkBox);
    const bmp = target?.figureId ? bitmaps.get(target.figureId) : undefined;
    if (target && bmp) {
      figurePng = await renderFigurePng(target, bmp, strokes, opts.sceneMaxSide);
      if (figurePng) figureN = target.n;
    }
  }

  // 비트맵은 GC가 아니라 우리가 놓는다 — 교과서 도판은 장당 수 MB고, 한 시간
  // 수업이면 같은 학생이 수십 번 인식을 누른다.
  for (const bmp of bitmaps.values()) bmp.close();

  return {
    scene: scenePng,
    figure: figurePng,
    figureN,
    cards: scene.cards.map((c) => ({
      n: c.n,
      itemId: c.id,
      title: c.title ?? "",
    })),
    dropped: scene.dropped,
  };
}
