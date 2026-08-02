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

import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { EyeOff } from "lucide-react";
import { ITEM_MIN_W, ITEM_W } from "@/lib/canvas2/layout";
import { useItemDrag } from "@/lib/canvas2/useItemDrag";
import type { CanvasItem } from "@/lib/canvas2/types";
import { AskFromNoteButton } from "./AskFromNoteButton";
import { ItemBody } from "./ItemBody";
import { ItemMenu } from "./ItemMenu";
import { RecallPanel } from "./RecallPanel";
import { QuestionTip } from "./QuestionTip";
import { ResizeHandles, type ResizeCommit } from "./ResizeHandles";
import { ReflowButton } from "./ReflowButton";

/** 리사이즈 커밋 뒤 남은 transform을 걷어내는 안전망(ms). */
const DROP_FALLBACK_MS = 300;

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
  onAsk: (id: string) => void;
  onDismissAsk: (id: string) => void;
  /** 인출 연습에서 학생이 쓴 회상을 자식 글로 남긴다 (D138). */
  onRecall: (id: string, text: string) => void;
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
    onDismissAsk,
    onRecall,
    onResize,
    onResetSize,
  } = props;

  const [hover, setHover] = useState(false);
  /** ⋯ 메뉴가 펼쳐져 있나. 펼친 동안은 마우스가 나가도 메뉴를 붙잡아 둔다. */
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * 인출 연습 중인가 (D138). `hidden`이면 본문을 가린다 — **보면서 쓰면
   * 인출이 아니라 베끼기다.** 쓰고 나면 `compare`로 넘어가 원문을 다시 보인다.
   */
  const [recall, setRecall] = useState<"off" | "hidden" | "compare">("off");
  const rootRef = useRef<HTMLDivElement>(null);
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

  // 드래그·선택은 도판과 공유하는 훅이 맡는다 (D147). 편집 중에는 드래그하지
  // 않고 글자 선택이 되어야 하므로 enabled를 끈다.
  const { dragging, settle, handlers: dragHandlers } = useItemDrag({
    id: item.id,
    x,
    y,
    zoom,
    selected,
    enabled: !editing,
    rootRef,
    onSelect,
    onDragEnd,
  });

  // 새 좌표가 도착한 프레임에 정리한다(페인트 전이라 중간 상태가 안 보인다).
  useLayoutEffect(() => {
    settle();
  }, [x, y, settle]);

  const showReflow = item._needsReflow && !item.data.reflowDismissed && !editing;
  const showAsk =
    item.source === "user" && !item.data.askHidden && !editing && (hover || selected);
  /**
   * 인출 버튼은 **AI가 쓴 개념 글에만** 붙인다 (D138).
   *
   * 학생이 쓴 글은 이미 자기가 산출한 것이라 다시 꺼낼 대상이 아니고,
   * 스트리밍 중인 글은 아직 읽지도 않았다.
   */
  const showRecall =
    isAi &&
    item.kind === "concept" &&
    !item._pending &&
    !editing &&
    recall === "off" &&
    (hover || selected);

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
      onPointerDown={dragHandlers.onPointerDown}
      onPointerMove={dragHandlers.onPointerMove}
      onPointerUp={dragHandlers.onPointerUp}
      onPointerCancel={dragHandlers.onPointerCancel}
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
          style={{
            color: "var(--c-ink)",
            // **인출 중에는 본문을 가린다** — 보면서 쓰면 베끼기가 된다(D138).
            // 지우지 않고 흐리는 이유: 높이가 바뀌면 배치가 흔들리고, 뒤에 글이
            // 있다는 사실 자체는 보여야 "가려 뒀다"로 읽힌다.
            filter: recall === "hidden" ? "blur(6px)" : undefined,
            opacity: recall === "hidden" ? 0.35 : 1,
            userSelect: recall === "hidden" ? "none" : undefined,
            pointerEvents: recall === "hidden" ? "none" : undefined,
            transition: "filter .18s ease, opacity .18s ease",
          }}
          aria-hidden={recall === "hidden"}
        >
          <ItemBody
            body={item.body}
            editing={editing}
            streaming={item._pending}
            onCommit={(next) => onCommitEdit(item.id, next)}
            onCancel={onCancelEdit}
          />
        </div>

        {recall !== "off" && (
          <RecallPanel
            onCommit={(text) => onRecall(item.id, text)}
            onCancel={() => setRecall("off")}
            onReveal={() => setRecall("compare")}
          />
        )}

        {(showReflow || showAsk || showRecall) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {showRecall && (
              <button
                type="button"
                data-no-pan
                onClick={(e) => {
                  e.stopPropagation();
                  setRecall("hidden");
                }}
                title="본문을 가리고 기억나는 만큼 써 봅니다"
                className="label flex items-center gap-1 rounded-full px-2 py-1 transition-colors"
                style={{
                  background: "var(--c-hand-wash)",
                  color: "var(--c-hand)",
                  letterSpacing: 0,
                }}
              >
                <EyeOff size={12} />
                안 보고 다시 말해보기
              </button>
            )}
            {showReflow && (
              <ReflowButton
                onReflow={() => onReflow(item.id)}
                onDismiss={() => onDismissReflow(item.id)}
              />
            )}
            {showAsk && (
              <AskFromNoteButton
                onAsk={() => onAsk(item.id)}
                onDismiss={() => onDismissAsk(item.id)}
              />
            )}
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
