/** 세션 선택 화면의 대화방 목록 창구 (D217, 사용자 지시 2026-08-09). */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface RoomRow {
  id: string;
  /** 빈 문자열이면 아직 제목이 없는 방이다 — 화면이 대신 부를 이름을 정한다. */
  title: string;
  updated_at: string | null;
  space_kind: "personal" | "class";
  space_ref: string;
  /** 최근 목록에서만 채워진다(어느 공간의 방인지). */
  space_name: string | null;
  /** 이 방에서 **많이 이야기한 순** 분류. */
  concepts: string[];
}

/** 한 공간의 대화방 — 최근 순. */
export async function getSpaceRooms(
  spaceKind: "personal" | "class",
  spaceRef?: string | null,
): Promise<RoomRow[]> {
  const q = new URLSearchParams({ space_kind: spaceKind });
  if (spaceRef) q.set("space_ref", spaceRef);
  const res = await ensureOk(
    await fetch(`${API_BASE}/spaces/rooms?${q.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** 공간 상관없이 최근에 이야기한 방. */
export async function getRecentRooms(): Promise<RoomRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/spaces/recent`, { headers: await authHeaders() }),
  );
  return res.json();
}
