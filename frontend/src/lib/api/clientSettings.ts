/**
 * 캔버스 화면 동작 값 (D174).
 *
 * 이 값들은 원래 프론트에 상수로 박혀 있었다 — 관리자가 아무것도 못 만졌다.
 * 이제 서버가 갖고 `/auth/settings/client`로 내려보낸다.
 *
 * **기본값을 여기에도 둔다.** 서버를 못 부르면 캔버스가 아예 안 뜨는 것보다
 * 예전과 같은 값으로 도는 편이 낫다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface ClientSettings {
  /** 한 턴에 만들 개념 카드 수 (D162). */
  cardsPerTurn: number;
  /** 글자가 나오는 속도(프레임당 글자 수). */
  typeCharsPerFrame: number;
  /** 새 카드로 확대할 배율 **상한** (D166). */
  focusZoom: number;
  /** 지도에서 노드·간선이 보이기 시작하는 배율. */
  mapNodeZoom: number;
  /** 캔버스 연결선 기본 표시 (D151). */
  connectorsDefaultOn: boolean;
  colGap: number;
  rowGap: number;
  sibGap: number;
}

export const CLIENT_SETTINGS_FALLBACK: ClientSettings = {
  cardsPerTurn: 1,
  typeCharsPerFrame: 2,
  focusZoom: 2.35,
  mapNodeZoom: 1.8,
  connectorsDefaultOn: true,
  colGap: 760,
  rowGap: 240,
  sibGap: 200,
};

interface Row {
  canvas_cards_per_turn?: number;
  canvas_type_chars_per_frame?: number;
  canvas_focus_zoom?: number;
  canvas_map_node_zoom?: number;
  canvas_connectors_default_on?: boolean;
  canvas_col_gap?: number;
  canvas_row_gap?: number;
  canvas_sib_gap?: number;
}

/** snake_case 경계를 여기 한 곳에만 둔다(다른 api 모듈과 같은 규약). */
function toSettings(row: Row): ClientSettings {
  const f = CLIENT_SETTINGS_FALLBACK;
  return {
    cardsPerTurn: row.canvas_cards_per_turn ?? f.cardsPerTurn,
    typeCharsPerFrame: row.canvas_type_chars_per_frame ?? f.typeCharsPerFrame,
    focusZoom: row.canvas_focus_zoom ?? f.focusZoom,
    mapNodeZoom: row.canvas_map_node_zoom ?? f.mapNodeZoom,
    connectorsDefaultOn:
      row.canvas_connectors_default_on ?? f.connectorsDefaultOn,
    colGap: row.canvas_col_gap ?? f.colGap,
    rowGap: row.canvas_row_gap ?? f.rowGap,
    sibGap: row.canvas_sib_gap ?? f.sibGap,
  };
}

export async function getClientSettings(): Promise<ClientSettings> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/auth/settings/client`, {
      headers: await authHeaders(),
    }),
  );
  return toSettings((await res.json()) as Row);
}
