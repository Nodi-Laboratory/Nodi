/**
 * 관리자 — 사용자·설정·로그·관측 (D102 분리, D113 확장).
 *
 * D113에서 콘솔이 서비스 전체를 보는 창구가 됐다: 개요·AI 흐름·스킬·대화·
 * 문서 인제스트·RAG 테스트. 모든 경로가 admin 전용이며 비관리자는 403이다
 * (백엔드 require_admin + RLS 정책 + RPC 내부 is_admin 3중).
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type {
  AdminBackup,
  AdminBackupsResponse,
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
  HealthConfig,
  AdminPurgeResult,
  AdminRestoreResult,
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

/**
 * 환경 자가진단 (D97의 내용, D116부터 관리자 인증 경유).
 *
 * 예전에는 `/api` 밖의 `/health/config`를 직접 불렀다. 그런데 프론트와
 * 백엔드를 같은 출처로 배포하면서 그 경로가 **인터넷에 인증 없이** 열리게
 * 됐다. 비밀값은 없지만 `secret_is_default`·`jwt_algorithm`·내부 경로는
 * 정찰 정보다. 백엔드가 같은 페이로드를 관리자 전용으로 다시 낸다.
 */
export async function getHealthConfig(): Promise<HealthConfig> {
  return getJson<HealthConfig>("/admin/env");
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

// ── D114: 백업 · 복원 · 초기화 ───────────────────────────────────────

export async function getAdminBackups(): Promise<AdminBackupsResponse> {
  return getJson<AdminBackupsResponse>("/admin/backups");
}

export async function createAdminBackup(body: {
  scopes: string[];
  note?: string;
}): Promise<AdminBackup> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/backups`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ scopes: body.scopes, note: body.note ?? "" }),
    }),
  );
  return res.json();
}

export async function deleteAdminBackup(name: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/admin/backups/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }),
  );
}

/**
 * 스냅샷 내려받기.
 *
 * `<a download>`로 바로 걸지 않는 이유: 이 경로는 Authorization 헤더가 필요한데
 * 브라우저의 일반 내비게이션에는 헤더를 붙일 수 없다. fetch로 받아 Blob으로
 * 저장한다.
 */
export async function downloadAdminBackup(name: string): Promise<void> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/backups/${encodeURIComponent(name)}/download`, {
      headers: await authHeaders(),
    }),
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function restoreAdminBackup(
  name: string,
  scopes: string[],
): Promise<AdminRestoreResult> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/backups/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ scopes }),
    }),
  );
  return res.json();
}

/** 되돌릴 수 없다. `confirm`은 서버가 요구하는 문구와 정확히 같아야 한다. */
export async function purgeAdminData(body: {
  scopes: string[];
  confirm: string;
  owner_id?: string | null;
  backup_first: boolean;
}): Promise<AdminPurgeResult> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/purge`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify(body),
    }),
  );
  return res.json();
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


// ── D172: 교차 연결 판정 로그 ────────────────────────────────────────────
//
// item_links는 **성공한 링크만** 남긴다. 여기 오는 것은 판정 전체다 —
// 어떤 세션들을 뒤졌고, 각 후보의 유사도가 얼마였고, 무엇이 왜 떨어졌는지.

/** 후보 하나의 판정. `verdict`가 왜 떨어졌는지를 말한다. */
export interface CrossLinkCandidate {
  item_id: string;
  session_id: string;
  session_title?: string | null;
  title?: string | null;
  tag: string | null;
  space_kind: string | null;
  distance: number;
  verdict: "accepted" | "too_close" | "too_far" | "no_explanation" | "vanished";
  reason: string;
}

export interface CrossLinkRun {
  id: string;
  owner_id: string;
  owner_label: string;
  from_item_id: string | null;
  from_session_id: string | null;
  from_title: string | null;
  from_tag: string | null;
  from_space_kind: string | null;
  knobs: Record<string, unknown>;
  candidates: CrossLinkCandidate[];
  outcome: "linked" | "all_rejected" | "no_candidate" | "skipped" | "disabled";
  link_id: string | null;
  explanation: string;
  searched_sessions: number;
  duration_ms: number | null;
  created_at: string;
}

export async function getCrossLinkRuns(opts: {
  outcome?: string | null;
  limit?: number;
  offset?: number;
}): Promise<{ items: CrossLinkRun[]; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (opts.outcome) params.set("outcome", opts.outcome);
  params.set("limit", String(opts.limit ?? 30));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/crosslink-runs?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

export async function getCrossLinkSummary(): Promise<Record<string, number>> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/crosslink-runs/summary`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

/**
 * 다른 곳에서 만든 백업 파일 가져오기 (D193).
 *
 * 시연에 쓸 상황을 미리 만들어 두고 그때 불러오려면 파일이 서버를 건너와야 한다.
 * **가져오는 것과 적용하는 것은 다른 단계다** — 여기서는 목록에 넣기만 하고,
 * 복원은 스코프를 골라 따로 누른다(올리자마자 덮어쓰면 되돌릴 방법이 없다).
 */
export async function importAdminBackup(file: File): Promise<{
  name: string;
  scopes: string[];
  note: string;
  rows: Record<string, number>;
  size_bytes: number;
}> {
  const form = new FormData();
  form.append("file", file);
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/backups/import`, {
      method: "POST",
      headers: await authHeaders(),
      body: form,
    }),
  );
  return res.json();
}
