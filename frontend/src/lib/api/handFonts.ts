/** 캔버스 손글씨 폰트 관리 (D210 8-1) — 관리자 전용 CRUD + 공개 서빙 주소. */
import { API_BASE, authHeaders, ensureOk } from "./_core";

export interface HandFontRow {
  id: string;
  label: string;
  family: string;
  slug: string;
  format: string;
  size_bytes: number;
  /** 쪼갠 것인가. 거짓이면 통짜라 교실 회선에서 느리다. */
  subset: boolean;
  letter_spacing: number;
  size_scale: number;
  ideograph_scale: number;
  active: boolean;
  created_at: string;
}

/**
 * 미리보기·서빙 주소. **인증이 없다** — `@font-face`의 `src:`는 헤더를 못 싣는다.
 *
 * `full`은 통짜(관리자 시험용), `web`은 쪼갠 것(학생 화면).
 */
export function handFontUrl(slug: string, variant: "web" | "full" = "web"): string {
  return `${API_BASE}/hand-fonts/${slug}/${variant}`;
}

export async function listHandFonts(): Promise<HandFontRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts`, { headers: await authHeaders() }),
  );
  return (await res.json()) as HandFontRow[];
}

export async function uploadHandFont(file: File, label: string): Promise<HandFontRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("label", label);
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts`, {
      method: "POST",
      headers: await authHeaders(),
      body: form,
    }),
  );
  return (await res.json()) as HandFontRow;
}

export async function activateHandFont(id: string): Promise<HandFontRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts/${id}/activate`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
  return (await res.json()) as HandFontRow;
}

/** 기본 폰트로 되돌린다 — **되돌리는 길이 반드시 있어야 한다.** */
export async function resetHandFont(): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts/reset`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

export async function tuneHandFont(
  id: string,
  patch: { letter_spacing?: number; size_scale?: number; ideograph_scale?: number },
): Promise<HandFontRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts/${id}`, {
      method: "PATCH",
      headers: await authHeaders(true),
      body: JSON.stringify(patch),
    }),
  );
  return (await res.json()) as HandFontRow;
}

export async function deleteHandFont(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/hand-fonts/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}
