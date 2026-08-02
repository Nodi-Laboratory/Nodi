"use client";

/**
 * 캔버스 글 아이템 — v1의 `ConceptCard`를 대체한다.
 *
 * ## 카드가 아니다
 *
 * 평소에는 **글자만** 있다. 테두리도 배경도 그림자도 없다. 마우스를 올리면
 * 반투명 박스가 뒤에 깔리고, 클릭하면 우상단에 `⋯`가 뜬다(사용자 지시).
 *
 * 유일한 상시 크롬은 **좌측 세로 괘선** 하나다. 색이 곧 정보다:
 *
 *     오커  AI가 쓴 글
 *     틸    학생이 쓴 글
 *
 * 여백 주석(marginalia)의 형태를 빌린 것이고, 캔버스를 멀리서 봐도 학생이
 * 스스로 채운 분량이 한눈에 보인다.
 *
 * ## 폭은 내용이 정한다
 *
 * `width: fit-content` + `maxWidth: ITEM_W`. 한 줄짜리 메모가 460px를 차지하고
 * 그 빈 자리에서 연결선이 출발하던 문제(사용자 지적)를 없앤다. 편집할 때만
 * 폭을 최대로 고정한다 — 글자를 지울 때마다 상자가 줄어들면 쓸 수가 없다.
 *
 * ## hover 박스가 레이아웃을 흔들면 안 된다
 *
 * 박스를 실제 요소로 넣으면 ResizeObserver 크기가 hover마다 달라져 배치가
 * 진동한다. 흐름 밖(absolute)에 두고 패딩은 늘 잡아 둔다 — 배경만 나타난다.
 *
 * ## 드래그 중에는 React를 건드리지 않는다
 *
 * 매 프레임 setState하면 아이템 전체가 리렌더된다(v1이 정확히 그래서 느렸다).
 * DOM transform만 직접 갱신하고 `pointerup`에서 한 번 커밋한다.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ITEM_MIN_W, ITEM_W } from "@/lib/canvas2/layout";
import { clearDragOffsets, setDragOffsets } from "@/lib/canvas2/dragBus";
import type { CanvasItem } from "@/lib/canvas2/types";
import { AskAgainButton } from "./AskAgainButton";
import { ItemBody } from "./ItemBody";
import { ItemMenu } from "./ItemMenu";
import { QuestionTip } from "./QuestionTip";
import { ResizeHandles, type ResizeCommit } from "./ResizeHandles";
import { ReflowButton } from "./ReflowButton";

/** 드래그로 인정하는 최소 이동(화면 px). 이보다 작으면 클릭이다. */
const DRAG_THRESHOLD = 4;
/** 위치 커밋이 끝내 안 올 때 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;

/**
 * 함께 끌 요소들. **캐시하지 않고 그때그때 조회한다.**
 *
 * ref 안에 배열로 담아 두면 React Compiler가 "훅에 넘긴 값을 나중에 고칠 수
 * 없다"고 막는다(react-hooks/immutability). 속성 선택자 조회는 마이크로초
 * 단위라 매 프레임 불러도 괜찮다.
 */
function peerEls(group: boolean, self: HTMLElement | null): HTMLElement[] {
  const out = group
    ? Array.from(
        document.querySelectorAll<HTMLElement>('[data-canvas-item][data-selected="1"]'),
      )
    : [];
  if (self && !out.includes(self)) out.push(self);
  return out;
}

