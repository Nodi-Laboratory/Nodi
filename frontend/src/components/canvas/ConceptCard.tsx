"use client";

// ConceptCard — one concept card, absolutely positioned at concept.x/y.
// Ported from Nodi-figma/components/ConceptCard.js: the inline-SVG / ConceptArt /
// EbsCard paths are removed. (D94: 삽화·영상 리프 자체가 제거됨 — 카드는 텍스트
// 블록 + 출처 칩만 렌더한다.)
//
// 09: concept.pending === true 분기 — 로딩 카드(shimmer 제목 + 점 3개 바운스 + pulsing 테두리).

import { memo, type CSSProperties } from "react";
import type { Concept, Token } from "@/lib/concept/types";
import type { RagSource } from "@/lib/types";
// 카드 높이는 인라인으로 고정하지 않는다(사용자 결정 2026-07-23): height:auto로
// 본문 바이트만큼 카드가 그대로 늘어나고 줄어든다. cardMetrics.cardHeight()는
// 충돌 회피 추정 전용이라 여기서 렌더에는 쓰지 않는다.
import styles from "./ConceptCard.module.css";

// D74: 파일 단위 중복 제거 칩(최대 3개 + 초과 개수). 노드(턴) 단위 provenance라
// 턴의 첫 개념에만 sources가 부착된다(useConceptStream).
function sourceChips(sources: RagSource[]): { chips: string[]; more: number } {
  const byFile = new Map<string, string>();
  for (const s of sources) {
    if (byFile.has(s.file_id)) continue;
    byFile.set(s.file_id, s.name || "자료");
  }
  const all = [...byFile.values()];
  return { chips: all.slice(0, 3), more: Math.max(0, all.length - 3) };
}

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
  const { id, title, cluster, blocks = [], x = 0, y = 0, pending, sources } = concept;

  // 09: pending 분기 — 로딩 카드(실카드와 동일 골격 420px). 높이는 shimmer·점
  // 콘텐츠에 맞춰 자동(height:auto) — 승격 시 본문 바이트만큼 자연스럽게 늘어난다.
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
  const hasSources = !!sources && sources.length > 0;
  // 형광펜 색: "대기와 해양" 클러스터는 블루, 그 외 옐로 (figma CONTRACTS v1.1)
  const hlColor =
    cluster === "대기와 해양" ? "var(--hl-blue)" : "var(--hl-yellow)";

  return (
    <article
      className={`${styles.card} ${highlighted ? styles.highlighted : ""}`}
      // 높이 인라인 지정 없음 → height:auto로 본문에 딱 맞게(동적). --hl-color:
      // 본문 형광펜 밴드 색(클러스터별) — styles.hl에서 참조.
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

      {hasSources && (() => {
        const { chips, more } = sourceChips(sources ?? []);
        return (
          <footer className={styles.sources} data-testid="concept-card-sources">
            {chips.map((label) => (
              <span key={label} className={styles.sourceChip} title={label}>
                📄 {label}
              </span>
            ))}
            {more > 0 && <span className={styles.sourceMore}>+{more}</span>}
          </footer>
        );
      })()}
    </article>
  );
}

export default memo(ConceptCard);
