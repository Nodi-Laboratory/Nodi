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
import { AnswerBox } from "./AnswerBox";
import type { InkTextSource, InkMarksStatus } from "@/lib/api/ink";
import type { LabAnswer } from "@/lib/api/adminInkLab";
import type { InkCapture } from "@/lib/canvas2/inkCapture";
import type { InkTraceRow, InkVerdict } from "@/lib/canvas2/inkScene";
import type { CanvasItem } from "@/lib/canvas2/types";
import { C, Empty } from "./ui";

export interface InkRun {
  at: string;
  totalMs: number;
  capture: InkCapture;
  inkPng: Blob;
  reply:
    | {
        text: string;
        marksNote: string;
        marksStatus: InkMarksStatus;
        textSource: InkTextSource;
        ms: number;
      }
    | null;
  cards: readonly CanvasItem[];
  /** SOLAR 답변. 아직 안 왔으면 null. */
  answer: LabAnswer | null;
}

/**
 * 표시가 왜 안 읽혔는지를 사람 말로.
 *
 * 빈 설명만 보여 주면 "고장인가 꺼진 건가"를 알 수 없다. 관리자가 다음에 할
 * 일이 갈래마다 다르다 — 노브를 켜거나, 주소를 채우거나, 서버를 살리거나.
 */
/** 기하가 센 표시 종류 → 화면 말. */
const MARK_LABEL: Record<string, string> = {
  circled: "감쌈",
  within: "카드 안에 그림",
  pointed: "끝이 가리킴",
  linked: "여기서 출발",
  crossed: "스쳐 지나감",
  near: "근처",
};

/** 표시 모양 → 화면 말. `inkShapes.GestureShape`와 같은 열쇠다. */
const SHAPE_LABEL: Record<string, string> = {
  circle: "동그라미",
  arrow: "화살표",
  underline: "밑줄",
  line: "선",
  bracket: "묶음표",
  scribble: "덧칠",
};

/** 글자를 읽은 길 — 화면에 쓰는 말. */
const TEXT_SOURCE: Record<string, string> = {
  varco: "전용 OCR",
  vision_fallback: "비전 예비",
  unknown: "알 수 없음",
};