export interface TextItemProps {
  item: CanvasItem;
  x: number;
  y: number;
  selected: boolean;
  editing: boolean;
  tagOptions: readonly string[];
  /**
   * 이 글이 답인 질문의 원문. 하단 입력창으로 물어 만든 글에만 있다.
   * hover하면 위쪽에 한 줄로 떠서 "무엇을 물어본 답인지"를 알려 준다.
   */
  question?: string | null;
  /** 현재 줌. 화면 이동량을 world로 바꾸는 데 필요하다. */
  zoom: number;
  /** 크기 실측 등록. 호출부에서 안정적인 함수다(useItemLayout 참조). */
  measure: (id: string, el: HTMLElement | null) => void;
  /** `additive`(Shift·⌘)면 기존 선택에 더한다. */
  onSelect: (id: string | null, additive?: boolean) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, body: string) => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onTagChange: (id: string, tag: string | null) => void;
  /** 이동량도 함께 준다 — 여럿이 선택돼 있으면 호출부가 전부에 같은 양을 적용한다. */
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
  onReflow: (id: string) => void;
  onDismissReflow: (id: string) => void;
  /** "다시 질문하기" — 이 답을 인용한 채 입력창을 연다 (D149). */
  onAsk: (id: string) => void;
  /** 손잡이로 상자 크기를 바꿨다 (D142). */
  onResize: (id: string, next: ResizeCommit) => void;
  /** 상자를 자동 크기로 되돌린다. */
  onResetSize: (id: string) => void;
}

