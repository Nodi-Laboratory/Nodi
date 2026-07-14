"use client";

// ArtNode — 삽화 스티커 리프 노드(캔버스 절대배치, .nodi-spawn 등장).
// 클릭 불가(pointer-events:none) 순수 장식. id 해시 기반 미세 회전(-6°..+6°,
// 결정적 — 리플레이도 동일). 회전은 안쪽 img에 적용 — 바깥 .nodi-spawn의
// transform(scale) 키프레임과 충돌하지 않게 분리.

import { memo } from "react";
import type { CanvasLeafNode } from "@/lib/concept/types";
import { hashStr } from "@/lib/concept/layout";

function ArtNode({ node }: { node: CanvasLeafNode }) {
  const art = node.art;
  if (!art?.url) return null;
  const rot = (hashStr(node.id + art.slug) % 13) - 6; // -6°..+6°

  return (
    <div
      className="nodi-spawn"
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: 220,
        pointerEvents: "none",
        userSelect: "none",
      }}
      data-testid="art-node"
      data-leaf-id={node.id}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={art.url}
        alt={art.title || ""}
        loading="lazy"
        draggable={false}
        style={{
          width: "100%",
          height: "auto",
          transform: `rotate(${rot}deg)`,
          filter: "drop-shadow(0 4px 10px rgba(60, 45, 0, 0.12))",
        }}
      />
    </div>
  );
}

export default memo(ArtNode);
