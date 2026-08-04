/**
 * 교차 세션 개념 연결 API (D171).
 *
 * 링크는 **서버(워커)만 만든다** — 여기 있는 것은 읽기와 "열어 봤다" 표식뿐이다.
 * 스펙: docs/superpowers/specs/2026-08-04-crosslink-design.md
 */
import { API_BASE, authHeaders, ensureOk } from "./_core";

/** 돌아갈 목적지. 세션은 공간에 속하므로(D148) 공간 정보가 **함께** 온다. */
export interface CrossLinkTarget {
  itemId: string;
  sessionId: string;
  sessionTitle: string | null;
  /** "personal" | "class" — 둘 중 하나만 갖고 이동하면 엉뚱한 세션이 열린다. */
  spaceKind: string | null;
  spaceRef: string | null;
  title: string | null;
  tag: string | null;
}

export interface CrossLink {
  id: string;
  fromItemId: string;
  explanation: string;
  distance: number | null;
  /** null이면 아직 안 열어 본 것 — 배지가 깜빡인다. */
  openedAt: string | null;
  to: CrossLinkTarget;
}

interface LinkRow {
  id: string;
  from_item_id: string;
  explanation: string;
  distance: number | null;
  opened_at: string | null;
  to: {
    item_id: string;
    session_id: string;
    session_title: string | null;
    space_kind: string | null;
    space_ref: string | null;
    title: string | null;
    tag: string | null;
  };
}

/** snake_case 경계를 여기 한 곳에만 둔다(canvas.ts와 같은 규약). */
function toLink(row: LinkRow): CrossLink {
  return {
    id: row.id,
    fromItemId: row.from_item_id,
    explanation: row.explanation ?? "",
    distance: row.distance,
    openedAt: row.opened_at,
    to: {
      itemId: row.to.item_id,
      sessionId: row.to.session_id,
      sessionTitle: row.to.session_title,
      spaceKind: row.to.space_kind,
      spaceRef: row.to.space_ref,
      title: row.to.title,
      tag: row.to.tag,
    },
  };
}

export async function listCrossLinks(sessionId: string): Promise<CrossLink[]> {
  const res = await fetch(
    `${API_BASE}/sessions/${sessionId}/canvas/links`,
    { headers: await authHeaders() },
  );
  const rows = (await ensureOk(res)).json() as Promise<LinkRow[]>;
  return (await rows).map(toLink);
}

/** 열어 본 표식 — 깜빡임을 멈춘다. 멱등이므로 실패해도 되풀이해 부를 수 있다. */
export async function openCrossLink(linkId: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/canvas/links/${linkId}/open`, {
      method: "POST",
      headers: await authHeaders(true),
    }),
  );
}
