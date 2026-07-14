"use client";

// Minimal top bar: hamburger (opens the session drawer), zoom pill, nodi logo,
// and the concept-tree toggle. Ported/adapted from Nodi-figma/components/TopBar.js
// — camera ops are owned by the parent; this only invokes callbacks.

import styles from "./TopBar.module.css";

export default function TopBar({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onMenu,
  treeOpen,
  onToggleTree,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onMenu: () => void;
  treeOpen: boolean;
  onToggleTree: () => void;
}) {
  return (
    <header className={styles.bar} data-testid="top-bar">
      <div className={styles.left}>
        <button
          className={styles.hamburger}
          type="button"
          aria-label="대화 목록"
          onClick={onMenu}
          data-no-pan
        >
          <span />
          <span />
          <span />
        </button>

        <div className={styles.zoom}>
          <button
            className={styles.zoomBtn}
            type="button"
            onClick={onZoomOut}
            aria-label="축소"
            data-no-pan
          >
            −
          </button>
          <button
            className={styles.zoomLevel}
            type="button"
            onClick={onReset}
            aria-label="줌 초기화"
            data-no-pan
          >
            {Math.round(zoom)}%
          </button>
          <button
            className={styles.zoomBtn}
            type="button"
            onClick={onZoomIn}
            aria-label="확대"
            data-no-pan
          >
            ＋
          </button>
        </div>

        <span className={styles.logo}>
          nodi<span className={styles.dot}>.</span>
        </span>
      </div>

      <div className={styles.right}>
        <button
          className={`${styles.treeToggle} ${treeOpen ? styles.active : ""}`}
          type="button"
          onClick={onToggleTree}
          aria-pressed={treeOpen}
          data-testid="tree-toggle"
          data-no-pan
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <line x1="4" y1="4" x2="12" y2="6" stroke="currentColor" strokeWidth="1.3" />
            <line x1="4" y1="4" x2="7" y2="12" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="4" cy="4" r="2.4" fill="currentColor" />
            <circle cx="12" cy="6" r="2.4" fill="currentColor" />
            <circle cx="7" cy="12" r="2.4" fill="currentColor" />
          </svg>
          개념 트리
        </button>
      </div>
    </header>
  );
}
