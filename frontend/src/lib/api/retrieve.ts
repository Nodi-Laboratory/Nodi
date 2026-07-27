/** 질의 임베딩 검색(교과서 figure) + signed URL 재발급. api.ts(806줄)에서 분리 — D102. */
import { API_BASE, authHeaders, ensureOk } from "./_core";

// ── 임베딩 검색 + 캔버스 영속 (Upstage /retrieve · PATCH /nodes, C4/C5) ──

/** D87: 교과서 figure 히트. url은 signed(만료 有) — 라이브 배치엔 쓰되 서버로는
 *  전달하지 않고(ChatStreamBody figures는 url 제외), 재수화 시 getFigure로 재발급. */
export interface RetrieveFigureHit {
  figureId: string;
  fileId: string;
  page?: number;
  caption: string;
  url: string;
  score: number;
}

export interface RetrieveResult {
  figures: RetrieveFigureHit[];
  /** 백엔드 임베딩/Qdrant 실패 — 프론트는 여전히 로컬 폴백으로 배치(09 계약). */
  degraded: boolean;
}

const RETRIEVE_TIMEOUT_MS = 4000;

/** retrieve 자체가 네트워크 실패/타임아웃일 때 — 좌표는 프론트 sim이 배치. */
function degradedRetrieve(): RetrieveResult {
  return { figures: [], degraded: true };
}

/**
 * POST /retrieve (09) — 교과서 figure 추천(D94: EBS/아트 제거). SSE 선행
 * 호출이므로 절대 reject하지 않고, 타임아웃(4s)·오류 모두 degraded로 resolve
 * 한다. session_id는 서버 kNN 계산용.
 */
export async function retrieve(
  question: string,
  sessionId: string,
): Promise<RetrieveResult> {
  const q = question.trim();
  if (!q) return degradedRetrieve();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RETRIEVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/retrieve`, {
      method: "POST",
      headers: await authHeaders(true),
      body: JSON.stringify({ question: q.slice(0, 2000), session_id: sessionId }),
      signal: controller.signal,
    });
    if (!res.ok) return degradedRetrieve();
    const body = (await res.json()) as {
      figures?: Array<{
        figure_id?: string;
        file_id?: string;
        page?: number;
        caption?: string;
        url?: string;
        score?: number;
      }>;
      degraded?: boolean;
    };
    return {
      // D87: 방어적 파싱(figure_id/url 없으면 drop, snake→camel).
      figures: (body?.figures ?? [])
        .filter((f) => f?.figure_id && f?.url)
        .map((f) => ({
          figureId: String(f.figure_id),
          fileId: String(f.file_id ?? ""),
          page: typeof f.page === "number" ? f.page : undefined,
          caption: f.caption ?? "",
          url: String(f.url),
          score: f.score ?? 0,
        })),
      degraded: !!body?.degraded,
    };
  } catch {
    return degradedRetrieve();
  } finally {
    clearTimeout(timer);
  }
}

/** C5/09: nodes.attachments.canvas에 병합 저장되는 형태(figures — snake_case).
 *  D87: figures는 url 제외 영속 — 재수화 시 getFigure로 fresh signed URL 재발급.
 *  D94: ebs/art 제거(구 노드의 잔존 키는 무시하고 읽지 않는다). */
export interface NodeCanvasAttachment {
  figures?: Array<{
    figure_id: string;
    file_id: string;
    page?: number;
    caption: string;
    score: number;
  }>;
}

/**
 * D87: GET /files/figures/{id} — figure의 fresh signed URL 재발급 창구.
 * 재수화(url 비영속) + 만료 시 FigureNode onError가 1회 호출한다. camel 정규화.
 * 실패 시 throw(ApiError) — 호출부가 best-effort로 처리.
 */
export async function getFigure(
  figureId: string,
): Promise<{ figureId: string; url: string; caption: string; page?: number }> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/figures/${encodeURIComponent(figureId)}`, {
      headers: await authHeaders(),
    }),
  );
  const body = (await res.json()) as {
    figure_id?: string;
    url?: string;
    caption?: string;
    page?: number;
  };
  return {
    figureId: String(body.figure_id ?? figureId),
    url: body.url ?? "",
    caption: body.caption ?? "",
    page: typeof body.page === "number" ? body.page : undefined,
  };
}
