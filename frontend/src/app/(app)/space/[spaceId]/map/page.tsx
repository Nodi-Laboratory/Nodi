"use client";

/**
 * 대화방 지도 화면 (D205).
 *
 * 캔버스에 얹혀 있던 미니맵을 여기로 옮겼다. 배치는 **캔버스가 계산한 것**을
 * 그대로 쓴다(`mapSnapshot`) — 여기서 다시 계산하면 카드가 그려져 있지 않아
 * 실측 크기를 알 수 없고, 그러면 캔버스와 다른 자리에 점이 찍힌다.
 *
 * 그래서 이 화면은 **캔버스를 거쳐서만** 온전하다. 주소를 직접 치고 들어오면
 * 사진이 없으므로 캔버스로 돌아가라고 말한다 — 틀린 지도를 그리는 것보다 낫다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { SessionMap } from "@/components/canvas2/SessionMap";
import { useCanvasItems } from "@/lib/canvas2/useCanvasItems";
import type { CanvasItem } from "@/lib/canvas2/types";
import type { Size } from "@/lib/canvas2/useItemLayout";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";

/** 상자 둘레 여백(px). 화면을 꽉 채우지 않는 것이 이 화면의 요점이다. */
const MARGIN = 40;
/** 상자 최대 크기. 너무 크면 다시 "화면 전체"가 되어 확대가 섞인다. */
const MAX_W = 1400;
const MAX_H = 900;

export default function SessionMapPage() {
  const params = useParams<{ spaceId: string }>();
  const spaceId = params?.spaceId ?? "personal";
  const router = useRouter();
  const snapshot = useWorkspaceStore((s) => s.mapSnapshot);
  const setPendingFocusItem = useWorkspaceStore((s) => s.setPendingFocusItem);
  const store = useCanvasItems();

  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 900, h: 600 });

  useEffect(() => {
    const read = () => {
      const el = wrapRef.current;
      if (!el) return;
      const w = Math.min(MAX_W, el.clientWidth - MARGIN * 2);
      const h = Math.min(MAX_H, el.clientHeight - MARGIN * 2);
      setBox((prev) =>
        prev.w === w && prev.h === h ? prev : { w: Math.max(320, w), h: Math.max(280, h) },
      );
    };
    read();
    window.addEventListener("resize", read);
    const ro = wrapRef.current ? new ResizeObserver(read) : null;
    if (wrapRef.current && ro) ro.observe(wrapRef.current);
    return () => {
      window.removeEventListener("resize", read);
      ro?.disconnect();
    };
  }, []);

  const mine = snapshot && snapshot.spaceId === spaceId ? snapshot : null;

  const positions = useMemo(
    () => new Map<string, { x: number; y: number }>(mine?.positions ?? []),
    [mine],
  );
  const sizes = useMemo(() => new Map<string, Size>(mine?.sizes ?? []), [mine]);
  const items = useMemo(() => (mine?.items ?? []) as CanvasItem[], [mine]);

  const back = useCallback(() => router.push(`/space/${spaceId}`), [router, spaceId]);

  /** 노드를 눌렀다 — 캔버스로 돌아가 그 카드를 크게 본다(D171과 같은 통로). */
  const open = useCallback(
    (itemId: string) => {
      setPendingFocusItem(itemId);
      back();
    },
    [back, setPendingFocusItem],
  );

  /**
   * 노드를 끌어 옮겼다 — **실제 카드 좌표**를 옮긴다.
   *
   * `moveMany`는 `pinned: true`로 저장한다. 학생이 손으로 정한 자리이므로
   * 배치 엔진이 다시 밀어내면 안 된다(D122).
   */
  const moveNode = useCallback(
    (id: string, x: number, y: number) => {
      store.moveMany([{ id, x, y }], "지도에서 옮김");
    },
    [store],
  );

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--bg)" }}>
      <header className="flex shrink-0 items-center gap-3 px-5 py-3">
        <button
          type="button"
          onClick={back}
          className="flex items-center gap-1.5 rounded-lg border border-accent-border/60 bg-bg-elevated
                     px-3 py-1.5 text-sm text-fg transition-colors hover:bg-accent-soft"
        >
          <ArrowLeft size={15} />
          캔버스로
        </button>
        <div>
          <h1 className="text-[15px] font-semibold text-fg">대화방 지도</h1>
          <p className="text-[12px] text-fg-muted">
            끌어서 둘러보고, 확대하면 글 하나하나가 보입니다. 노드를 끌면 캔버스의
            자리도 함께 옮겨집니다.
          </p>
        </div>
      </header>

      <div ref={wrapRef} className="flex min-h-0 flex-1 items-center justify-center">
        {mine ? (
          <div
            /**
             * **테두리가 두꺼운 상자.** 지도를 화면 전체로 만들면 브라우저
             * 확대와 지도 확대가 섞여 무엇이 커졌는지 알 수 없다(사용자 지시
             * 2026-08-07). 경계가 뚜렷해야 "이 안이 지도"로 읽힌다.
             */
            className="canvas2 overflow-hidden rounded-2xl"
            style={{
              border: "4px solid var(--c-rule)",
              background: "var(--c-paper)",
              boxShadow: "var(--c-shadow-lg)",
            }}
          >
            <SessionMap
              items={items}
              positions={positions}
              sizes={sizes}
              tagOrder={mine.tagOrder}
              box={box}
              onOpen={open}
              onMoveNode={moveNode}
            />
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm text-fg-muted">
              지도를 그리려면 캔버스를 한 번 열어야 해요.
            </p>
            <button
              type="button"
              onClick={back}
              className="mt-3 rounded-lg bg-accent-deep px-4 py-2 text-sm text-white"
            >
              캔버스로 가기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
