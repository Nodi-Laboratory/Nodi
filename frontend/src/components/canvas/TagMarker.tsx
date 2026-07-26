"use client";

// 태그 라벨 마커 — 태그 고정 앵커에 렌더(NoteCanvas 내부, 팬/줌 따라감).
// 카드 위 레이어(zIndex) + 솔리드 칩 → 카드에 가려지지 않는다. pointerEvents:none로 클릭 방해 없음.
import { CARD_W } from "@/lib/concept/curriculumTags";

/**
 * 칩 최대 폭(px). D100 이전에는 **고정 폭 220px**이었다.
 *
 * 태그는 D89로 모델이 자유 생성한다(단원·주제 수준, 2~12자 가이드). 고정 폭은
 * 양쪽으로 다 틀렸다 — 짧은 태그는 내용보다 훨씬 넓은 빈 알약이 되고(실측:
 * "식물의 에너지 전환"은 122px면 되는데 220px를 차지), 가이드를 넘긴 긴 태그는
 * whiteSpace:nowrap 때문에 칩 밖으로 삐져나간다.
 *
 * 이제 폭은 내용이 정하고, 이 값은 상한으로만 쓴다(넘치면 말줄임).
 */
const MARKER_MAX_W = 260;

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
      title={tag}
      style={{
        position: "absolute",
        // 카드 중앙에 앵커를 두고 자기 폭의 절반만큼 되돌린다 — 폭을 모르는
        // 상태에서 중앙 정렬하는 방법(고정 폭 계산 대체).
        left: x + CARD_W / 2,
        top: y - 52,
        transform: "translateX(-50%)",
        maxWidth: MARKER_MAX_W,
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
      {/* 상한을 넘는 태그는 잘리는 대신 말줄임 — count는 항상 보이게 shrink 금지. */}
      <span
        style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}
      >
        {tag}
      </span>
      <span
        style={{
          opacity: 0.55,
          fontSize: 13,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {count}
      </span>
    </div>
  );
}
