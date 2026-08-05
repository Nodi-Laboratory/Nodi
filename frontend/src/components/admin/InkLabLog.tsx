"use client";

/**
 * 펜 표시 실험실의 흐름 로그 (D178).
 *
 * ## 무엇을 보여 주려고 만드나
 *
 * 이 기능은 **눈으로 검증할 수 없다.** 카드가 안 실려도, 화살표를 거꾸로
 * 읽어도 답은 그럴싸하게 온다. 그래서 볼 것은 답이 아니라 **경로**다:
 *
 *   획 → 카드 선정(왜 뽑혔고 왜 기각됐나) → 상자 → 그림 → 두 모델 → 결과
 *
 * ## 그림을 그대로 보여 준다
 *
 * 이 화면에서 가장 값진 것은 **모델이 실제로 본 그림**이다. 표가 아무리
 * 정확해도 "동그라미가 카드 위에 제대로 얹혔나"는 그림을 봐야 안다 —
 * 레터박스 좌표 변환이 틀리면 표에는 아무 이상이 없고 그림에만 드러난다.
 */

import { useEffect, useMemo, useState } from "react";
import { Eraser } from "lucide-react";
import type { InkCapture } from "@/lib/canvas2/inkCapture";
import type { InkTraceRow, InkVerdict } from "@/lib/canvas2/inkScene";
import type { CanvasItem } from "@/lib/canvas2/types";
import { C, Empty } from "./ui";

export interface InkRun {
  at: string;
  totalMs: number;
  capture: InkCapture;
  inkPng: Blob;
  reply: { text: string; marksNote: string; pointed: number | null; ms: number } | null;
  cards: readonly CanvasItem[];
}

const VERDICT: Record<InkVerdict, { label: string; fg: string; bg: string }> = {
  touched: { label: "접촉", fg: "#8ee6a8", bg: "#16301f" },
  near: { label: "근접", fg: "#e8c877", bg: "#2a2312" },
  over_cap: { label: "상한 초과", fg: "#e0a0a0", bg: "#301818" },
  too_far: { label: "멂", fg: "#8b8578", bg: "#1e1c19" },
};

function ms(v: number): string {
  return `${Math.round(v)}ms`;
}

function box(r: { x: number; y: number; w: number; h: number } | null): string {
  return r ? `${Math.round(r.w)}×${Math.round(r.h)}` : "—";
}

/**
 * Blob → 그림에 꽂을 주소.
 *
 * ## objectURL을 쓰지 않는다
 *
 * `createObjectURL`을 `useMemo`로 만들고 이펙트에서 해제하는 배치를 먼저
 * 썼는데 **개발 모드에서 그림이 통째로 깨졌다**(실측 2026-08-05). StrictMode가
 * 이펙트를 마운트→해제→마운트로 두 번 돌리는데, 해제가 주소를 폐기해도
 * `useMemo`는 다시 계산되지 않아 **죽은 주소가 그대로 남는다.**
 *
 * data URL은 수명이 없다 — 폐기할 것이 없으므로 그 함정이 성립하지 않는다.
 * 도식 PNG는 수십~수백 KB라 base64로 들고 있어도 부담이 아니고, 이 화면은
 * 관리자 실험실이다.
 *
 * setState가 **읽기 완료 콜백 안**에 있는 것도 중요하다 — 이펙트 본문에서
 * 동기로 부르면 React Compiler가 막는다(그게 애초에 파생값으로 갔던 이유다).
 */
function useDataUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(blob);
    // 언마운트 뒤 setState는 React 19에서 무해한 no-op이라 `alive` 빗장을
    // 두지 않는다 — 그 빗장이 StrictMode에서 첫 결과를 잃게 만든 전례가
    // 있다(D167 `FigureItem` 주석).
    return () => reader.abort();
  }, [blob]);
  return url;
}

export function InkLabLog({
  runs,
  error,
  onClear,
}: {
  runs: readonly InkRun[];
  error: string | null;
  onClear: () => void;
}) {
  return (
    <div className="flex max-h-[620px] flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold" style={{ color: C.text }}>
          작동 흐름
        </h3>
        {runs.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 text-[11px]"
            style={{ color: C.dim }}
          >
            <Eraser size={12} /> 비우기
          </button>
        )}
      </div>

      {error && (
        <div
          className="rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: "#7a3030", background: "#2a1616", color: "#e8a0a0" }}
        >
          {error}
        </div>
      )}

      {runs.length === 0 && !error && (
        <Empty>
          질문하는 펜으로 카드를 동그라미 치거나 화살표를 그은 뒤 [읽기]를
          누르면 여기에 단계가 쌓입니다.
        </Empty>
      )}

      {runs.map((r, i) => (
        <RunCard key={`${r.at}-${i}`} run={r} open={i === 0} />
      ))}
    </div>
  );
}

