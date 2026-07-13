"use client";

// 개념트리 — 태그를 무게중심=점으로 보여주는 D3 위치 미니맵 패널.
// 점 클릭 시 본 캔버스가 그 태그 위치로 팬(onFocus).

import type { Camera } from "./NoteCanvas";
import ConceptMinimap from "./ConceptMinimap";
import styles from "./ConceptTreePanel.module.css";

export default function ConceptTreePanel({
  open,
  onToggle,
  tagNodes,
  camera,
  viewport,
  onFocus,
}: {
  open: boolean;
  onToggle: () => void;
  tagNodes: Array<{ tag: string; x: number; y: number; count: number }>;
  camera: Camera;
  viewport: { w: number; h: number };
  onFocus: (target: { x: number; y: number }) => void;
}) {
  if (!open) {
    return (
      <button
        type="button"
        className={styles.edge}
        onClick={onToggle}
        data-no-pan
        aria-label="개념 트리 펼치기"
      >
        <span className={styles.dot} />
        개념 {tagNodes.length}
      </button>
    );
  }

  return (
    <aside className={styles.panel} data-testid="concept-tree" data-no-pan>
      <div className={styles.header}>
        <span>개념 트리</span>
        <span className={styles.count}>{tagNodes.length}개 개념</span>
        <button
          type="button"
          className={styles.collapse}
          onClick={onToggle}
          aria-label="개념 트리 접기"
        >
          ✕
        </button>
      </div>
      <div className={styles.body}>
        <ConceptMinimap
          tagNodes={tagNodes}
          camera={camera}
          viewport={viewport}
          onFocus={onFocus}
        />
      </div>
    </aside>
  );
}
