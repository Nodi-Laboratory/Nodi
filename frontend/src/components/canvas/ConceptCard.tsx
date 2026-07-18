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
// 08: 본문량 기반 동적 높이 — 백엔드 config(card_h_min/max/per_line)와 상수 일치.
// 서버 estimate_card_height(body_lines) = clamp(H_MIN + lines*PER_LINE, H_MIN, H_MAX)와
// 동일한 폴백을 프론트에서 재현(서버 저장 concept.h가 있으면 그 값을 신뢰).
import {
  CARD_H_MAX,
  CARD_H_MIN,
  CARD_H_PER_LINE,
  CARD_H_STREAM_LINES,
} from "@/lib/concept/cardMetrics";
import styles from "./ConceptCard.module.css";

// 카드 높이(px): 우선순위 concept.h(서버 저장값) → 없으면 본문 줄 수 기반 폴백.
// lines는 본문 "p" 블록 수 근사(서버 body_text.count("\n")+1과 대략 일치).
function cardHeight(concept: Concept, lines: number): number {
  if (typeof concept.h === "number" && concept.h > 0) return concept.h;
  const est = CARD_H_MIN + Math.max(0, lines) * CARD_H_PER_LINE;
  return Math.max(CARD_H_MIN, Math.min(CARD_H_MAX, est));
}

// D74: 출처 칩 푸터 높이 보정(px) — 카드가 인라인 height + overflow:hidden이라
// 푸터만큼 높이를 늘려야 칩이 잘리지 않는다(CSS max-height 560 클램프는 유지).
const SOURCES_EXTRA_H = 36;

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

  // 09: pending 분기 — 로딩 카드(실카드와 동일 골격 420px).
  if (pending) {
    // 본문 미확정 → 서버 스트리밍 기본(estimate_card_height(2))과 같은 높이로
    // 예약해 pending→실카드 승격 시 레이아웃 점프를 줄인다.
    const h = cardHeight(concept, CARD_H_STREAM_LINES);
    return (
      <article
        className={`${styles.card} ${styles.pending}`}
        style={{ left: x, top: y, height: h } as CSSProperties}
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
  // 08: 서버 저장 concept.h 우선, 없으면 본문 "p" 블록 수로 폴백(pending과 동일 로직).
  const hasSources = !!sources && sources.length > 0;
  const h =
    cardHeight(concept, paras.length) + (hasSources ? SOURCES_EXTRA_H : 0);
  // 형광펜 색: "대기와 해양" 클러스터는 블루, 그 외 옐로 (figma CONTRACTS v1.1)
  const hlColor =
    cluster === "대기와 해양" ? "var(--hl-blue)" : "var(--hl-yellow)";

  return (
    <article
      className={`${styles.card} ${highlighted ? styles.highlighted : ""}`}
      // --hl-color: 본문 형광펜 밴드 색(클러스터별) — styles.hl에서 참조
      style={
        { left: x, top: y, height: h, "--hl-color": hlColor } as CSSProperties
      }
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