function TextItemImpl(props: TextItemProps) {
  const {
    item,
    x,
    y,
    selected,
    editing,
    tagOptions,
    question,
    zoom,
    measure,
    onSelect,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    onDelete,
    onTagChange,
    onDragEnd,
    onReflow,
    onDismissReflow,
    onAsk,
    onResize,
    onResetSize,
  } = props;

  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** ⋯ 메뉴가 펼쳐져 있나. 펼친 동안은 마우스가 나가도 메뉴를 붙잡아 둔다. */
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sx: number;
    sy: number;
    moved: boolean;
    /** 선택된 것들을 함께 끄는 드래그인가. */
    group: boolean;
    /** 누를 때 이미 선택돼 있었나. 손을 뗐을 때 무엇을 할지가 여기서 갈린다. */
    wasSelected: boolean;
    additive: boolean;
  } | null>(null);
  /** 학생이 손잡이로 정한 크기. 없으면 내용이 정한다 (D142). */
  const size = item.data.size;
  const isAi = item.source === "ai";
  const accent = isAi ? "var(--c-live)" : "var(--c-hand)";
  const wash = isAi ? "var(--c-live-wash)" : "var(--c-hand-wash)";
  // **편집 중에는 박스를 그리지 않는다**(사용자 지시). 글을 쓰는 중에 테두리와
  // 바탕이 깔리면 캔버스가 아니라 입력 폼처럼 보인다.
  const active = !editing && (hover || selected);

  const setNode = useCallback(
    (el: HTMLDivElement | null) => {
      rootRef.current = el;
      measure(item.id, el);
    },
    [measure, item.id],
  );

  /**
   * 드롭 뒤 남은 transform을 걷어낸다.
   *
   * "인라인 transform이 남아 있고 지금 끄는 중이 아니면 정리한다"로 판정하므로
   * **함께 끌린 다른 아이템도 각자 알아서 정리된다** — 누가 누구를 끌었는지
   * 기억할 필요가 없다.
   */
  const settle = useCallback(() => {
    const el = rootRef.current;
    if (!el || dragRef.current || !el.style.transform) return;
    // 전이를 켠 채 transform을 지우면 요소가 원래 자리로 갔다가 다시 오는
    // 것처럼 보인다 — 사용자가 말한 "클릭을 놓으면 잠깐 깜박거리는 현상".
    const prev = el.style.transition;
    el.style.transition = "none";
    el.style.transform = "";
    void el.offsetHeight; // 강제 리플로우 — transition:none을 이 프레임에 확정
    el.style.transition = prev;
    setDragging(false);
  }, []);

  // 새 좌표가 도착한 프레임에 정리한다(페인트 전이라 중간 상태가 안 보인다).
  useLayoutEffect(() => {
    settle();
  }, [x, y, settle]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      // 왼쪽 버튼만 드래그다. 중버튼(휠클릭)은 화면 팬이므로 놓아 준다.
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-no-pan]")) return; // 버튼·메뉴는 자기 일을 한다

      // **본문 위에서도 드래그로 옮긴다**(사용자 지시).
      //
      // 한동안은 본문을 잡으면 글자가 선택되게 뒀는데, 정작 원한 건 박스
      // 이동이었다. 글자 선택은 편집 모드(더블클릭)에서 하면 된다.
      e.stopPropagation(); // Excalidraw가 선택 상자를 그리지 않게

      /**
       * 선택은 **여기서 한 번만** 정한다.
       *
       * 예전에는 pointerdown과 pointerup에서 각각 `onSelect`를 불렀다. 평범한
       * 클릭에서는 티가 안 났지만 Shift는 토글이라 **두 번 뒤집혀 제자리로
       * 돌아왔다** — 실측: 하나 고른 뒤 Shift로 하나 더 누르면 선택이 0이 됐다.
       *
       *   Shift            → 토글(여기서 끝)
       *   선택 안 된 것     → 이것 하나만
       *   이미 선택된 것    → 여기선 그대로 둔다. 끌면 함께 움직이고,
       *                       움직이지 않았으면 손 뗄 때 이 하나로 좁힌다.
       */
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (additive) onSelect(item.id, true);
      else if (!selected) onSelect(item.id, false);

      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
        group: selected,
        wasSelected: selected,
        additive,
      };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // 활성 포인터가 아니면 던진다(합성 이벤트·펜 태블릿 일부). 캡처는
        // 편의일 뿐이라 없어도 드래그는 동작한다 — 콘솔만 더럽히지 않는다.
      }
    },
    [editing, item.id, onSelect, selected],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!d.moved) {
        d.moved = true;
        setDragging(true);
      }
      // React를 거치지 않는다 — 60fps로 리렌더하면 긴 문단에서 즉시 버벅인다.
      // 함께 선택된 것들도 같은 양만큼 민다.
      const wx = dx / zoom;
      const wy = dy / zoom;
      const shift = `translate(${wx}px, ${wy}px)`;
      const peers = peerEls(d.group, rootRef.current);
      for (const el of peers) {
        el.style.transition = "none";
        el.style.transform = shift;
      }
      // 연결선도 같이 움직여야 한다 — 상자만 가고 선이 남으면 관계가 끊겨
      // 보인다(사용자 지적). 역시 React를 거치지 않는다.
      setDragOffsets(
        peers.map((el) => el.getAttribute("data-canvas-item") ?? "").filter(Boolean),
        wx,
        wy,
      );
    },
    [zoom],
  );

  const finishDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;

      const peers = peerEls(d.group, rootRef.current);
      // 연결선은 이제 React가 낸 최종 좌표를 쓴다.
      clearDragOffsets();
      if (!d.moved) {
        // 움직이지 않은 클릭. 선택은 pointerdown에서 이미 정해졌고, 남은 경우는
        // 하나뿐이다 — 여럿이 잡힌 상태에서 그중 하나를 그냥 눌렀을 때
        // **그 하나로 좁힌다.**
        if (!d.additive && d.wasSelected) onSelect(item.id, false);
        setDragging(false);
        for (const el of peers) el.style.transition = "";
        return;
      }
      const dx = (e.clientX - d.sx) / zoom;
      const dy = (e.clientY - d.sy) / zoom;
      // transform은 **지우지 않는다.** 새 left/top이 오기 전에 지우면 한 프레임
      // 원래 자리로 돌아갔다 오면서 깜박인다. settle()이 정리한다.
      for (const el of peers) el.style.transition = "";
      onDragEnd(item.id, x + dx, y + dy, dx, dy);
      // 좌표가 끝내 안 바뀌는 경우(같은 자리 재배치)의 안전망.
      window.setTimeout(settle, DROP_FALLBACK_MS);
    },
    [item.id, onDragEnd, onSelect, settle, x, y, zoom],
  );

  // 언마운트 시 남은 타이머의 커서·스타일 잔재를 정리한다.
  useEffect(() => () => {
    dragRef.current = null;
  }, []);

  const showReflow = item._needsReflow && !item.data.reflowDismissed && !editing;
  /**
   * "다시 질문하기"는 **AI가 쓴 답에만** 붙인다 (D149, 사용자 지시).
   *
   * 학생이 쓴 글에는 붙이지 않는다 — 자기가 방금 쓴 메모를 AI에게 넘기는
   * 것보다, 답을 읽다 막힌 자리에서 바로 잇는 편이 실제로 묻는 자리다.
   * 스트리밍 중인 글은 아직 다 나오지도 않았다.
   */
  const showAsk = isAi && !item._pending && !editing && (hover || selected);

  return (
    <div
      ref={setNode}
      data-canvas-item={item.id}
      // 함께 끌 대상을 DOM에서 찾기 위한 표식. props로 선택 집합을 내려보내면
      // memo(TextItem)이 매번 깨진다.
      data-selected={selected ? "1" : undefined}
      className="absolute"
      style={{
        left: x,
        top: y,
        /**
         * 내용만큼만 차지하되 읽기 폭을 넘지 않는다.
         *
         * **`fit-content`가 아니라 `max-content`다.** 절대 배치 요소에서
         * `fit-content`의 "가용 폭"은 `컨테이너 폭 − left`로 잡히는데, 오버레이는
         * 화면 폭이라 오른쪽 열에 놓인 글일수록 가용 폭이 줄어든다. 실측:
         * left 1366px 아이템이 최소폭 132px까지 찌그러져 높이 682px짜리 세로
         * 기둥이 됐다. `max-content`는 가용 폭을 보지 않으므로 maxWidth만이
         * 상한이 되고, 어디에 놓이든 같은 폭이 나온다(배치의 전제이기도 하다).
         *
         * 편집 중에는 최대 폭으로 고정한다 — 글자를 지울 때마다 입력 상자가
         * 줄어들면 쓸 수가 없다.
         */
        // 학생이 손잡이로 정했으면 그 값이 우선이다 — 읽기 폭 상한(ITEM_W)도
        // 학생의 결정 앞에서는 물러난다(D142).
        width: size ? size.w : editing ? ITEM_W : "max-content",
        maxWidth: size ? undefined : ITEM_W,
        minWidth: editing ? undefined : ITEM_MIN_W,
        // **최소** 높이다. 내용이 더 길면 상자가 늘어난다(잘린 글은 사고다).
        minHeight: size?.h,
        pointerEvents: "var(--c2-item-events)" as React.CSSProperties["pointerEvents"],
        zIndex: selected || editing ? 12 : dragging ? 11 : 10,
        cursor: editing ? "auto" : dragging ? "grabbing" : "grab",
        // 본문을 잡으면 이동이므로 글자가 딸려 선택되지 않게 막는다.
        userSelect: editing ? "auto" : "none",
        // 배치가 옮길 때는 부드럽게, 드래그 중에는 즉시.
        transition: dragging
          ? "none"
          : "left .28s cubic-bezier(.22,.9,.24,1), top .28s cubic-bezier(.22,.9,.24,1)",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit(item.id);
      }}
      // 키보드만으로도 다룰 수 있어야 한다 — 예전에는 선택·편집·삭제가 전부
      // 포인터 전용이었다.
      tabIndex={editing ? -1 : 0}
      role="group"
      aria-label={item.title ?? (item.source === "ai" ? "AI가 쓴 글" : "내가 쓴 글")}
      /**
       * 키보드로 왔을 때만 선택한다.
       *
       * 마우스로 누른 경우는 pointerdown이 이미 정했다. 거기서 다시 부르면
       * **수식 키 정보가 없어서** Shift로 더한 선택을 통째로 덮어쓴다 —
       * 실측: Shift+클릭이 "더하기"가 아니라 "교체"로 동작했다.
       *
       * `:focus-visible`은 정확히 이 구분이다(키보드 포커스에만 붙는다).
       */
      onFocus={(e) => {
        if (!e.currentTarget.matches(":focus-visible")) return;
        onSelect(item.id);
      }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onStartEdit(item.id);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onDelete(item.id);
        } else if (e.key === "Escape") {
          onSelect(null);
          (e.currentTarget as HTMLElement).blur();
        }
      }}
    >
      {/* hover/선택 박스 — 흐름 밖에 둬서 크기에 영향을 주지 않는다 */}
      <div
        aria-hidden
        className="pointer-events-none absolute transition-opacity duration-150"
        style={{
          inset: "-12px -16px",
          borderRadius: "var(--c-radius)",
          background: active ? wash : "transparent",
          // 고른 상태는 도형 선택과 같은 굵기로 또렷하게. zoom으로 나눠
          // 어느 배율에서나 같은 두께로 보인다(도형 쪽이 그렇다).
          border: `${selected ? Math.max(1, 1.5 / zoom) : 1}px solid ${
            selected ? accent : active ? "var(--c-rule)" : "transparent"
          }`,
          opacity: active ? 1 : 0,
          boxShadow: dragging ? "var(--c-shadow-lg)" : "none",
        }}
      />

      {/* 고른 상자는 도형과 같은 모습이어야 한다 — 테두리 + 여덟 손잡이 (D142) */}
      {selected && !editing && !dragging && (
        <ResizeHandles
          zoom={zoom}
          color={accent}
          getEl={() => rootRef.current}
          onCommit={(next) => {
            onResize(item.id, next);
            // 새 좌표가 끝내 안 오는 경우(폭만 바꿨을 때)의 안전망 — 남은
            // transform을 걷어낸다.
            window.setTimeout(settle, DROP_FALLBACK_MS);
          }}
          onReset={() => onResetSize(item.id)}
        />
      )}

      {/* 이 답을 부른 질문 — hover하면 위쪽에 한 줄로 뜬다 */}
      {question && (hover || selected) && !editing && <QuestionTip text={question} />}

      {/* 좌측 괘선 — 유일한 상시 크롬. 색이 곧 출처다. */}
      <div
        aria-hidden
        className="absolute transition-all duration-150"
        style={{
          left: -16,
          top: 2,
          bottom: 2,
          // 학생의 자국을 조금 더 굵게. 색만으로는 축소했을 때 구분이 약하다 —
          // 굵기라는 두 번째 신호를 보태면 색약이 있어도 구별된다.
          width: active ? (isAi ? 4 : 5) : isAi ? 2 : 3,
          borderRadius: 2,
          background: accent,
          opacity: item._pending ? 0.4 : active ? 1 : 0.85,
          transformOrigin: "top",
          animation: item._pending ? undefined : "c2-rule-draw .28s ease-out",
        }}
      />

      <div className="relative">
        {item.title && (
          <h3
            className="ui mb-2 text-[17px] font-semibold leading-snug"
            style={{ color: "var(--c-ink)" }}
          >
            {item.title}
          </h3>
        )}

        <div
          data-item-text
          className="text-[15px]"
          style={{ color: "var(--c-ink)" }}
        >
          <ItemBody
            body={item.body}
            editing={editing}
            streaming={item._pending}
            onCommit={(next) => onCommitEdit(item.id, next)}
            onCancel={onCancelEdit}
          />
        </div>

        {(showReflow || showAsk) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showReflow && (
              <ReflowButton
                onReflow={() => onReflow(item.id)}
                onDismiss={() => onDismissReflow(item.id)}
              />
            )}
            {showAsk && <AskAgainButton onAsk={() => onAsk(item.id)} />}
          </div>
        )}

        {/* hover만으로도 뜬다(사용자 지시) — 메뉴를 쓰려고 먼저 클릭해야 하는
            단계를 없앤다. `menuOpen`을 함께 보는 이유는, 메뉴를 펼쳐 둔 채
            마우스가 글 밖으로 나가면 메뉴가 통째로 사라지기 때문이다. */}
        {(hover || selected || editing || menuOpen) && (
          <ItemMenu
            tag={item.tag}
            tagOptions={tagOptions}
            onEdit={() => onStartEdit(item.id)}
            onDelete={() => onDelete(item.id)}
            onTagChange={(t) => onTagChange(item.id, t)}
            resized={!!size}
            onResetSize={() => onResetSize(item.id)}
            onOpenChange={setMenuOpen}
          />
        )}
      </div>
    </div>
  );
}

export const TextItem = memo(TextItemImpl);
