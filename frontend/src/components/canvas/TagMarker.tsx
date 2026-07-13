"use client";

// 태그 라벨 마커 — 태그 무게중심에 렌더(NoteCanvas 내부, 팬/줌 따라감). 카드 아래 레이어.
import { CARD_W } from "@/lib/concept/tagLayoutCore";

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
        left: x + CARD_W / 2 - 90,
        top: y - 44,
        width: 180,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        background: "rgba(43,38,32,.06)",
        border: "1px solid rgba(43,38,32,.14)",
        borderRadius: 999,
        fontFamily: "var(--font-title)",
        fontSize: 15,
        color: "var(--ink)",
        pointerEvents: "none",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span>{tag}</span>
      <span style={{ opacity: 0.6, fontSize: 12 }}>{count}</span>
    </div>
  );
}
