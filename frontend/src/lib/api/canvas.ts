/**
 * 캔버스 아이템 · 그림 API (D122).
 *
 * 서버는 저장만 한다 — 파싱도 배치도 프론트가 소유한다
 * (근거: backend/app/services/canvas_items.py 모듈 docstring).
 */
import type { CanvasItem, ItemData, ItemKind, ItemSource } from "@/lib/canvas2/types";
import { isRealId } from "@/lib/ids";
import { API_BASE, authHeaders, ensureOk } from "./_core";

/** 서버 행 → 도메인 객체. snake_case 경계를 여기 한 곳에만 둔다. */
interface ItemRow {
  id: string;
  session_id: string;
  node_id: string | null;
  parent_item_id: string | null;
  kind: ItemKind;
  source: ItemSource;
  title: string | null;
  body: string;
  tag: string | null;
  x: number;
  y: number;
  pinned: boolean;
  seq: number;
  data: ItemData | null;
}

export function toItem(row: ItemRow): CanvasItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    parentItemId: row.parent_item_id,
    kind: row.kind,
    source: row.source,
    title: row.title,
    body: row.body ?? "",
    tag: row.tag,
    // 서버는 numeric을 문자열로 줄 수 있다(드라이버에 따라) — 한 번 더 강제한다.
    x: Number(row.x) || 0,
    y: Number(row.y) || 0,
    pinned: !!row.pinned,
    seq: row.seq ?? 0,
    data: row.data ?? {},
  };
}

export interface DrawingScene {
  elements: unknown[];
  files: Record<string, unknown>;
}

/** 카드가 하나도 안 달린 답. 되살릴 것이 있을 때만 채워져 온다. */
export interface OrphanNode {
  id: string;
  answer: string | null;
  created_at?: string;
}

export interface CanvasSnapshot {
  items: CanvasItem[];
  drawing: DrawingScene;
  /**
   * **잃어버린 답** (2026-08-10).
   *
   * 카드는 화면이 스트림을 다 받은 뒤에 저장한다. 그 전에 브라우저가 사라지면
   * 답만 남고 카드가 없다 — 학생 눈에는 답이 통째로 날아간 것이다. 서버가
   * 여기에 실어 주고 화면이 되살린다(`canvas_items._orphan_answers` 머리말).
   */
  orphanNodes: OrphanNode[];
  /**
   * 상단 바에 쓸 대화 제목 (2026-08-10).
   *
   * 이것 하나 때문에 캔버스가 **세션 목록을 통째로** 받고 있었다 — 실측 435건
   * 156KB, 대화가 쌓이는 만큼 계속 는다. 서버는 어차피 세션 행을 확인하러
   * 가므로 제목은 공짜로 딸려 온다.
   */
  sessionTitle: string | null;
}

export async function getCanvas(sessionId: string): Promise<CanvasSnapshot> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/canvas`, {
      headers: await authHeaders(),
    }),
  );
  const body = (await res.json()) as {
    items: ItemRow[];
    drawing: DrawingScene;
    orphan_nodes?: OrphanNode[];
    session_title?: string | null;
  };
  return {
    items: (body.items ?? []).map(toItem),
    drawing: body.drawing ?? { elements: [], files: {} },
    orphanNodes: body.orphan_nodes ?? [],
    sessionTitle: body.session_title ?? null,
  };
}

/** 생성 입력. 클라이언트 전용 필드(_height 등)는 절대 실어 보내지 않는다. */
export interface NewItemInput {
  kind: ItemKind;
  source: ItemSource;
  node_id?: string | null;
  parent_item_id?: string | null;
  title?: string | null;
  body: string;
  tag?: string | null;
  x: number;
  y: number;
  pinned?: boolean;
  seq: number;
  data?: ItemData;
}

export async function createItems(
  sessionId: string,
  items: NewItemInput[],
): Promise<CanvasItem[]> {
  if (!items.length) return [];
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/canvas/items`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ items }),
    }),
  );
  return ((await res.json()) as ItemRow[]).map(toItem);
}