const MARKS_REASON: Record<InkMarksStatus, string> = {
  ok: "",
  off: "설정에서 [펜 표시 해석]이 꺼져 있습니다.",
  unconfigured: "비전 모델 주소·키가 비어 있습니다(JUDGE_BASE_URL / JUDGE_API_KEY).",
  no_scene: "도식을 만들지 못해 비전 모델을 부르지 않았습니다.",
  no_cards: "표시 주변에 카드가 없어 비전 모델을 부르지 않았습니다.",
  error: "비전 모델 서버가 응답하지 않았습니다(주소·포트·기동 상태를 확인하세요).",
};

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
  busy,
  answering,
  onClear,
}: {
  runs: readonly InkRun[];
  error: string | null;
  /** 지금 읽는 중인가 — 누르고 응답까지 3~20초라 빈 화면이면 멎은 줄 안다. */
  busy: boolean;
  /** SOLAR 답변을 기다리는 중인가. */
  answering: boolean;
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

      {busy && (
        <div
          className="rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: C.line, background: "#1b1813", color: C.dim }}
        >
          읽는 중… OCR 3~8초 · 비전 5~20초 (동시에 돕니다)
        </div>
      )}

      {answering && !busy && (
        <div
          className="rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: C.line, background: "#1b1813", color: C.dim }}
        >
          SOLAR가 답하는 중…
        </div>
      )}

      {runs.length === 0 && !error && !busy && (
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

      {/**
       * **결과를 맨 위에 둔다.**
       *
       * 처음에는 단계 순서대로 5번째에 놓았는데, 앞선 그림 두 장에 밀려
       * 스크롤을 내려야만 보였다(사용자 지적 2026-08-05: "응답 결과가 안
       * 보이는 거 같은데?"). 흐름은 근거고, 사람이 먼저 찾는 것은 답이다.
       * 접었을 때도 보이게 펼침 밖에 둔다.
       */}
      <Result run={run} />

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
            detail={
              run.reply
                ? `${ms(run.reply.ms)} · 표시 ${run.reply.marksStatus} · 글자 ${
                    TEXT_SOURCE[run.reply.textSource] ?? run.reply.textSource
                  }`
                : "창구가 응답하지 않음"
            }
          />

          <Step
            n={run.capture.figure ? 7 : 6}
            title="SOLAR에 간 블록"
            detail={`카드 ${run.capture.cards.length}장`}
          >
            <Pre>{run.answer?.ink_block || solarPreview(run)}</Pre>
          </Step>

          <Step
            n={run.capture.figure ? 8 : 7}
            title="SOLAR 답변"
            detail={
              run.answer
                ? run.answer.ok
                  ? ms(run.answer.ms)
                  : "실패"
                : "기다리는 중…"
            }
          >
            {!run.answer && (
              <Note>표시를 다 읽은 뒤 이어서 물어봅니다 — 보통 5~20초.</Note>
            )}
            {run.answer && !run.answer.ok && (
              <div className="text-[12px]" style={{ color: "#e0a0a0" }}>
                {run.answer.error || "답변을 받지 못했습니다."}
              </div>
            )}
            {/**
             * **원문을 그대로 붓지 않는다** (사용자 보고 2026-08-10).
             *
             * 실험실도 채팅 턴과 같은 프롬프트로 태우므로(`CONCEPT_CARD_SYSTEM_PROMPT`)
             * 답은 전선 형식이다 — `CHAT:` 접두사와 `@concept: 제목 | 분류`
             * 표시가 섞여 있다. 그것을 답변 칸에 그대로 넣으면 운영자 눈에는
             * **응답에 엉뚱한 내용이 끼어든 것**으로 보인다.
             *
             * 대화·로그 탭은 이미 `AnswerBox`로 갈아탔는데 여기만 남아 있었다.
             * 형식을 어긴 답을 찾는 것이 실험실의 일이므로 원문 보기는 그대로
             * 남는다 — 기본값만 읽는 모습이다.
             */}
            {run.answer?.ok &&
              (run.answer.answer ? (
                <AnswerBox raw={run.answer.answer} />
              ) : (
                <Pre>(빈 응답)</Pre>
              ))}
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

/**
 * 사람이 먼저 찾는 것 — **무엇을 읽었나.**
 *
 * 손글씨와 가리킨 카드, 그리고 표시 설명. 비었으면 **왜 비었는지**까지
 * 말한다(빈 칸만 보여 주면 고장인지 꺼진 건지 알 수 없다).
 */
function Result({ run }: { run: InkRun }) {
  const r = run.reply;
  if (!r) {
    return (
      <div
        className="mx-3 mb-3 rounded-lg border px-3 py-2 text-[12px]"
        style={{ borderColor: "#7a3030", background: "#241414", color: "#e8a0a0" }}
      >
        창구가 응답하지 않았습니다 — 손글씨도 못 읽었습니다.
      </div>
    );
  }
  // **짚은 카드는 기하가 정한다** — 모델 답이 아니다(D178).
  const picked = run.capture.pointed
    .map((n) => ({ n, c: run.capture.cards.find((x) => x.n === n) }))
    .filter((x) => !!x.c);
  const reason = MARKS_REASON[r.marksStatus];

  return (
    <div
      className="mx-3 mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2.5"
      style={{ borderColor: C.line, background: "#1b1813" }}
    >
      {/**
        * **어느 길로 읽었나** (2026-08-10).
        *
        * 예비 경로(비전)가 도는 것은 **고장 신호**다 — 학생 화면은 멀쩡해도
        * 전용 OCR이 내려가 있고 정확도가 낮아져 있다. 안 보여 주면 아무도
        * 모른 채 품질만 조용히 내려간다.
        */}
      {r.textSource === "vision_fallback" && (
        <div
          className="rounded px-2 py-1 text-[11px]"
          style={{ background: "#3a2a12", color: "#e0a32e" }}
        >
          ⚠ 전용 OCR(VARCO)이 응답하지 않아 <b>비전 모델로 대신 읽었습니다</b>.
          글자는 나왔지만 정확도가 평소보다 낮습니다 — OCR 서버를 확인하세요.
        </div>
      )}
      <div>
        <div className="text-[10px] uppercase tracking-wide" style={{ color: C.dim }}>
          손글씨 (OCR)
        </div>
        <div className="text-[14px] font-semibold" style={{ color: C.text }}>
          {r.text || <i style={{ color: C.dim, fontWeight: 400 }}>못 읽음</i>}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wide" style={{ color: C.dim }}>
          짚은 카드 (기하)
        </div>
        {picked.length ? (
          <div className="flex flex-wrap gap-1">
            {picked.map(({ n, c }) => (
              <span
                key={n}
                className="inline-block rounded px-1.5 py-0.5 text-[12px] font-semibold"
                style={{ background: "#16301f", color: "#8ee6a8" }}
              >
                [카드 {n}] {c!.title} · {MARK_LABEL[c!.mark] ?? c!.mark}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-[12px]" style={{ color: C.dim }}>
            없음
          </span>
        )}
      </div>

      {/**
       * **표시가 몇 개고 각각 무엇을 했나.** 카드별 낱말만 보면 "화살표가
       * 1에서 3으로 갔다"를 못 읽는다 — 방향은 카드 둘 사이의 관계라 어느
       * 한 카드에도 안 딸린다. 비전 모델이 받는 사실이 정확히 이것이다.
       */}
      {run.capture.gestures.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: C.dim }}>
            그린 표시 (기하)
          </div>
          <div className="flex flex-col gap-0.5">
            {run.capture.gestures.map((g) => (
              <div key={g.i} className="text-[12px]" style={{ color: C.text }}>
                <span style={{ color: C.dim }}>{g.i}.</span>{" "}
                <b>{SHAPE_LABEL[g.shape] ?? g.shape}</b>
                {(
                  [
                    ["감쌈", g.encloses],
                    ["안쪽", g.within],
                    ["가리킴", g.points],
                    ["출발", g.from],
                    ["스침", g.crosses],
                  ] as const
                )
                  .filter(([, ns]) => ns.length)
                  .map(([label, ns]) => (
                    <span key={label} style={{ color: C.dim }}>
                      {" · "}
                      {label} {ns.map((n) => `[${n}]`).join("")}
                    </span>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wide" style={{ color: C.dim }}>
          표시 설명 (비전)
        </div>
        {r.marksNote ? (
          <div className="text-[12px] leading-relaxed" style={{ color: C.text }}>
            {r.marksNote}
          </div>
        ) : (
          <div className="text-[12px]" style={{ color: "#e0a86a" }}>
            {reason || "비어 있음"}
            <span className="block text-[11px]" style={{ color: C.dim }}>
              표시는 곁들이라 이래도 질문은 막히지 않습니다 — 손글씨와 주변
              카드만으로 나갑니다.
            </span>
          </div>
        )}
      </div>
    </div>
  );
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
