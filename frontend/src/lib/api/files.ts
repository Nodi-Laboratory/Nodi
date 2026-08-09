/** 파일 업로드·목록·삭제·재처리 + 청크 컨텍스트(RAG). api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type { SpaceTarget } from "./sessions";
import type {
  ChunkContext,
  FileRow,
} from "@/lib/types";

// ── 파일 / RAG (Stage 3b) ────────────────────────────────────────────

/** 멀티파트 업로드. service_role 미설정 시 백엔드 503. (Content-Type 미지정 — FormData가 boundary 설정) */
export async function uploadFile(
  target: SpaceTarget,
  file: File,
  opts?: {
    kind?: string;
    /** D83: 세션 컨텍스트로 연결(user_upload 전용). */
    session_id?: string;
  },
): Promise<FileRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("space_kind", target.space_kind);
  if (target.space_ref) form.append("space_ref", target.space_ref);
  if (opts?.kind) form.append("kind", opts.kind);
  if (opts?.session_id) form.append("session_id", opts.session_id);
  const res = await ensureOk(
    await fetch(`${API_BASE}/files`, {
      method: "POST",
      headers: await authHeaders(), // json=false → Content-Type 없음
      body: form,
    }),
  );
  return res.json();
}

/** D83: 세션 컨텍스트 파일 목록(업로드 순 — 주입 순서와 동일). */
export async function listSessionFiles(sessionId: string): Promise<FileRow[]> {
  const params = new URLSearchParams({ session_id: sessionId });
  const res = await ensureOk(
    await fetch(`${API_BASE}/files?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}


export async function listClassMaterials(classId: string): Promise<FileRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/materials`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function getFile(id: string): Promise<FileRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, { headers: await authHeaders() }),
  );
  return res.json();
}

/** 파일 삭제(3b-3). 204. service_role 미설정 시 503. */
export async function deleteFile(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/** 파일 재처리(3b-3). failed/partial/멈춘 파일. */
export async function retryFile(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/files/${id}/retry`, {
      method: "POST",
      headers: await authHeaders(),
    }),
  );
}

/**
 * D41: RAG 출처 청크의 전문 + 인접 청크(prev/next) + 위치를 조회.
 * 접근 불가/없음이면 404 → ApiError(404).
 */
export async function getChunkContext(
  chunkId: string,
  neighbors = 1,
): Promise<ChunkContext> {
  const params = new URLSearchParams({ neighbors: String(neighbors) });
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/files/chunks/${encodeURIComponent(chunkId)}/context?${params.toString()}`,
      { headers: await authHeaders() },
    ),
  );
  return res.json();
}

