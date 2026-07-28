/** 교과서 도판 signed URL 재발급 (D102 분리).
 *
 * D111: 질의 검색(POST /retrieve)은 이 파일에서 사라졌다 — 도판은 서버가
 * 찾아 chat done 이벤트로 보낸다. 남은 것은 만료된 URL을 다시 받는 창구뿐이다.
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

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
