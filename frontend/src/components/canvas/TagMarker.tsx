"use client";

// 태그 라벨 마커 — 태그 고정 앵커에 렌더(NoteCanvas 내부, 팬/줌 따라감).
// 카드 위 레이어(zIndex) + 솔리드 칩 → 카드에 가려지지 않는다. pointerEvents:none로 클릭 방해 없음.
import { CARD_W } from "@/lib/concept/curriculumTags";

// 마커 칩 폭(px) — 카드 중앙 정렬에 절반값을 쓴다.
const MARKER_W = 220;

export default function TagMarker({
  tag,
  x,
  y,
  count,
}: {
  tag: string;
  x: number;
  y: number;
  count: number;
}) {
  return (
    <div
      data-testid="tag-marker"
      style={{
        position: "absolute",
        left: x + CARD_W / 2 - MARKER_W / 2,
        top: y - 52,
        width: MARKER_W,
        zIndex: 5, // 카드 위
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        padding: "5px 14px",
        background: "rgba(255,255,255,.95)",
        border: "1.5px solid var(--border, #f0e4c2)",
        borderRadius: 999,
        boxShadow: "0 4px 14px rgba(120,90,0,.16)",
        fontFamily: "var(--font-title)",
        fontWeight: 700,
        fontSize: 16,
        color: "var(--ink)",
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span>{tag}</span>
      <span style={{ opacity: 0.55, fontSize: 13, fontWeight: 600 }}>{count}</span>
    </div>
  );
}
