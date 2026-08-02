# 교과서 도판 조작(리사이즈·삭제·이동·영속) 설계

- 날짜: 2026-08-02
- 상태: 승인 대기(스펙 리뷰)

## 문제

ReAct 경로가 학생 질문에 맞는 교과서 도판(`kind='figure'`)을 캔버스에 띄운다
(D95: top-3, 세션 내 중복 제거). 그런데 이 도판은 **읽기 전용**이다 — 라이트박스
확대만 되고, 글 상자(TextItem)가 하는 **선택·이동·리사이즈·삭제**가 하나도 안 된다.
학생이 도판을 원하는 자리로 옮기거나 크기를 맞추거나 필요 없는 것을 지울 수 없다.

원인은 단순하다. `ItemLayer`가 `FigureItem`에 `item/x/y/measure`만 넘기고
조작 핸들러를 주지 않으며, `FigureItem` 자체에 드래그·선택·리사이즈·삭제 배선이
없다. TextItem에는 이 전부가 이미 있다.

## 목표

ReAct로 뜬 도판을 글 상자와 **동등하게** 다룰 수 있게 한다:

- **이동** — 드래그로 옮기고, 옮긴 자리는 새로고침 후에도 유지된다.
- **리사이즈** — 여덟 손잡이로 크기 조절. **가로세로 비율 고정**(이미지가 찌그러지지
  않는다). 조절한 크기도 새로고침 후 유지된다.
- **삭제** — × 버튼 또는 키보드 Delete/Backspace.
- **선택** — 클릭·올가미·그룹 선택(글 상자와 섞어서). 선택 시 테두리 표시.

## 비목표 (YAGNI)

- **도판을 수동으로 브라우징해 추가하는 피커** — 아니다. 사용자 확인 결과
  "추가"는 ReAct로 불러와지는 것을 뜻하며, 그건 이미 동작한다. 파일별 도판 목록
  엔드포인트·피커 UI는 만들지 않는다.
- **도판 편집·태그·인출 연습** — 도판엔 본문이 없다. ItemMenu의 편집/태그/인출은
  붙이지 않는다.
- **백엔드 변경** — 저장·조회·삭제 엔드포인트(`canvas_items` CRUD, `PATCH`,
  `DELETE`, `GET /files/figures/{id}`)가 전부 이미 있다. 서버는 손대지 않는다.

## 이미 존재하는 것 (재사용)

도판은 스트림 완료 시 이미 `canvas_items` 행으로 저장된다(`useCanvasStream`
`toPayload`, `pinned=false`, `data.figure`에 url 제외 메타). 따라서:

- **위치 영속 인프라 완비** — 행에 `x`/`y`/`pinned` 컬럼이 있다.
- **핸들러 완비** — `CanvasWorkspace`의 `onSelect`·`onDragEnd`·`onResize`·
  `onResetSize`·`onDelete`가 이미 TextItem용으로 존재하고 도판에도 그대로 맞는다.
- **저장·되돌리기·그룹 이동·연결선 추종**(`useCanvasItems`, `dragBus`) 완비.
- **리사이즈 손잡이**(`ResizeHandles`) 완비.

## 위치 영속 — 새 저장 로직은 없다

핵심: **`pinned=true` + DB `x`/`y` 컬럼**이 곧 영속이다. 글 상자가 쓰는 것과
같은 경로다.

**저장(드래그/리사이즈 종료 시)**

```
학생이 도판을 끌어 놓음
  → 드래그 훅이 onDragEnd(id, x, y) 호출
  → CanvasWorkspace.onDragEnd → store.patch(id, { x, y, pinned: true })
  → PATCH /api/canvas/items/{id}   (기존 행의 x·y·pinned 갱신)
```

**복원(새로고침)**

```
GET /api/sessions/{id}/canvas → 도판 행 (pinned=true, x, y)
  → layout.ts 배치 엔진:
       pinned=false → 태그 열로 자동 배치 (저장된 x/y 무시)
       pinned=true  → 저장된 x/y를 그대로 쓰고 장애물로만 읽음 (안 옮김)
```

`useItemLayout` 캐시 키(96–97줄)도 `pinned`일 때만 x/y를 포함한다. 즉 도판이
`onDragEnd`/`onResize`를 부르게 배선만 하면 좌표·크기가 자동으로 남는다.

## 설계

### 판단 1 — 공유 드래그 훅 `useItemDrag` 추출

