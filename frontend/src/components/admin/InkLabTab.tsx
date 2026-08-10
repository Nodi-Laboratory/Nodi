"use client";

/**
 * 펜 표시 실험실 (D178).
 *
 * ## 왜 이 자리가 필요한가
 *
 * 이 기능의 결과는 **화면에 안 보인다.** 카드가 안 실려도, 화살표를 거꾸로
 * 읽어도 답은 그럴싸하게 온다 — 틀린 것을 눈으로 잡을 방법이 없다.
 * `RagLabTab`이 검색 게이트에 대해 하는 일을 여기서는 표시 해석에 대해 한다.
 *
 * ## 실제와 같은 것을 태운다
 *
 * 캔버스는 학습 화면과 **같은 부품**이다 — `CanvasStage`(같은 무대·같은
 * 오버레이 변환·같은 질문 펜) 위에 `ItemLayer`(같은 카드·도판·클립 렌더)를
 * 얹고, [글자 인식]은 `captureInk` → `interpretInk`를 그대로 부른다.
 * 사본을 만들면 **사본만 맞고 실제 경로는 다른 상황**이 된다.
 *
 * 다른 점은 둘뿐이다:
 *   · 카드가 붙박이다(DB에 안 쓴다) — 매번 같은 조건에서 재야 하므로
 *   · 질문을 SOLAR로 보내지 않는다 — 여기서 볼 것은 표시 해석까지다
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PenLine, RotateCcw } from "lucide-react";
import { CanvasStage } from "@/components/canvas2/CanvasStage";
import { ItemLayer } from "@/components/canvas2/ItemLayer";
import { useExcalidrawBridge } from "@/lib/canvas2/useExcalidrawBridge";
import { useItemLayout, type LayoutSource } from "@/lib/canvas2/useItemLayout";
import {
  allAskStrokes,
  markAsk,
  pendingStrokes,
  toStrokes,
  withoutStrokes,
} from "@/lib/canvas2/askInk";
import { renderInkPng } from "@/lib/canvas2/penPad";
import {
  captureInk,
  EMPTY_CAPTURE,
  type InkCapture,
} from "@/lib/canvas2/inkCapture";
import { interpretInk, listAdminSettings, ocrErrorMessage } from "@/lib/api";
import {
  anyFigureForLab,
  askLabSolar,
  type LabFigure,
} from "@/lib/api/adminInkLab";
import { useClientSettings } from "@/lib/canvas2/useClientSettings";
import type { ExcalidrawElementLike } from "@/lib/canvas2/useExcalidrawBridge";
import type { AdminSettingsView } from "@/lib/types";
import { labItems, LAB_WORLD } from "./inkLabFixture";
import { InkLabLog, type InkRun } from "./InkLabLog";
import { C } from "./ui";

/** 실험실은 붙박이 캔버스라 이 값들이 안 바뀐다 — ItemLayer가 요구한다. */
const NO_SELECTION: ReadonlySet<string> = new Set();
const NOOP = () => {};

