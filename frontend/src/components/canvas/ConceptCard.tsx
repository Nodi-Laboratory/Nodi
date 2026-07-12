"use client";

// ConceptCard — one concept card, absolutely positioned at concept.x/y.
// Ported from Nodi-figma/components/ConceptCard.js: the inline-SVG / ConceptArt /
// EbsCard paths are removed. 삽화는 이제 카드 안이 아니라 별도 ArtNode 리프로
// 캔버스에 뜬다(concept.art 데이터 플로우는 그룹핑용으로 유지, 렌더만 제거).
//
// 09: concept.pending === true 분기 — 로딩 카드(shimmer 제목 + 점 3개 바운스 + pulsing 테두리).

import { memo, type CSSProperties } from "react";
import type { Concept, Token } from "@/lib/concept/types";
import styles from "./ConceptCard.module.css";

// tokens[{ch,b,h}] -> merge equal b/h runs to avoid a span-per-char explosion.
function renderTokens(tokens: Token[] = [], hlClass?: string) {
  const runs: Array<{ b: boolean; h: boolean; text: string }> = [];
  for (const t of tokens) {
    const b = !!t.b;
    const hi = !!t.h;
    const last = runs[runs.length - 1];
    if (last && last.b === b && last.h === hi) last.text += t.ch;
    else runs.push({ b, h: hi, text: t.ch });
  }
  return runs.map((r, i) => {
    const inner = r.b ? <b>{r.text}</b> : r.text;
    return r.h && hlClass ? (
      <mark key={i} className={hlClass}>
        {inner}
      </mark>
    ) : (
      <span key={i}>{inner}</span>
    );
  });
}

function ConceptCard({
  concept,
  highlighted = false,
}: {
  concept: Concept;
  highlighted?: boolean;
}) {
  const { id, title, cluster, blocks = [], x = 0, y = 0, pending } = concept;

  // 09: pending 분기 — 로딩 카드(실카드와 동일 골격 420px).
  if (pending) {
    return (
      <article
        className={`${styles.card} ${styles.pending}`}
        style={{ left: x, top: y } as CSSProperties}
        data-testid="concept-card-pending"
        data-concept-id={id}
        aria-hidden="true"
      >
        {/* 제목 자리: shimmer 스켈레톤 바 */}
        <div className={styles.shimmerTitle} aria-hidden="true" />

        {/* 본문 자리: .nodi-ldot 점 3개 바운스(globals.css .nodi-canvas 스코프) */}
        <div className={styles.dotsBody}>
          <i className="nodi-ldot" style={{ animationDelay: "0ms" }} />
          <i className="nodi-ldot" style={{ animationDelay: "140ms" }} />
          <i className="nodi-ldot" style={{ animationDelay: "280ms" }} />
        </div>
      </article>
    );
  }

  const paras = blocks.filter((b) => b.type === "p");
  // 형광펜 색: "대기와 해양" 클러스터는 블루, 그 외 옐로 (figma CONTRACTS v1.1)
  const hlColor =
    cluster === "대기와 해양" ? "var(--hl-blue)" : "var(--hl-yellow)";

  return (
    <article
      className={`${styles.card} ${highlighted ? styles.highlighted : ""}`}
      // --hl-color: 본문 형광펜 밴드 색(클러스터별) — styles.hl에서 참조
      style={{ left: x, top: y, "--hl-color": hlColor } as CSSProperties}
      data-testid="concept-card"
      data-concept-id={id}
    >
      <h2 className={styles.title}>{title}</h2>

      {paras.length > 0 && (
        <div className={styles.body}>
          {paras.map((b, i) => (
            <p key={i} className={styles.p}>
              {renderTokens(b.tokens, styles.hl)}
              {b.typing && <span className="caret" aria-hidden />}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

export default memo(ConceptCard);