드래그·선택·settle(transform 정리)·그룹 이동·`dragBus` 연결선 추종 로직은
현재 TextItem에 ~130줄로 있고, 주석이 "실측으로 만든 미묘한 코드"라고 반복
경고한다. 이 로직을 도판에 넣는 방법 중 **공유 훅 추출**을 택한다 —
CLAUDE.md가 "파싱 구현 넷째를 만들면 반드시 어긋난다"고 못박는 정신을 그대로
적용한다. 복제하면 글·도판의 드래그가 시간이 지나며 갈라진다.

`useItemDrag`가 소유하는 것:

- pointerdown/move/up/cancel 핸들러
- `dragging` 상태
- pointerdown 시 선택 확정(additive 토글 / 단일 선택 / 그룹 유지)
- 함께 선택된 아이템(`[data-canvas-item][data-selected="1"]`) 동반 이동
- `dragBus`로 연결선 추종
- 좌표 도착 프레임에 transform 걷어내는 `settle`
- 드롭 안전망 타이머(`DROP_FALLBACK_MS`)

훅 인터페이스(초안):

```ts
interface UseItemDragArgs {
  id: string;
  x: number;
  y: number;
  zoom: number;
  selected: boolean;
  enabled: boolean;            // 편집 중이면 false (TextItem)
  rootRef: RefObject<HTMLElement | null>;
  onSelect: (id: string | null, additive?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number, dx: number, dy: number) => void;
}
interface UseItemDragResult {
  dragging: boolean;
  handlers: Pick<React.DOMAttributes<HTMLElement>,
    "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel">;
  settle: () => void;          // useLayoutEffect([x,y])에서 호출
}
```

- **TextItem**은 이 훅을 쓰도록 리팩터한다(드래그 관련 로컬 코드 제거).
  `editing`일 때 `enabled=false`. 나머지 렌더(hover 박스·괘선·본문·메뉴·
  인출·리사이즈)는 그대로 둔다.
- **FigureItem**도 같은 훅을 쓴다. `enabled`는 항상 true(도판엔 편집 모드가 없다).

**회귀 방어**: 리팩터 전 `useItemDrag`에 단위 테스트를 쓴다(임계 이동 판정,
그룹 peer 수집, settle의 transform 제거). TextItem 리팩터는 동작 보존이 목표이며,
`npm test`의 배치 무겹침 테스트 + 수동 검증(글 상자 드래그·그룹 드래그·클릭
선택이 리팩터 전과 같은지)으로 확인한다.

### 판단 2 — 비율 고정 리사이즈 (`ResizeHandles`에 `aspect` 추가)

`ResizeHandles`에 선택적 `aspect?: number`(= w/h)를 더한다.

- `aspect`가 있으면 `onMove`에서 지배 축의 이동량으로 한 변을 정하고 나머지
  변은 `aspect`로 계산한다(대각선 손잡이: 대각 이동 투영. 변 손잡이: 그 변만
  움직여도 비율 유지). `MIN_H` 하한은 유지하되 비율에 맞춰 폭도 함께 하한 처리.
- `aspect`가 없으면 현행 자유 w/h 로직 그대로(**TextItem 무변경**).
- FigureItem은 이미지의 **자연 비율**(`img.naturalWidth/naturalHeight`, 로드 후
  확보. 아직이면 현재 렌더 상자 비율)을 넘긴다.

도판 상자는 `data.size`(D142와 동일 필드)를 쓰고, 이미지는 상자를 채운다:

- `width = size?.w ?? ITEM_W`
- `height`: `size`가 있으면 `size.h`(비율 고정이라 `w/aspect`와 일치), 없으면
  기존 자연 높이(`max-h-64` object-contain).
- 리사이즈 커밋 → `onResize(id, {w,h,dx,dy})` → `CanvasWorkspace.onResize`가
  `data.size` 저장. 왼/위 손잡이로 원점이 움직이면 `pinned=true` + x/y 갱신
  (TextItem과 동일 경로).

### FigureItem 렌더 변경

현재 FigureItem에 추가할 것:

1. **루트에 드래그 배선** — `useItemDrag` 핸들러를 루트 div에 붙인다.
   `data-selected` 속성을 selected일 때 `"1"`로 준다(그룹 드래그·올가미 하이라이트
   전제). `data-canvas-item`은 이미 있다.
