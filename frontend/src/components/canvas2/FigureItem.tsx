"use client";

/**
 * 교과서 도판 (D86~D95) — v1의 `FigureNode`를 캔버스 v2로 이식.
 *
 * ## signed URL은 만료된다 (D87)
 *
 * 이미지 주소는 백엔드가 서명해 주고 6시간 뒤 만료된다. **저장하지 않는다** —
 * 주소가 없으면 `getFigure`로 받아 온다. 만료된 URL로 로드가 실패해도 같은
 * 창구로 **1회만** 재발급한다(무한 재시도로 서버를 두드리지 않게).
 *
 * ## 주소가 없을 때도 받아 와야 한다 (D167)
 *
 * 예전에는 재발급을 **`<img onError>`에서만** 걸었다. 그런데 주소가 비면
 * `<img>` 자체를 안 그리므로 onError가 일어날 수 없다 — 받아 올 방아쇠가
 * 없는 채로 "도판 불러오는 중…"에 **영원히** 멈춘다. 스켈레톤이라 고장으로
 * 안 보이고 로딩으로 보이는 것이 이 결함의 고약한 점이었다.
 *
 * 주소가 비는 건 예외가 아니라 **정상 경로**다(실측 2026-08-04):
 *   · 답이 저장되면 서버 행이 로컬을 대체하는데 그 행에는 url이 없다(D87).
 *     생성 1.3초 뒤 살아 있던 이미지가 스켈레톤으로 바뀌었다.
 *   · 새로고침(재수화) 뒤에도 마찬가지다.
 * 그래서 "url이 없으면 받는다"가 기본 동작이어야 한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { getFigure } from "@/lib/api/retrieve";
import { ITEM_W } from "@/lib/canvas2/layout";
import type { CanvasItem } from "@/lib/canvas2/types";

interface Props {
  item: CanvasItem;
  x: number;
  y: number;
  measure: (id: string, el: HTMLElement | null) => void;
}

export function FigureItem({ item, x, y, measure }: Props) {
  const fig = item.data.figure;
  // 재발급으로 얻은 url만 상태로 들고, 평소에는 prop을 그대로 쓴다.
  //
  // prop을 state로 복사하면 이펙트에서 setState를 부르게 되고(연쇄 렌더),
  // 두 곳에 같은 값이 생겨 어느 쪽이 진실인지 흐려진다.
  const [refreshed, setRefreshed] = useState<string | null>(null);
  /** 재발급이 실패로 끝났나. 스켈레톤을 영원히 두지 않으려고 구분한다. */
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const url = refreshed ?? fig?.url ?? "";
  const figureId = fig?.figureId;
  const closeRef = useRef<HTMLButtonElement>(null);
  /**
   * 요청이 나가 있는 중인가. state가 아니라 ref인 이유는 둘이다 — 이 값이
   * 바뀐다고 다시 그릴 것이 없고, 이펙트 안에서 **동기 setState**를 하면
   * React Compiler 규칙에 걸린다(이펙트에서의 ref 쓰기는 허용된다).
   */
  const inflight = useRef(false);
  /** 이 도판에 쓴 요청 수. 최초 발급 + 만료 재발급 1회까지만 허용한다. */
  const tries = useRef(0);

  /**
   * 주소를 받아 온다. 두 경로가 **같은 창구**를 쓴다 (D167) — 처음부터 없을
   * 때(아래 이펙트)와 만료돼 로드가 깨졌을 때(`<img onError>`).
   *
   * 성공/실패 여부를 `alive` 플래그로 버리지 않는다. 버리면 StrictMode의
   * 이중 마운트에서 첫 응답이 사라지는데, 그때 "이미 요청했다"는 빗장만
   * 남아 **영영 못 받는 상태**가 된다(실측 2026-08-04: 200 응답이 왔는데도
   * 새로고침 뒤 스켈레톤 그대로였다). 언마운트 뒤 setState는 React 19에서
   * 무해한 no-op이므로 그냥 두는 편이 안전하다.
   */
  const request = useCallback(() => {
    if (!figureId || inflight.current || tries.current >= 2) return;
    inflight.current = true;
    tries.current += 1;
    void getFigure(figureId)
      .then((f) => {
        inflight.current = false;
        if (f.url) setRefreshed(f.url);
        else setFailed(true);
      })
      .catch(() => {
        inflight.current = false;
        setFailed(true);
      });
  }, [figureId]);

  /** 주소가 없으면 받아 온다. 실패로 끝났으면 더 조르지 않는다. */
  useEffect(() => {
    if (url || failed) return;
    request();
  }, [url, failed, request]);

  // 라이트박스: Escape로 닫고, 열릴 때 닫기 버튼에 포커스를 준다.
  // role="dialog"인데 키보드로 나갈 방법이 없으면 갇힌다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!fig) return null;

  return (
    <>
      <div
        ref={(el) => measure(item.id, el)}
        data-canvas-item={item.id}
        // E2E가 도판을 집는 손잡이 (D163, ClipItem의 data-canvas-clip과 대칭).
        data-canvas-figure={item.data.figure?.figureId}
        className="absolute"
        style={{
          left: x,
          top: y,
          width: ITEM_W,
          pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
          zIndex: 10,
          // 글(TextItem)과 같은 이징. 없으면 재배치 때 글만 미끄러지고
          // 도판은 즉시 점프해 280ms 동안 화면이 어긋나 보인다.
          transition:
            "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
        }}
      >
        <div
          aria-hidden
          className="absolute"
          style={{
            left: -16,
            top: 2,
            bottom: 2,
            width: 2,
            borderRadius: 2,
            background: "var(--c-live)",
            opacity: 0.85,
          }}
        />
        <button
          type="button"
          data-no-pan
          onClick={() => url && setOpen(true)}
          className="block w-full overflow-hidden rounded-lg border text-left transition-colors"
          style={{ borderColor: "var(--c-rule)", background: "var(--c-raised)" }}
        >
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={fig.caption || "교과서 도판"}
              onError={request}
              className="block max-h-64 w-full object-contain"
              style={{ background: "var(--c-sunk)" }}
            />
          ) : (
            <div
              className="flex h-40 items-center justify-center text-sm"
              style={{ background: "var(--c-sunk)", color: "var(--c-ink-faint)" }}
            >
              {/* 끝난 실패를 "불러오는 중"으로 두지 않는다 (D167) — 그게 이
                  결함이 오래 안 보였던 이유다. */}
              {failed ? "도판을 불러오지 못했어요" : "도판 불러오는 중…"}
            </div>
          )}
          <div className="px-3 py-2">
            <p className="line-clamp-2 text-[13px]" style={{ color: "var(--c-ink)" }}>
              {fig.caption || "설명 없음"}
            </p>
            <p className="label mt-1" style={{ color: "var(--c-ink-faint)", letterSpacing: 0 }}>
              교과서 {fig.page}쪽
            </p>
          </div>
        </button>
      </div>

      {/* 라이트박스는 body로 포털한다 — 변환 평면(scale) 안에서는 position:fixed가
          뷰포트 기준으로 동작하지 않는다(v1에서 같은 이유로 포털했다). */}
      {open &&
        url &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-8"
            style={{ background: "var(--c-overlay)" }}
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={fig.caption || "교과서 도판"}
              className="max-h-full max-w-full rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="닫기"
              className="absolute right-6 top-6 rounded-full p-2"
              style={{ background: "var(--c-on-dark)", color: "var(--c-paper)" }}
            >
              <X size={18} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
