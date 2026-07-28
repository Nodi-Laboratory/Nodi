"use client";

/**
 * 운영 콘솔 공용 프리미티브 (D113).
 *
 * 탭이 여덟 개로 늘면서 같은 카드·뱃지·표를 각자 다시 그리게 됐다. 색상 토큰과
 * 여백을 한 곳에 모아 둔다 — 탭마다 미묘하게 다른 회색을 쓰는 것을 막는다.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";

// 다크 운영 톤. 일반 화면(cream/노랑)과 분명히 구분되게 유지한다.
export const C = {
  bg: "#1b1813",
  panel: "#221e17",
  card: "#25211a",
  code: "#15120d",
  line: "rgba(255,255,255,0.10)",
  text: "#e7e3d8",
  dim: "#9a948a",
  soft: "#cfc9bd",
  gold: "#e0a32e",
  goldText: "#fcf58b",
  ok: "#9bbf6a",
  warn: "#e0a86a",
  bad: "#e0796a",
  info: "#7fb2c4",
} as const;

export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-white/10 bg-[#25211a] ${className}`}
    >
      {(title || right) && (
        <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
            {title}
          </h3>
          <div className="ml-auto">{right}</div>
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  const color =
    tone === "ok" ? C.ok : tone === "warn" ? C.warn : tone === "bad" ? C.bad : C.text;
  return (
    <div className="rounded-lg border border-white/10 bg-[#25211a] px-3 py-2.5">
      <div className="text-[11px] text-[#9a948a]">{label}</div>
      <div className="mt-0.5 text-xl font-bold" style={{ color }}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[11px] text-[#9a948a]">{sub}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "default",
  title,
}: {
  children: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "bad" | "gold" | "info";
  title?: string;
}) {
  const map: Record<string, { bg: string; fg: string }> = {
    default: { bg: "rgba(255,255,255,0.06)", fg: C.dim },
    ok: { bg: "rgba(155,191,106,0.18)", fg: C.ok },
    warn: { bg: "rgba(224,168,106,0.18)", fg: C.warn },
    bad: { bg: "rgba(224,121,106,0.18)", fg: C.bad },
    gold: { bg: "rgba(224,163,46,0.20)", fg: C.goldText },
    info: { bg: "rgba(127,178,196,0.18)", fg: C.info },
  };
  const s = map[tone] ?? map.default;
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ backgroundColor: s.bg, color: s.fg }}
    >
      {children}
    </span>
  );
}

/** 상태 문자열 → 색. files/jobs/chunks가 같은 어휘를 쓰므로 한 곳에서 판정한다. */
export function statusTone(
  status: string | null | undefined,
): "ok" | "warn" | "bad" | "default" {
  switch (status) {
    case "indexed":
    case "embedded":
    case "done":
      return "ok";
    case "failed":
      return "bad";
    case "partial":
    case "uploaded":
    case "splitting":
    case "embedding":
    case "queued":
    case "running":
    case "pending":
    case "stored":
      return "warn";
    default:
      return "default";
  }
}

export function Collapse({
  label,
  children,
  defaultOpen = false,
  count,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
        {count != null && <span className="text-[10px]">({count})</span>}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

export function Code({
  children,
  max = "max-h-64",
}: {
  children: React.ReactNode;
  max?: string;
}) {
  return (
    <pre
      className={`${max} overflow-auto whitespace-pre-wrap break-words rounded bg-[#15120d] p-2.5 font-mono text-[11px] leading-relaxed text-[#cfc9bd]`}
    >
      {children}
    </pre>
  );
}

export function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* 클립보드 권한 없음 — 조용히 무시 */
        }
      }}
      className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
      {done ? "복사됨" : label}
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-[#9a948a]">{children}</p>;
}

export function Loading({ what = "불러오는" }: { what?: string }) {
  return <p className="py-6 text-center text-sm text-[#9a948a]">{what} 중…</p>;
}

export function Failed({ what = "불러오지" }: { what?: string }) {
  return <p className="py-6 text-center text-sm text-[#e0796a]">{what} 못했습니다.</p>;
}

// ── 포맷터 ────────────────────────────────────────────────────────────
export const nf = new Intl.NumberFormat("ko-KR");

export function n(v: number | null | undefined): string {
  return v == null ? "—" : nf.format(v);
}

export function bytes(v: number | null | undefined): string {
  if (v == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < u.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? x : x.toFixed(1)} ${u[i]}`;
}

export function ms(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

export function when(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ko-KR");
}

/** {키: 수} 맵을 "a 3 · b 1" 한 줄로. 개요 카드의 부제목에 쓴다. */
export function countLine(map: Record<string, number> | undefined): string {
  if (!map) return "";
  const keys = Object.keys(map);
  if (keys.length === 0) return "";
  return keys.map((k) => `${k} ${nf.format(map[k])}`).join(" · ");
}
