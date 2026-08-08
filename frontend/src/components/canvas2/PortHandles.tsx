"use client";

/**
 * 카드에서 끌어서 잇기 (D210 4-3).
 *
 * 카드에 손을 올리면 위·아래 변 중앙에 연결점이 뜬다. 그 점을 눌러 끌면
 * 미리보기 선이 따라오고, 다른 카드에 놓으면 연결된다.
 *
 *     아래 점에서 끌면 → 그 카드가 **부모**가 된다
 *     위 점에서 끌면   → 그 카드가 **자식**이 된다
 *
 * ## 이미 부모가 있으면 위 점을 아예 안 띄운다
 *
 * 부모는 하나뿐이라, 끌게 두면 기존 연결이 **조용히 갈아 끼워진다.** 회색으로
 * 띄워 두는 길도 있지만 그러면 학생이 끌어 보고 아무 일도 안 일어나는 것을
 * 겪는다 — **자리가 비어야 점이 보이는 규칙**이 "여기는 이미 찼다"를 그대로
 * 말해 준다. 부모를 바꾸려면 먼저 끊는다(4-4의 X).
 *
 * ## 좌우에는 점이 없다
 *
 * 포트가 둘뿐이라는 것이 이 화면의 규칙이다(4-2). 끌 수 없는 점을 보여 주면
 * 학생이 거기서 끌어 보고 안 되는 것을 결함으로 읽는다.
 */

import { useRef } from "react";
import { PAD_X, PAD_Y } from "@/lib/canvas2/connector";

/** 점의 화면 지름(px). 줌으로 나눠 어느 배율에서나 같게 보인다. */
const DOT_PX = 11;
/** 손이 닿는 자리는 보이는 것보다 넉넉하게. */
const HIT_PX = 26;

export interface PortDragStart {
  /** 어느 카드에서 끌기 시작했나. */
  id: string;
  /** 아래 포트에서 끌면 이 카드가 부모다. */
  role: "parent" | "child";
}

interface Props {
  id: string;
  zoom: number;
  color: string;
  /** 이 카드가 이미 부모를 갖고 있나 — 그러면 위 점을 안 띄운다. */
  hasParent: boolean;
  onStart: (start: PortDragStart, e: React.PointerEvent) => void;
}

export function PortHandles({ id, zoom, color, hasParent, onStart }: Props) {
  const madeRef = useRef(false);
  void madeRef;
  const d = DOT_PX / zoom;
  const hit = HIT_PX / zoom;

  const dot = (role: "parent" | "child") => (
    <button
      key={role}
      type="button"
      data-no-pan
      data-port={role}
      aria-label={role === "parent" ? "여기서 자식 잇기" : "여기서 부모 잇기"}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onStart({ id, role }, e);
      }}
      className="c2-port absolute"
      style={{
        left: "50%",
        /**
         * ⚠️ **`PAD_Y`를 줌으로 나누면 안 된다** (실측 2026-08-08).
         *
         * `PAD_Y`는 `connector.padded()`가 쓰는 **월드 값**이고, 이 요소는
         * 이미 월드 공간(오버레이가 scale)에 있다. 나누면 축소할수록 멀어져,
         * 24% 배율에서 포트가 카드 아래 **50px 허공**에 떴다. 그 사이는 카드도
         * 포트도 아니라 손을 옮기는 동안 `mouseleave`가 뜨고 **포트가 사라진다** —
         * 학생이 겪은 "연결 드래그가 안 된다"가 이것이다.
         *
         * 자동 검증은 좌표로 순간이동해서 이 결함을 통과시켰다(D210 4-3).
         * 손이 지나가는 경로를 태워야 잡힌다.
         *
         * 나누는 것은 **화면에서 크기가 일정해야 하는 값**(점·손닿는 자리)뿐이다.
         */
        [role === "parent" ? "bottom" : "top"]: -PAD_Y,
        width: hit,
        height: hit,
        marginLeft: -hit / 2,
        // 손닿는 자리는 점을 가운데 두고 **절반이 카드 쪽**에 걸치게 한다 —
        // 카드와 포트 사이에 빈틈이 없어야 hover가 안 끊긴다.
        marginBottom: role === "parent" ? -hit / 2 : undefined,
        marginTop: role === "child" ? -hit / 2 : undefined,
        display: "grid",
        placeItems: "center",
        cursor: "crosshair",
        background: "transparent",
        border: "none",
        padding: 0,
      }}
    >
      <span
        style={{
          width: d,
          height: d,
          borderRadius: "50%",
          background: "var(--c-paper)",
          border: `${2 / zoom}px solid ${color}`,
          display: "block",
        }}
      />
    </button>
  );

  return (
    <>
      {/* 아래 점은 언제나 있다 — 자식은 여럿일 수 있다. */}
      {dot("parent")}
      {/* 위 점은 **비어 있을 때만**. 위 주석 참조. */}
      {!hasParent && dot("child")}
    </>
  );
}

void PAD_X;
