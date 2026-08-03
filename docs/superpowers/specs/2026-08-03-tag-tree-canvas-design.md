# 태그 트리 캔버스 + 분기 대화 (D148) — 설계

작성일 2026-08-03. 사용자 결정에 따른 캔버스 v2 개편.

## 목표

1. **태그 열(column)을 태그 트리(tree)로 바꾼다** — "열이 너무 딱딱하다"는 지적.
   같은 태그의 카드들이 태그 뿌리 아래로 **세로 tidy tree**로 묶인다.
2. **미니맵을 2단계 드릴다운으로** — 멀리서는 태그 원(개수), 가까이/클릭 시 그
   태그의 카드 트리.
3. **분기 대화** — 미니맵에서 카드를 클릭하면 카메라가 그리로 이동하고 그 카드가
   **대화 컨텍스트(head)가 된다.** 다음 질문은 그 가지를 이어 간다.

## 불변식 (반드시 유지 — D123/D122 계승)

- **무겹침은 알고리즘의 성질이지 수렴의 결과가 아니다.** 트리 배치도 결정론적·
  무겹침이어야 하며 `layout.test.ts`의 무작위 200케이스를 통과한다. d3-force로
  돌아가지 않는다.
- **좌표는 저장한다(D122).** `pinned=false`는 엔진이 배치, `pinned=true`(학생이
  드래그)는 장애물로만 읽고 제자리 유지.
- **파싱은 프론트가 소유(canvas_items.body).** 태그 출처는 canvas_items.tag(D135).
- **RAG/컨텍스트는 채팅을 막지 않는다** — best-effort.

---

## ① 태그 트리 배치 (메인 캔버스)

### 구조

- 태그는 **좌→우로 나열**(첫 등장 순서, 열 순서 계승 — `columnXFor` 정신).
- 각 태그는 **아래로 뻗는 세로 tidy tree**:
  - **뿌리** = 합성 "태그 칩" 노드(`●[역사]`). canvas_item이 아니라 파생 렌더
    (지금 `ColumnLabels`가 하던 자리 — 그걸 대체·확장).
  - **자식** = 그 태그의 카드. 트리-부모 = `parentItemId`가 **같은 태그일 때만**;
    다른 태그거나 없으면 태그 뿌리에 직접 매단다(cross-tag 규칙 → 각 태그 트리가
    자기완결적).
  - 형제 순서 = seq 오름차순.

### 레이아웃 규칙 (결정론·무겹침)

- **세대(depth) → y**: 레벨 y = 위 레벨의 최대 아래끝 + `LEVEL_GAP`. 노드 높이
  편차는 레벨 y가 흡수(레이어드 트리).
- **형제 → x**: 각 노드가 **자기 서브트리 폭만큼의 가로 띠**를 예약, 부모는
  자식들 폭의 중앙. 서브트리 띠가 서로 안 겹침(Reingold–Tilford 윤곽; 단순
  예약폭 합산으로도 무겹침 보장 — 최적 밀도보다 **정확성 우선**).
- **태그 트리끼리**: 각 트리의 바운딩 폭을 예약해 좌→우로 나란히 → 트리끼리도
  무겹침.
- **폭·높이는 실측 입력**(ResizeObserver) — 지금과 동일(폭→배치 단방향, 순환
  없음).

### pinned / 장애물

- pinned 카드와 그림 요소는 트리 흐름에서 **빼고 장애물로만** 읽는다.
- 계산된 태그 트리가 장애물과 겹치면 **그 태그 트리 원점 y를 블록 단위로 아래로
  민다**(트리 내부 무겹침은 그대로, 트리 전체가 통째로 내려감). y 단조 증가라
  종료 보장.

### 연결선

- `ConnectorLayer`가 **태그뿌리→최상위 카드** 가지 선을 추가로 그린다(기존
  부모→자식 선 유지). 이로써 "열"이 아니라 "가지친 무리"로 읽힌다.

### 분기 로직 (③과 맞물림)

미니맵에서 카드 X를 head로 지정하고 질문하면:
1. 답 노드가 `parentItemId = X`로 생성 → X의 **새 자식**(기존 자식이 있으면 새
   형제 가지, seq 막내).
2. X의 서브트리 폭 증가 → tidy tree가 형제·사촌을 결정론적으로 다시 벌림
   (무겹침 유지). **다른 태그 트리는 안 움직임.**
3. 새 노드는 카메라 스프링으로 안착(D124).

### 영향 파일

- `lib/canvas2/layout.ts` — `layoutItems` 재작성(트리). `reflowOne`·`rectOf`
  유지. 트리 packing 순수 헬퍼 추가. `columnX` → 태그뿌리 x 맵으로 의미 확장.
- `lib/canvas2/layout.test.ts` — 무겹침 200케이스 유지 + 트리 구조·cross-tag
  규칙 단위테스트.
- `lib/canvas2/useItemLayout.ts` — 태그뿌리 노드 좌표를 결과로 노출.
- `components/canvas2/ItemLayer.tsx` — `ColumnLabels` → 태그 칩 렌더로 교체.
- `components/canvas2/ConnectorLayer.tsx` — 태그뿌리→최상위 카드 가지 선 추가.

---

