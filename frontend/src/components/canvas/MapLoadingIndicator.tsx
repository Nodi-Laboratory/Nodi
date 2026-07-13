"use client";

// 맵 내부 앵커 로딩 버블 — NoteCanvas children으로 렌더돼 맵 transform(팬/줌)을 따라간다.
// 생성 지점(x,y=카드 top-left) 위에 마스코트 + 점 3개 바운스로 "노트를 쓰는 중"을 표시.
// 화면 중앙 고정 칩(LoadingChip)을 대체한다. pending 스켈레톤 카드는 별도 유지.

const BUBBLE_W = 168;
const CARD_CX = 210; // 카드 폭 절반(중앙 정렬용) — workspace 상수와 일치

export default function MapLoadingIndicator({
  x,
  y,
  visible,
}: {
  x: number;
  y: number;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div
      className="nodi-spawn"
      data-testid="map-loading"
      style={{
        position: "absolute",
        left: x + CARD_CX - BUBBLE_W / 2,
        top: y - 56,
        width: BUBBLE_W,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: "var(--bg)",
        border: "1px solid rgba(43,38,32,.12)",
        borderRadius: 999,
        boxShadow: "0 6px 22px rgba(43,38,32,.14)",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/nodi-mascot.png"
        alt=""
        style={{ height: 26, width: "auto", mixBlendMode: "multiply" }}
      />
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <i className="nodi-ldot" style={{ animationDelay: "0ms" }} />
        <i className="nodi-ldot" style={{ animationDelay: "140ms" }} />
        <i className="nodi-ldot" style={{ animationDelay: "280ms" }} />
      </span>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--ink)",
          whiteSpace: "nowrap",
        }}
      >
        노트를 쓰는 중…
      </span>
    </div>
  );
}