function RunCard({ run, open }: { run: InkRun; open: boolean }) {
  const [shown, setShown] = useState(open);
  const t = run.capture.trace;
  const inkUrl = useDataUrl(shown ? run.inkPng : null);
  const sceneUrl = useDataUrl(shown ? run.capture.scene : null);
  const figureUrl = useDataUrl(shown ? run.capture.figure : null);

  const titleById = useMemo(
    () => new Map(run.cards.map((c) => [c.id, c.title ?? c.tag ?? c.kind])),
    [run.cards],
  );

  return (
    <div className="rounded-xl border" style={{ borderColor: C.line, background: "#151312" }}>
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="text-[12px] font-semibold" style={{ color: C.text }}>
          {run.at}
        </span>
        <span className="text-[11px]" style={{ color: C.dim }}>
          획 {t.strokeCount} · 카드 {run.capture.cards.length} · {ms(run.totalMs)}
        </span>
      </button>

      {shown && (
        <div className="flex flex-col gap-3 px-3 pb-3">
          <Step n={1} title="질문 획" detail={`${t.strokeCount}획 · 상자 ${box(t.inkBox)}`}>
            {inkUrl && <Shot src={inkUrl} label="OCR로 가는 그림 (획만)" />}
          </Step>

          <Step
            n={2}
            title="카드 선정"
            detail={
              t.rows.length
                ? `후보 ${t.rows.length} → 채택 ${run.capture.cards.length}` +
                  (run.capture.dropped ? ` · 상한으로 ${run.capture.dropped} 버림` : "")
                : "후보 없음"
            }
          >
            {t.rows.length ? (
              <Trace rows={t.rows} titles={titleById} />
            ) : (
              <Note>가까운 카드가 없어 도식을 보내지 않았습니다.</Note>
            )}
          </Step>

          <Step
            n={3}
            title="그릴 상자"
            detail={
              `${box(t.inkBox)} → ${box(t.capture)}` +
              (t.clamped ? " · 상한에 걸려 잘림" : "")
            }
          />

          <Step
            n={4}
            title="도식 렌더"
            detail={
              t.sceneSize
                ? `${t.sceneSize.w}×${t.sceneSize.h}px · ${ms(t.timings.scene)}`
                : "만들지 않음"
            }
          >
            {t.figures.length > 0 && (
              <Note>
                도판 {t.figures.length}장 받기 {ms(t.timings.fetch)} —{" "}
                {t.figures
                  .map((f) => (f.ok ? `${f.w}×${f.h}` : "실패(라벨 상자로 대체)"))
                  .join(", ")}
              </Note>
            )}
            {sceneUrl && <Shot src={sceneUrl} label="비전 모델이 보는 그림" />}
          </Step>

          {run.capture.figure && (
            <Step
              n={5}
              title="도판 확대본"
              detail={
                `[카드 ${run.capture.figureN}] · ` +
                (t.figureSize ? `원본 ${t.figureSize.w}×${t.figureSize.h}` : "") +
                ` · ${ms(t.timings.figure)}`
              }
            >
              {figureUrl && <Shot src={figureUrl} label="표시를 도판 좌표로 재투영" />}
            </Step>
          )}

          <Step
            n={run.capture.figure ? 6 : 5}
            title="두 모델 (동시)"
            detail={run.reply ? `${ms(run.reply.ms)}` : "실패"}
          >
            {run.reply ? (
              <div className="flex flex-col gap-2">
                <Field label="OCR — 손글씨">
                  {run.reply.text || <i style={{ color: C.dim }}>못 읽음</i>}
                </Field>
                <Field label="비전 — 가리킴">
                  {run.reply.pointed !== null ? (
                    <b style={{ color: "#8ee6a8" }}>
                      [카드 {run.reply.pointed}]{" "}
                      {run.capture.cards.find((c) => c.n === run.reply!.pointed)?.title ?? ""}
                    </b>
                  ) : (
                    <i style={{ color: C.dim }}>없음</i>
                  )}
                </Field>
                <Field label="비전 — 설명">
                  {run.reply.marksNote || (
                    <i style={{ color: C.dim }}>
                      비어 있음 — 비전 모델이 꺼져 있거나 응답하지 않았습니다
                      (질문은 막히지 않습니다)
                    </i>
                  )}
                </Field>
              </div>
            ) : (
              <Note>창구가 응답하지 않았습니다.</Note>
            )}
          </Step>

          <Step
            n={run.capture.figure ? 7 : 6}
            title="SOLAR에 갈 블록"
            detail={`카드 ${run.capture.cards.length}장`}
          >
            <Pre>{solarPreview(run)}</Pre>
          </Step>
        </div>
      )}
    </div>
  );
}