/**
 * 부분 수정.
 *
 * **보내지 않은 키는 서버가 건드리지 않는다**(`exclude_unset`). 그래서 위치만
 * 옮길 때 `{x, y}`만 보내면 된다 — 전체 객체를 보내면 다른 탭/낙관적 갱신과
 * 경쟁하면서 오래된 값으로 덮어쓴다.
 */
export interface ItemPatch {
  x?: number;
  y?: number;
  pinned?: boolean;
  title?: string | null;
  body?: string;
  tag?: string | null;
  seq?: number;
  data?: ItemData;
  parent_item_id?: string | null;
}

export async function patchItem(
  itemId: string,
  patch: ItemPatch,
): Promise<CanvasItem> {
  // D63의 방어선 — 임시 id가 DB 경계로 새면 uuid 파싱 실패로 502가 된다.
  // 여기서 막으면 호출부마다 검사하지 않아도 된다.
  if (!isRealId(itemId)) {
    throw new Error(`저장되지 않은 항목은 수정할 수 없습니다: ${itemId}`);
  }
  if (patch.parent_item_id !== undefined && patch.parent_item_id !== null &&
      !isRealId(patch.parent_item_id)) {
    throw new Error("저장되지 않은 항목을 부모로 지정할 수 없습니다.");
  }
  const res = await ensureOk(
    await fetch(`${API_BASE}/canvas/items/${itemId}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify(patch),
    }),
  );
  return toItem(await res.json());
}

export interface ItemPatchEntry {
  id: string;
  patch: ItemPatch;
}

/**
 * 여러 아이템을 각자 다른 값으로 **한 번에** 수정 (D183).
 *
 * 재배치·가지 이동은 카드 수백 장을 동시에 옮긴다. `patchItem`을 그만큼 부르면
 * 브라우저의 출처당 동시 연결 상한(HTTP/1.1에서 6개쯤)에 걸려 줄을 선다 —
 * 실측 2026-08-06: 지연 0인 로컬에서도 카드 150장에 842ms, 되돌리기에 655ms.
 * 학교 Wi-Fi(RTT 40ms)면 초 단위가 된다.
 *
 * **부분 성공은 409다.** 일부만 저장됐는데 성공으로 받으면 낙관적 화면과 서버가
 * 갈리는데, 그 어긋남은 새로고침해야 드러난다. 호출부는 실패 시 통째로 되돌린다.
 */
export async function patchItems(
  sessionId: string,
  entries: readonly ItemPatchEntry[],
): Promise<CanvasItem[]> {
  if (!entries.length) return [];
  for (const e of entries) {
    // patchItem과 **같은 방어선**이다 — 한쪽만 막으면 그쪽으로 임시 id가 샌다.
    if (!isRealId(e.id)) {
      throw new Error(`저장되지 않은 항목은 수정할 수 없습니다: ${e.id}`);
    }
    const p = e.patch.parent_item_id;
    if (p !== undefined && p !== null && !isRealId(p)) {
      throw new Error("저장되지 않은 항목을 부모로 지정할 수 없습니다.");
    }
  }
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/canvas/items`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify({ items: entries }),
    }),
  );
  return ((await res.json()) as ItemRow[]).map(toItem);
}

export async function deleteItem(itemId: string): Promise<void> {
  if (!isRealId(itemId)) {
    throw new Error(`저장되지 않은 항목은 삭제할 수 없습니다: ${itemId}`);
  }
  await ensureOk(
    await fetch(`${API_BASE}/canvas/items/${itemId}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** 그림 씬 전체 교체. 호출부가 디바운스한다(D122 — 요소 델타는 만들지 않는다). */
export async function putDrawing(
  sessionId: string,
  scene: DrawingScene,
): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/canvas/drawing`, {
      method: "PUT",
      headers: await authHeaders(true),
      body: JSON.stringify(scene),
    }),
  );
}
