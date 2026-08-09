/** 세션 선택 화면이 쓰는 창구 (사용자 지시 2026-08-09). */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface SpaceOverview {
  space_kind: "personal" | "class";
  space_ref: string;
  name: string;
  role_in_class: string | null;
  /** 이 공간의 대화방 수. */
  sessions: number;
  /** 선생님이 올린 자료·교과서 수 (개인 공간은 0). */
  materials: number;
  /** 연결된 EBS 강의 수 (개인 공간은 0). */
  lectures: number;
  /** 많이 이야기한 순 분류 이름. 화면이 상자 크기에 맞춰 잘라 쓴다. */
  concepts: string[];
  /** 학급 프로필 사진이 있나. 없으면 화면이 머리글자로 대신한다. */
  has_avatar: boolean;
}

export async function getSpacesOverview(): Promise<SpaceOverview[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/spaces/overview`, { headers: await authHeaders() }),
  );
  return (await res.json()) as SpaceOverview[];
}

/**
 * 학급 프로필 사진 주소.
 *
 * ⚠️ `<img src>`는 Authorization 헤더를 못 싣는다. 이 창구가 쿠키 세션으로도
 * 통하는 이유가 그것이다 — 배포·로컬 모두 페이지와 **같은 출처**(`/api`)라
 * 브라우저가 자격을 알아서 싣는다.
 */
export function classAvatarUrl(classId: string): string {
  return `${API_BASE}/spaces/classes/${classId}/avatar`;
}

/** 학급 프로필 사진 올리기. **그 학급의 선생님만** 된다(서버가 판정). */
export async function putClassAvatar(classId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  await ensureOk(
    await fetch(`${API_BASE}/spaces/classes/${classId}/avatar`, {
      method: "PUT",
      headers: await authHeaders(),
      body: form,
    }),
  );
}