/**
 * 실제로 프롬프트에 들어갈 모양 — **본문은 서버가 RLS로 다시 읽는다**(D104).
 * 여기 보이는 본문은 화면의 카드에서 가져온 미리보기라, 서버가 넣는 것과
 * 글자가 같을 뿐 출처는 다르다.
 */
function solarPreview(run: InkRun): string {
  const note =
    run.reply?.marksNote.trim() ||
    "표시가 무엇을 가리키는지는 읽지 못했습니다. 아래 카드들이 학생이 표시한 자리 주변에 있었습니다.";
  const byId = new Map(run.cards.map((c) => [c.id, c]));
  const lines = run.capture.cards.map((c) => {
    const it = byId.get(c.itemId);
    const body = (it?.body ?? "").replace(/\s+/g, " ").slice(0, 120);
    return `[카드 ${c.n}] ${c.title || "제목 없음"}: ${body}${body.length >= 120 ? "…" : ""}`;
  });
  return `[화면에 그린 표시]\n${note}\n\n[표시 주변의 카드]\n${lines.join("\n")}`;
}

function Step({
  n,
  title,
  detail,
  children,
}: {
  n: number;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative pl-6">
      {/* 세로 실선이 단계를 잇는다 — 표가 아니라 흐름으로 읽히게. */}
      <span
        aria-hidden
        className="absolute left-[9px] top-5 bottom-[-12px] w-px"
        style={{ background: C.line }}
      />
      <span
        className="absolute left-0 top-0 flex h-[19px] w-[19px] items-center justify-center rounded-full text-[10px] font-bold"
        style={{ background: "#2a2622", color: "#e0a32e" }}
      >
        {n}
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12px] font-semibold" style={{ color: C.text }}>
          {title}
        </span>
        <span className="text-[11px]" style={{ color: C.dim }}>
          {detail}
        </span>
      </div>
      {children && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

function Trace({
  rows,
  titles,
}: {
  rows: readonly InkTraceRow[];
  titles: ReadonlyMap<string, string>;
}) {
  return (
    <table className="w-full text-[11px]">
      <tbody>
        {rows.map((r) => {
          const v = VERDICT[r.verdict];
          return (
            <tr key={r.id}>
              <td className="py-0.5 pr-2" style={{ color: C.dim, width: 22 }}>
                {r.n !== null ? `${r.n}.` : "—"}
              </td>
              <td className="py-0.5 pr-2" style={{ color: C.text }}>
                {titles.get(r.id) ?? r.id}
                {r.kind !== "concept" && (
                  <span style={{ color: C.dim }}> · {r.kind}</span>
                )}
              </td>
              <td className="py-0.5 pr-2 text-right" style={{ color: C.dim }}>
                {r.verdict === "touched" ? "—" : `${Math.round(r.gap)}px`}
              </td>
              <td className="py-0.5 text-right">
                <span
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: v.bg, color: v.fg }}
                >
                  {v.label}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Shot({ src, label }: { src: string; label: string }) {
  return (
    <figure className="m-0">
      {/* 높이를 묶는다 — 안 묶으면 세로로 긴 도식 한 장이 칸을 다 먹어
          뒤 단계(두 모델·SOLAR 블록)가 스크롤 밖으로 밀린다. 흐름을 한눈에
          보는 것이 이 화면의 목적이다.
          data URL이라 next/image는 쓸 수 없다(로더가 원격 주소를 기대한다). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={label}
        className="max-h-52 w-full rounded-md border object-contain"
        style={{ borderColor: C.line, background: "#fff" }}
      />
      <figcaption className="mt-1 text-[10px]" style={{ color: C.dim }}>
        {label}
      </figcaption>
    </figure>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: C.dim }}>
        {label}
      </div>
      <div className="text-[12px]" style={{ color: C.text }}>
        {children}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px]" style={{ color: C.dim }}>
      {children}
    </div>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre
      className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border px-2 py-1.5 text-[11px] leading-relaxed"
      style={{ borderColor: C.line, background: "#111", color: "#cfc9bb" }}
    >
      {children}
    </pre>
  );
}