2. **선택 시각 표시** — selected일 때 강조 테두리(TextItem의 hover/선택 박스와
   같은 방식, 흐름 밖 absolute) + `ResizeHandles`.
3. **삭제 UI** — hover/선택 시 우상단 × 버튼(`data-no-pan`, `onDelete(id)`),
   그리고 루트 `onKeyDown`에서 Delete/Backspace → `onDelete`, Escape → 선택 해제.
   `tabIndex`로 키보드 도달 가능하게.
4. **좌표 전이** — 드래그·배치 이동 시 부드럽게(이미 있는 transition 유지),
   드래그 중엔 즉시(훅의 `dragging` 참조).
5. 라이트박스는 그대로. 단 **드래그 후 클릭이 라이트박스를 열지 않게** —
   `dragging` 또는 이동 임계 초과였으면 클릭을 무시(TextItem이 클릭/드래그를
   가르는 것과 동형).

### D87 위반 방지 — 저장 시 url 비우기

리사이즈는 `data`를 통째로 PATCH한다. 스트림 세션 중엔 `data.figure.url`에
살아있는 signed URL이 있으므로 그대로 저장하면 D87을 위반한다(만료 URL 화석화).
`CanvasWorkspace.onResize`(및 도판 `data`를 PATCH하는 모든 경로)에서 도판이면
`data.figure.url = ""`로 비운 사본을 저장한다. 화면 표시는 메모리의 값/`refreshed`
상태가 계속 쓰므로 영향 없다. (이동은 `{x,y,pinned}`만 보내 무관.)

`useCanvasStream.toPayload`는 이미 생성 시 url을 비운다 — 그 정신을 patch 경로로
확장하는 것이다. 헬퍼로 뽑아 한 곳에서 관리한다(예: `figureDataForSave(data)`).

### ItemLayer 배선

`FigureItem`에 `handlers` 중 도판에 필요한 것(`onSelect`·`onDragEnd`·`onResize`·
`onResetSize`·`onDelete`)과 `selected`·`zoom`을 넘긴다. TextItem과 같은 `handlers`
객체에서 골라 준다.

## 데이터 흐름

```
ReAct done → useCanvasStream이 figure 아이템 생성(pinned=false) → createItems 저장
학생 드래그  → useItemDrag → onDragEnd → patch({x,y,pinned:true}) → PATCH
학생 리사이즈 → ResizeHandles(aspect) → onResize → patch({data:{...,size}, [x,y,pinned]})
              (도판 data는 figure.url 비워서 저장)
학생 삭제   → onDelete → remove → DELETE (+ 6초 되돌리기)
새로고침    → getCanvas → pinned=true면 저장 좌표/크기 복원
```

## 오류 처리

- 저장 실패 시 낙관적 갱신 롤백 + 배너(`useCanvasItems` 기존 동작 그대로).
  "RAG는 채팅을 막지 않는다"와 같은 정신 — 조작 실패해도 화면은 계속 쓸 수 있다.
- signed URL 만료 재발급은 기존 FigureItem 로직 유지(1회 재시도).

## 테스트

- **`useItemDrag` 단위 테스트**(신규, vitest): 임계 이동 판정, peer 수집,
  settle의 transform 제거, 그룹/단일 선택 확정.
- **`ResizeHandles` 비율 계산**: `aspect` 주면 w/h가 비율을 유지하는지(순수 계산
  부분을 함수로 뽑아 테스트).
- **배치 무겹침 불변식**(기존 `layout.test.ts`) 회귀 없음.
- **수동 검증**: 도판 드래그→새로고침 위치 유지 / 리사이즈→비율 유지·새로고침 유지
  / 삭제·되돌리기 / 글+도판 그룹 드래그 / 라이트박스가 드래그로 안 열림 /
  저장된 도판 data에 url이 비어 있음.

## 리스크

- **TextItem 리팩터 회귀** — 가장 큰 리스크. 훅 단위 테스트 + 동작 보존 수동
  검증으로 방어. 훅은 순수하게 "드래그+선택"만 담당하고 TextItem의 편집·인출·
  hover 렌더는 건드리지 않아 표면을 좁힌다.
- **비율 고정 손잡이 UX** — 변 손잡이(예: 동쪽만)로 끌 때도 비율이 유지되며
  다른 변이 함께 움직인다. 도판에선 자연스럽지만 구현 시 원점 계산 주의.
```
