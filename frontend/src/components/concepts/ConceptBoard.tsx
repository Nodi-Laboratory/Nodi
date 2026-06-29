"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { TagRow } from "@/lib/types";

/**
 * D68: 개념 보드(ConceptCanopy 대체). 목적은 "지금까지 어떤 개념을 썼는지" 한눈에 보기.
 *
 * - **개념 이름 항상 표시**: 원형 노드(nodi 디자인 언어) + 아래 라벨. 라벨은 절대 숨기지 않고,
 *   길면 말줄임 + title 전체. (구 ConceptCanopy의 r≥20 게이트·6자 절단 폐지.)
 * - **사용빈도 티어 그룹**(자주/가끔/드물게): 사용횟수 순위 분위수로 분할.
 * - **연결선·줄기·뿌리·co-occurrence 시각화 없음**(설계 핵심 제약 — 개념들만 보여줌).
 * - 상단 검색으로 필터(렌더 중 파생 — effect setState 금지).
 * - nodi 팔레트(#fcf58b accent), 가독성 1순위(최소 폰트 12px, 최소 칩폭 보장).
 */

interface Tier {
  key: string;
  label: string;
  hint: string;
  tags: TagRow[];
}

/** 원 지름: 사용횟수에 약하게 변주(area 인지를 위해 sqrt 스케일). 36~64px. */
function circleDiameter(usage: number, maxUsage: number): number {
  if (maxUsage <= 0) return 40;
  const ratio = Math.sqrt(usage) / Math.sqrt(maxUsage);
  return Math.round(36 + ratio * 28);
}

export function ConceptBoard({ tags }: { tags: TagRow[] }) {
  const [query, setQuery] = useState("");

  // 정렬·필터·티어 분할은 모두 렌더 중 파생(effect 미사용 — react-compiler 준수).
  const { tiers, maxUsage, filteredCount } = useMemo(() => {
    const sorted = tags
      .slice()
      .sort((a, b) => b.usage_count - a.usage_count);
    const maxUsage = sorted.length > 0 ? sorted[0].usage_count : 0;

    const q = query.trim().toLowerCase();
    const filtered = q
      ? sorted.filter((t) => t.name.toLowerCase().includes(q))
      : sorted;

    // 순위 분위수: 상위 20% = 자주, 다음 30% = 가끔, 나머지 = 드물게.
    const n = filtered.length;
    const often = Math.max(n > 0 ? 1 : 0, Math.round(n * 0.2));
    const sometimes = often + Math.round(n * 0.3);

    const tiers: Tier[] = [
      {
        key: "often",
        label: "자주 쓰는 개념",
        hint: "사용횟수 상위",
        tags: filtered.slice(0, often),
      },
      {
        key: "sometimes",
        label: "가끔 쓰는 개념",
        hint: "중간 빈도",
        tags: filtered.slice(often, sometimes),
      },
      {
        key: "rarely",
        label: "드물게 쓰는 개념",
        hint: "사용횟수 하위",
        tags: filtered.slice(sometimes),
      },
    ].filter((t) => t.tags.length > 0);

    return { tiers, maxUsage, filteredCount: filtered.length };
  }, [tags, query]);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* 검색/필터 */}
      <div className="flex items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="개념 검색…"
            className="w-full rounded-lg border border-accent-border/40 bg-bg-elevated py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep"
          />
        </div>
        <span className="text-xs text-fg-muted">개념 {filteredCount}개</span>
      </div>

      {/* 티어별 개념 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {tiers.length === 0 ? (
          <p className="px-1 py-8 text-center text-sm text-fg-muted">
            검색과 일치하는 개념이 없습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {tiers.map((tier) => (
              <section key={tier.key}>
                <div className="mb-3 flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold text-fg">{tier.label}</h3>
                  <span className="text-xs text-fg-muted">
                    {tier.hint} · {tier.tags.length}개
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-4">
                  {tier.tags.map((t) => (
                    <ConceptNode key={t.id} tag={t} maxUsage={maxUsage} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 원형 노드 + 아래 라벨(nodi 규칙). 라벨은 항상 표시, 길면 말줄임 + title 전체. */
function ConceptNode({ tag, maxUsage }: { tag: TagRow; maxUsage: number }) {
  const d = circleDiameter(tag.usage_count, maxUsage);
  const countFont = d >= 52 ? 15 : d >= 44 ? 13 : 12;

  return (
    <div
      className="flex w-[88px] flex-col items-center gap-1.5"
      title={`${tag.name} · ${tag.usage_count}회`}
    >
      <div
        className="flex shrink-0 items-center justify-center rounded-full border bg-[#fcf58b] font-bold text-[#4a3d1e]"
        style={{
          width: d,
          height: d,
          fontSize: countFont,
          borderColor: "#c9a227",
        }}
      >
        {tag.usage_count}
      </div>
      <span className="w-full truncate text-center text-xs font-medium text-fg">
        {tag.name}
      </span>
    </div>
  );
}