## ② 미니맵 — 2단계 드릴다운

### 레벨 1 — 태그 개요 (멀리)

- 현행 유지: 태그마다 **원 하나 + 안에 카드 수**. 오커=AI·틸=학생. de-overlap
  넛지 유지(`Minimap.tsx` 기존 로직 재사용).
- **태그 원 클릭** → `onJump(태그 중심 world)` + 미니맵을 **레벨 2로 드릴다운**
  (그 태그 포커스).

### 레벨 2 — 태그 트리 (가까이 / 태그 클릭 시)

- 포커스된 **한 태그의 카드 트리**만 **도식 tidy tree**로 그린다(실제 좌표 투영이
  아니라 미니맵 안에서 고르게 재배치 — 클릭 정확도 우선, D139의 겹침 문제 회피).
- 카드 = 작은 점(오커/틸), 태그 뿌리 = 큰 칩, 가지 = 얇은 선.
- **활성 head 노드는 굵은 링**으로 강조.
- **카드 점 클릭** → `onJump(그 카드 world)` + `onSetHead(nodeId)`(컨텍스트 되감기).
- **복귀**: `‹ 전체` 버튼 또는 실제 맵 줌아웃.

### 레벨 전환 규칙

- **줌 연동**: 캔버스 줌 ≤ 임계 → 레벨 1, 줌 > 임계 → 레벨 2(포커스 태그).
- **포커스 태그** = 레벨 1에서 클릭한 태그, 없으면 자동 = **현재 head가 속한 태그**.
- **명시적 클릭이 항상 우선.**

### 영향 파일

- `lib/canvas2/minimapTree.ts` (신규) — 한 태그 카드들의 도식 tidy tree 순수
  레이아웃. 무겹침·결정론 단위테스트.
- `components/canvas2/Minimap.tsx` — 2단계 상태(level·focusTag), 줌 연동, L2
  렌더, `onSetHead`·`onFocusTag` 콜백.

---

## ③ 분기 대화 배선 (프론트 위주)

### 현 상태

- 백엔드는 이미 분기 지원: `chat.py:149` `parent_id = body.parent_node_id or
  session.current_head_id`; `ancestor_chain_nodes`가 뿌리→parent 경로만(형제
  제외) 이력으로 넘김; `chat.py:404` 스트림 후 `current_head_id`를 새 노드로 전진.
- **그러나 프론트 `send()`가 `parent_node_id`를 안 보낸다**(`useCanvasStream.ts:226`
  는 `{session_id, question}`만). 즉 지금은 항상 선형(head 따라감).
- 매핑: `canvas_item.nodeId` = 백엔드 노드 id.

### 설계

- **단일 "활성 head" 개념**: 프론트 상태 `headItemId`(canvas_item id). 설정 출처는
  (a) 미니맵 카드 클릭, (b) 기존 "AI에게 묻기" 버튼 — 둘 다 같은 상태를 채운다.
- `send()`가 head를 `parent_node_id = headItem.nodeId ?? null`로 보내고, 새
  아이템의 `parentItemId = headItemId`로 놓는다(연결선·트리 중첩 일관).
  - nodeId가 없는 부모(학생 note)면 `parent_node_id=null`(선형 폴백) + 연결선만
    — 현행 "AI에게 묻기" 동작 보존.
- **head 지속성**: 프론트 상태로만 유지(전송 시 소비). 백엔드가 턴 후
  `current_head_id`를 전진시키므로 새로고침 시 마지막 답 노드로 복귀 — 명시적
  head 지정은 "다음 질문을 여기서"까지의 임시 상태(YAGNI: 별도 영속 엔드포인트
  안 만듦).
- **AskBar 표시**: head가 잡히면 "○○에 이어서" 칩(기존 quote UI 재사용/확장).
  head 해제 버튼 제공.

### 동작 변화(명시)

- 이제 "AI에게 묻기"/미니맵 head 지정이 **실제로 모델 컨텍스트를 그 가지로
  되감는다**(전엔 연결선만). 이는 의도된 변화(분기 대화가 목표).

### 영향 파일

- `lib/canvas2/useCanvasStream.ts` — `send(question, {parentItemId})`가
  `parent_node_id`를 실제 전송. head 아이템→nodeId 해석.
- `components/canvas2/CanvasWorkspace.tsx` — `headItemId` 상태, `onSetHead`
  (`useEventCallback`로 신원 고정 — D145 memo 보호), 미니맵·AskBar 배선.
- `components/canvas2/AskBar.tsx` — 활성 head 칩 + 해제.

---

## 테스트

- **단위(vitest)**: `layout.test.ts`(무겹침 200케이스 + 트리 구조·cross-tag),
  `minimapTree.test.ts`(무겹침·결정론). 순수 함수 대상.
- **E2E(Playwright)**: 태그 다른 두 카드가 각자 트리로 묶임 · 미니맵 드릴다운
  (태그 원 클릭 → 트리) · 미니맵 카드 클릭 시 head 지정되고 다음 답이 그 자식으로
  붙음 · 새로고침 후 트리·좌표 유지.

## 순서

① 배치 엔진 → ② 미니맵(트리 구조 의존) → ③ 분기 배선(독립적, 작음).
