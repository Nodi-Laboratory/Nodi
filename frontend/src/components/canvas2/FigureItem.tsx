"use client";

/**
 * 교과서 도판 (D86~D95) — v1의 `FigureNode`를 캔버스 v2로 이식.
 *
 * ## signed URL은 만료된다 (D87)
 *
 * 이미지 주소는 백엔드가 서명해 주고 6시간 뒤 만료된다. **저장하지 않는다** —
 * 재수화 때는 빈 문자열로 그렸다가 `getFigure`로 다시 받는다. 만료된 URL로
 * 로드가 실패하면 **1회만** 재발급한다(무한 재시도로 서버를 두드리지 않게).
 *
 * 이 로직은 v1에서 실측으로 만들어진 것이라 형태를 그대로 가져왔다.
 */

import { useEffect, useRef, useState } from "react";
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
  const [retried, setRetried] = useState(false);
  const [open, setOpen] = useState(false);

  const url = refreshed ?? fig?.url ?? "";
  const closeRef = useRef<HTMLButtonElement>(null);

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

  const refresh = () => {
    if (retried || !fig.figureId) return;
    setRetried(true);
    void getFigure(fig.figureId)
      .then((f) => setRefreshed(f.url ?? ""))
      .catch(() => {
        /* 만료 재발급 실패 — 스켈레톤으로 남는다 */
      });
  };

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
              onError={refresh}
              className="block max-h-64 w-full object-contain"
              style={{ background: "var(--c-sunk)" }}
            />
          ) : (
            <div
              className="flex h-40 items-center justify-center text-sm"
              style={{ background: "var(--c-sunk)", color: "var(--c-ink-faint)" }}
            >
              도판 불러오는 중…
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
