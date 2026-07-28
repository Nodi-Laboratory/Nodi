/**
 * 관리자 — 사용자·설정·로그·관측 (D102 분리, D113 확장).
 *
 * D113에서 콘솔이 서비스 전체를 보는 창구가 됐다: 개요·AI 흐름·스킬·대화·
 * 문서 인제스트·RAG 테스트. 모든 경로가 admin 전용이며 비관리자는 403이다
 * (백엔드 require_admin + RLS 정책 + RPC 내부 is_admin 3중).
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type {
  AdminClass,
  AdminConversationDetail,
  AdminConversationsResponse,
  AdminDocumentDetail,
  AdminDocumentsResponse,
  AdminFlow,
  AdminLogDetail,
  AdminLogsResponse,
  AdminOverview,
  AdminSetting,
  AdminSettingsView,
  AdminSkillsResponse,
  AdminUser,
  Profile,
  RagTestResult,
  UserRole,
} from "@/lib/types";

async function getJson<T>(path: string): Promise<T> {
  const res = await ensureOk(
    await fetch(`${API_BASE}${path}`, { headers: await authHeaders() }),
  );
  return res.json();
}

// ── 관리자 (Stage 4c, 관리자만) ──────────────────────────────────────

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users`, { headers: await authHeaders() }),
  );
  return res.json();
}

export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<Profile> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ role }),
    }),
  );
  return res.json();
}

/** D113: 현재값뿐 아니라 기본값·변경여부·위젯 스펙까지 서버가 준다. */
export async function listAdminSettings(): Promise<AdminSettingsView> {
  return getJson<AdminSettingsView>("/admin/settings");
}

/** D113: 코드 기본값으로 되돌린다(행을 지우지 않는다 — 지우면 노브가 사라진다). */
export async function resetAdminSetting(key: string): Promise<AdminSetting> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/admin/settings/${encodeURIComponent(key)}/reset`,
      { method: "POST", headers: await authHeaders(true) },
    ),
  );
  return res.json();
}

export async function putAdminSetting(
  key: string,
  value: unknown,
): Promise<AdminSetting> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: await authHeaders(true),
      body: JSON.stringify({ value }),
    }),
  );
  return res.json();
}

export async function getAdminLogs(opts: {
  userId?: string | null;
  since?: string | null;
  until?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminLogsResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.since) params.set("since", opts.since);
  if (opts.until) params.set("until", opts.until);
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/** D34: 턴 상세 — ai_logs 1행(구조화 contexts). */
export async function getAdminLogDetail(logId: string): Promise<AdminLogDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs/${encodeURIComponent(logId)}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

// ── D113: 관측 · 흐름 · 대화 · 문서 · RAG 테스트 ─────────────────────

export async function getAdminOverview(): Promise<AdminOverview> {
  return getJson<AdminOverview>("/admin/overview");
}

export async function getAdminFlow(): Promise<AdminFlow> {
  return getJson<AdminFlow>("/admin/flow");
}

export async function getAdminSkills(days = 30): Promise<AdminSkillsResponse> {
  return getJson<AdminSkillsResponse>(`/admin/skills?days=${days}`);
}

export async function listAdminClasses(): Promise<AdminClass[]> {
  return getJson<AdminClass[]>("/admin/classes");
}

export async function getAdminConversations(opts: {
  ownerId?: string | null;
  spaceKind?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminConversationsResponse> {
  const p = new URLSearchParams();
  if (opts.ownerId) p.set("owner_id", opts.ownerId);
  if (opts.spaceKind) p.set("space_kind", opts.spaceKind);
  if (opts.search) p.set("search", opts.search);
  p.set("limit", String(opts.limit ?? 30));
  p.set("offset", String(opts.offset ?? 0));
  return getJson<AdminConversationsResponse>(`/admin/conversations?${p}`);
}

export async function getAdminConversation(
  sessionId: string,
): Promise<AdminConversationDetail> {
  return getJson<AdminConversationDetail>(
    `/admin/conversations/${encodeURIComponent(sessionId)}`,
  );
}

export async function getAdminDocuments(opts: {
  kind?: string | null;
  status?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminDocumentsResponse> {
  const p = new URLSearchParams();
  if (opts.kind) p.set("kind", opts.kind);
  if (opts.status) p.set("status", opts.status);
  if (opts.search) p.set("search", opts.search);
  p.set("limit", String(opts.limit ?? 30));
  p.set("offset", String(opts.offset ?? 0));
  return getJson<AdminDocumentsResponse>(`/admin/documents?${p}`);
}

export async function getAdminDocument(
  fileId: string,
  chunkOffset = 0,
): Promise<AdminDocumentDetail> {
  return getJson<AdminDocumentDetail>(
    `/admin/documents/${encodeURIComponent(fileId)}?chunk_offset=${chunkOffset}`,
  );
}

export async function runRagTest(body: {
  query: string;
  class_id?: string | null;
  file_ids?: string[];
  top_k?: number | null;
  max_distance?: number | null;
  include_figures?: boolean;
}): Promise<RagTestResult> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/rag/test`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}