export function InkLabTab() {
  const bridge = useExcalidrawBridge();
  const stageRef = useRef<HTMLDivElement>(null);
  const clientSettings = useClientSettings();
  const markBase = useRef<Set<string>>(new Set());
  const [inkCount, setInkCount] = useState(0);
  const [busy, setBusy] = useState(false);
  /** SOLAR 답변을 기다리는 중 — 인식과 따로 돈다. */
  const [answering, setAnswering] = useState(false);
  const [runs, setRuns] = useState<InkRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * 도판은 **이 기계에 실제로 있는 것**을 쓴다. 없으면 주소 없는 도판이
   * 되는데, 그 상태(D167)도 시험 대상이라 굳이 감추지 않는다.
   */
  const { data: settings } = useQuery<AdminSettingsView>({
    queryKey: ["admin", "settings"],
    queryFn: listAdminSettings,
  });
  const figureId = useLabFigureId();

  const items = useMemo(() => labItems(figureId), [figureId]);
  const layoutSources: LayoutSource[] = useMemo(
    () =>
      items.map((i) => ({
        id: i.id,
        tag: i.tag,
        seq: i.seq,
        pinned: i.pinned,
        x: i.x,
        y: i.y,
        parentItemId: i.parentItemId,
        kind: i.kind,
        source: i.source,
      })),
    [items],
  );
  const layout = useItemLayout("ink-lab", layoutSources, bridge.getObstacles);

  const askStrokes = useCallback(
    () => allAskStrokes(bridge.api?.getSceneElements() ?? [], markBase.current),
    [bridge.api],
  );

  /** 표시를 찍는다 — 획이 끝난 뒤의 discrete한 순간에만 (D176). */
  const markPending = useCallback(() => {
    const els = bridge.api?.getSceneElements() ?? [];
    const fresh = pendingStrokes(els, markBase.current);
    if (!fresh.length) return;
    const ids = new Set(fresh.map((e) => e.id));
    bridge.api?.updateScene({
      elements: els.map((e) => (ids.has(e.id) ? markAsk(e) : e)),
    });
  }, [bridge.api]);

  const recountInk = useCallback(
    (elements: readonly ExcalidrawElementLike[]) => {
      if (bridge.activeTool !== "askpen") return;
      setInkCount(allAskStrokes(elements, markBase.current).length);
    },
    [bridge.activeTool],
  );

  /**
   * 들어오자마자 질문하는 펜을 쥐여 준다 — 여기 온 이유가 그것이다.
   *
   * **프레임을 넘겨서 건다.** api가 생긴 그 순간에 걸면 다음 프레임에 도로
   * 풀린다(실측 2026-08-05: 레일이 계속 '선택'이었다) — 브리지의 rAF 루프가
   * 매 프레임 Excalidraw의 활성 도구를 되읽어 `askMode`를 끄기 때문이다
   * (`useExcalidrawBridge`의 도구 동기화). Excalidraw가 자기 초기화를 마친
   * 뒤라야 `setActiveTool`이 남는다.
   */
  useEffect(() => {
    const api = bridge.api;
    if (!api) return;
    /**
     * **실험실은 열면 백지다** (2026-08-09).
     *
     * 학습 캔버스는 대화방마다 씬이 갈리지만 여기는 고정 무대라, 앞서 그은
     * 획이 Excalidraw의 저장·복원을 타고 그대로 남는다(D176의
     * `customData.nodiAsk`가 도구를 오가도 살아남는 그 성질이다). 남은 획은
     * 눈에 거슬리는 데서 끝나지 않는다 — 카드 위에 겹쳐 있으면 새로 긋는 획이
     * 그 요소에 먹혀 **획이 아예 안 세어진다**(실측: 실험실 스펙 둘을 이어
     * 돌리면 뒤엣것이 그 이유로 멈췄다).
     *
     * ⚠️ **청소는 펜을 쥐여 주는 이 자리에서** 한다. 따로 떼어 두면 "언제
     * 도는가"가 씬이 도착하는 시각과 경합해서, 어떤 때는 남은 획을 못 지우고
     * 어떤 때는 **방금 그은 획을 지운다**(실측 2026-08-09: 같은 코드로 돌려도
     * 결과가 갈렸다). 여기서 지우면 순서가 곧 규칙이다 — 지우는 것은 언제나
     * "펜을 쥐기 전에 있던 것"이고, 학생이 그은 획은 그 뒤의 일이다.
     *
     * 시각(`updated`)으로 가르는 길도 있었는데, 그 값이 복원 때 어떻게 되는지
     * 우리가 정하지 못한다 — **우리가 아는 순서**로 가르는 편이 낫다.
     */
    const els = api.getSceneElements();
    const stale = allAskStrokes(els, new Set<string>());
    if (stale.length) {
      const gone = new Set(stale.map((e) => e.id));
      api.updateScene({ elements: withoutStrokes(els, gone) });
    }
    markBase.current = new Set(
      (api.getSceneElements() ?? []).map((e) => e.id),
    );
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => bridge.setTool("askpen")),
    );
    return () => cancelAnimationFrame(raf);
    // 마운트 때 한 번만. bridge를 다 넣으면 도구를 바꿀 때마다 되돌아온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.api]);

  /**
   * 마운트 시 카메라 — **`initialCamera`로 준다.**
   *
   * 나중에 명령형으로 미는 길(`applyCamera`)을 먼저 시도했는데 되돌아갔다
   * (실측 2026-08-05: 다섯 아이템이 다 실측된 뒤 맞춰도 화면은 zoom 1, 원점).
   * `ExcalidrawLayer` 주석이 그 이유를 적어 두고 있다 — 마운트 직후에는 경합이
   * 남고, `initialData`만 확정적으로 적용된다.
   *
   * 아이템 자리가 고정(`pinned`)이라 **재기 전에 이미 안다** — 그래서 이 길이
   * 쓸 수 있다.
   */
  const initialCamera = useMemo(() => {
    const PAD = 40;
    // 칸 크기는 아래 스타일이 정한다(높이 620). 폭은 화면마다 다르지만
    // 좁은 쪽(1024 노트북)에 맞춰 두면 넓은 화면에서는 여백이 남을 뿐이다.
    const vw = 820 - PAD * 2;
    const vh = 620 - PAD * 2;
    const zoom = Math.min(1, Math.min(vw / LAB_WORLD.w, vh / LAB_WORLD.h));
    return {
      zoom,
      // screen = (world + scroll) * zoom → 가운데 맞추려면 scroll = 화면중심/zoom − 월드중심
      scrollX: 820 / 2 / zoom - (LAB_WORLD.x + LAB_WORLD.w / 2),
      scrollY: 620 / 2 / zoom - (LAB_WORLD.y + LAB_WORLD.h / 2),
    };
  }, []);

  const run = useCallback(async () => {
    if (busy) return;
    markPending();
    const els = askStrokes();
    if (!els.length) return;
    const strokes = toStrokes(els);
    const started = performance.now();
    const inkPng = await renderInkPng(strokes, window.devicePixelRatio || 1);
    if (!inkPng) return;

    setBusy(true);
    setError(null);
    let shot: InkCapture = EMPTY_CAPTURE;
    try {
      shot = await captureInk(
        strokes,
        {
          items,
          positions: layout.positions,
          sizes: layout.sizes,
          zoom: bridge.cameraRef.current.zoom,
        },
        {
          cardMax: clientSettings.inkCardMax,
          nearPad: clientSettings.inkNearPad,
          boxMaxScale: clientSettings.inkBoxMaxScale,
          sceneMaxSide: clientSettings.inkSceneMaxSide,
          figureZoomEnabled: clientSettings.inkFigureZoomEnabled,
        },
      );
    } catch (err) {
      setError(`도식을 만들지 못했습니다: ${String(err)}`);
    }

    const askedAt = performance.now();
    let reply: InkRun["reply"] = null;
    try {
      const got = await interpretInk({
        ink: inkPng,
        scene: shot.scene,
        figure: shot.figure,
        figureN: shot.figureN,
        cards: shot.cards,
        gestures: shot.gestures,
      });
      reply = { ...got, ms: performance.now() - askedAt };
    } catch (err) {
      setError(ocrErrorMessage(err));
      reply = null;
    } finally {
      setBusy(false);
    }

    const at = new Date().toLocaleTimeString("ko-KR");
    setRuns((prev) => [
      {
        at,
        totalMs: performance.now() - started,
        capture: shot,
        inkPng,
        reply,
        cards: items,
        answer: null,
      },
      ...prev,
    ]);

    /**
     * **SOLAR까지 이어 부른다** (사용자 요청 2026-08-05: "결과적으로 SOLAR가
     * 응답한 결과까지 보이게").
     *
     * 앞 단계를 먼저 화면에 올려 두고 따로 부른다 — 여기서 기다리면 판정
     * 근거(그림·표)를 보는 데도 답변 생성 시간만큼 더 기다려야 한다.
     */
    const q = reply?.text?.trim();
    if (q) {
      setAnswering(true);
      const byId = new Map(items.map((i) => [i.id, i]));
      void askLabSolar({
        question: q,
        marksNote: reply?.marksNote ?? "",
        cards: shot.cards.map((c) => ({
          n: c.n,
          title: c.title,
          body: byId.get(c.itemId)?.body ?? "",
        })),
      })
        .then((ans) => {
          setRuns((prev) =>
            prev.map((r) => (r.at === at ? { ...r, answer: ans } : r)),
          );
        })
        .catch((err: unknown) => {
          setRuns((prev) =>
            prev.map((r) =>
              r.at === at
                ? {
                    ...r,
                    answer: {
                      ok: false,
                      error: String(err),
                      ms: 0,
                      answer: "",
                      ink_block: "",
                      system_prompt: "",
                    },
                  }
                : r,
            ),
          );
        })
        .finally(() => setAnswering(false));
    }

    /**
     * **글자가 됐을 때만** 획을 걷는다 (2026-08-10).
     *
     * 학습 화면은 처음부터 그랬다 — 창구가 던지면 걷는 줄까지 못 가고, 읽은
     * 글자가 비면 `return`한다(D176: "인식 실패는 획을 지우지 않는다. 지우면
     * 다시 써야 한다"). 그런데 실험실만 **무조건** 걷고 있었다.
     *
     * 실측(2026-08-10): 망을 끊고 [읽기]를 누르면 획 1 → 0이 되고 화면에는
     * "다시 시도하거나 자판으로 입력해 주세요"가 뜬다 — **다시 시도할 획이
     * 없는데** 그렇게 말한다.
     *
     * 실험실의 존재 이유는 실제 경로를 그대로 태우는 것이다. 실패했을 때의
     * 처신이 다르면, 관리자가 여기서 보는 실패는 학생이 겪는 실패가 아니다.
     */
    const 읽었다 = Boolean(reply?.text?.trim());
    if (읽었다) {
      const gone = new Set(els.map((e) => e.id));
      bridge.api?.updateScene({
        elements: withoutStrokes(bridge.api.getSceneElements(), gone),
      });
      setInkCount(0);
    }
  }, [askStrokes, bridge, busy, clientSettings, items, layout, markPending]);

  const clear = useCallback(() => {
    const gone = new Set(askStrokes().map((e) => e.id));
    if (gone.size) {
      bridge.api?.updateScene({
        elements: withoutStrokes(bridge.api.getSceneElements(), gone),
      });
    }
    setInkCount(0);
    setError(null);
  }, [askStrokes, bridge.api]);

  /**
   * **실험실은 열면 백지다** (2026-08-09).
   *
   * 학습 캔버스는 대화방마다 씬이 갈리지만 여기는 고정 무대라, 앞서 그은
   * 획이 Excalidraw의 저장·복원을 타고 그대로 남는다(D176의
   * `customData.nodiAsk`가 도구를 오가도 살아남는 그 성질이다).
   *
   * 남은 획은 눈에 거슬리는 데서 끝나지 않는다 — 카드 위에 겹쳐 있으면 새로
   * 긋는 획이 그 요소에 먹혀 **획이 아예 안 세어진다**(실측 2026-08-09:
   * 실험실 스펙 둘을 이어 돌리면 뒤엣것이 그 이유로 멈췄다).
   *
   * 한 번만 지운다 — 매번 지우면 지금 그리는 획까지 사라진다.
   *
   * ⚠️ **들어오기 전에 있던 것만** 지운다. `bridge.api`는 한 박자 늦게 오는데,
   * 그 사이에 그은 획까지 쓸어 가면 "그렸는데 사라지는" 일이 생긴다 — 실측
   * 2026-08-09: 스펙을 이어 돌릴 때 한 번씩 획 수가 0에서 안 올랐고, 같은
   * 코드로 다시 돌리면 통과했다(순서가 아니라 **경합**이다). 마운트 시각보다
   * 나중에 만들어진 요소는 남긴다.
   */
  const vlmOn =
    settings?.items.find((i) => i.key === "ink_vlm_enabled")?.value !== false;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <PenLine size={16} className="text-[#e0a32e]" />
        <h2 className="text-sm font-semibold text-[#e7e3d8]">펜 표시 실험실</h2>
        <span className="text-[11px]" style={{ color: C.dim }}>
          학습 화면과 같은 캔버스·같은 코드. 질문하는 펜으로 카드를 동그라미
          치거나 화살표를 그은 뒤 [읽기]를 누릅니다.
        </span>
      </div>

      {!vlmOn && (
        <div
          className="rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: "#7a5c1e", background: "#2a2312", color: "#e8c877" }}
        >
          설정에서 <b>펜 표시 해석</b>이 꺼져 있습니다 — 손글씨만 읽고 표시는
          건너뜁니다.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* 왼쪽: 진짜 캔버스.
            `canvas2` 클래스는 **여기 붙이지 않는다** — `CanvasStage`의 루트가
            이미 갖고 있어서, 겹치면 선택자가 둘을 가리킨다(e2e가 상자를 못 잡는다). */}
        <div
          ref={stageRef}
          data-testid="ink-lab-stage"
          className="relative overflow-hidden rounded-xl border"
          style={{ borderColor: C.line, height: 620 }}
        >
          <CanvasStage
            bridge={bridge}
            initialScene={null}
            sceneKey="ink-lab"
            initialCamera={initialCamera}
            onSceneCommit={NOOP}
            onSceneChange={recountInk}
            penWriting={false}
            sessionId="ink-lab"
            onToolSelect={bridge.setTool}
            chrome={
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-4">
                <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-[#171514]/90 px-3 py-2 backdrop-blur"
                  style={{ borderColor: C.line }}
                >
                  <span className="text-[11px]" style={{ color: C.dim }}>
                    획 {inkCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => void run()}
                    disabled={busy || inkCount === 0}
                    className="rounded-full px-3 py-1 text-[12px] font-semibold disabled:opacity-40"
                    style={{ background: "#e0a32e", color: "#241d10" }}
                  >
                    {busy ? "읽는 중…" : "읽기"}
                  </button>
                  <button
                    type="button"
                    onClick={clear}
                    disabled={busy || inkCount === 0}
                    title="획 지우기"
                    className="rounded-full border px-2 py-1 disabled:opacity-40"
                    style={{ borderColor: C.line, color: C.dim }}
                  >
                    <RotateCcw size={13} />
                  </button>
                </div>
              </div>
            }
          >
            <ItemLayer
              items={items}
              positions={layout.positions}
              sizes={layout.sizes}
                    tagOptions={layout.tagOrder}
              zoom={bridge.camera.zoom}
              selectedIds={NO_SELECTION}
              editingId={null}
              pickedId={null}
              measure={layout.measure}
              handlers={{
                onCut: NOOP,
                // 실험실에서는 카드를 끌지 않는다 — 제한도 없다.
                dyLimitsFor: () => ({ min: -Infinity, max: Infinity }),
                onPortDrag: NOOP,
                onSelect: NOOP,
                onStartEdit: NOOP,
                onCommitEdit: NOOP,
                onCancelEdit: NOOP,
                onDelete: NOOP,
                onTagChange: NOOP,
                onRenameTag: NOOP,
                onRemoveTag: NOOP,
                onDragEnd: NOOP,
                onAsk: NOOP,
                onPick: NOOP,
                onResize: NOOP,
                onResetSize: NOOP,
              }}
            />
          </CanvasStage>
        </div>

        {/* 오른쪽: 흐름 로그 */}
        <InkLabLog
          runs={runs}
          error={error}
          busy={busy}
          answering={answering}
          onClear={() => setRuns([])}
        />
      </div>
    </div>
  );
}

/**
 * 실험실에 얹을 도판 id.
 *
 * 이 기계에 실제 도판이 있으면 그것을 쓴다 — 그래야 `/files/figures/{id}/raw`
 * 경로와 레터박스 좌표 변환까지 진짜로 태워진다. 없으면 null이고, 그때는
 * "주소 없는 도판"(D167) 상태가 그대로 시험된다.
 */
function useLabFigureId(): string | null {
  const { data } = useQuery<LabFigure>({
    queryKey: ["admin", "ink-lab-figure"],
    queryFn: anyFigureForLab,
    staleTime: 10 * 60 * 1000,
  });
  return data?.figure_id ?? null;
}
