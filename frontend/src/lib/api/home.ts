/** 홈 요약. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";
import type {
  HomeSummary,
} from "@/lib/types";

// ── 홈 + 총괄 AI (Stage 4a) ──────────────────────────────────────────

export async function getHomeSummary(
  recentLimit = 8,
  conceptLimit = 8,
): Promise<HomeSummary> {
  const params = new URLSearchParams({
    recent_limit: String(recentLimit),
    concept_limit: String(conceptLimit),
  });
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/summary?${params.toString()}`, {
      headers: await authHeaders(),
    }),
  );
  return res.json();
}

