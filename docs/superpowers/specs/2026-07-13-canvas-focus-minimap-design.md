# 캔버스 생성-포커싱 · 맵 앵커 로딩 · D3 위치 미니맵 개념트리 설계

날짜: 2026-07-13
상태: 사용자 승인 완료 (스펙 작성 → 구현 계획 전)
선행:
- 2026-07-12-force-cluster-placement-design.md (서버 권위 좌표·힘 클러스터 배치)
- 2026-07-13 리비전 (리프 무겹침·주제 분리 간격)

## 1. 배경과 목표

힘-기반 클러스터 배치로 카드가 유사도에 따라 넓게 흩어진다(주제별로 멀리 분리). 그 결과:
- 새 개념이 **화면 밖**에 생성되면 사용자가 어디 생겼는지 못 본다.
- 로딩 표시가 **화면 중앙 고정 칩**이라 실제 생성 위치와 무관하다.
- 개념트리가 **텍스트 아웃라인**이라 공간적 맵과 동떨어져 클러스터 위치 감각이 없다.

**목표(3+1 기능):**
1. **생성 지점 자동 포커싱** — 새 답변의 첫 개념이 생성되는 지점으로 카메라가 부드럽게 1회 팬.
2. **맵 앵커 로딩** — 로딩 애니메이션이 화면 중앙이 아니라 그 생성 지점 위(맵 내부)에서 발생, 맵과 함께 팬/줌.
3. **D3 위치 미니맵 개념트리** — 개념트리를 맵의 축소 미니맵으로 렌더. 클러스터를 점 하나로 표시.
4. (3의 일부) **클러스터 클릭 내비** — 미니맵 점 클릭 → 본 캔버스가 그 클러스터 위치로 팬.

**설계 원칙:**
- **단일 신호원**: `focusSignal{x,y,key}` 하나가 카메라 포커스와 로딩 버블 위치를 동시에 구동(중복 상태 제거).
- **파생 렌더**: 미니맵·로딩은 상태를 소유하지 않고 `concepts/groups/camera`에서 파생.
- **D3는 계산, React는 DOM**: `d3.scaleLinear`로 좌표만 매핑하고 SVG는 React가 렌더(React 19 안전 패턴 — d3.select로 DOM 직접 변형 금지).
- **YAGNI**: 클러스터 단위 클릭만(멤버별 드릴다운 제거). 미니맵 자체 줌/드래그 없음(정적).

## 2. 아키텍처 개요

```
useConceptStream ──► { concepts, groups, leafNodes, reply, busy, loading, focusSignal, send }
       │
       ▼
ConceptCanvasWorkspace
   ├─ useEffect([focusSignal]) → setCamera(focusCamera(vp, gen점, 1))   // Feature 1
   ├─ <NoteCanvas camera>                                              // 맵 평면(팬/줌)
   │     ├─ <ConceptCard …>            (기존)
   │     ├─ <VideoNode/ArtNode …>      (기존)
   │     └─ <MapLoadingIndicator x,y visible={loading}/>   // Feature 2 (신규, 맵 내부)
   ├─ <ConceptTreePanel> → <ConceptMinimap groups concepts camera vp onFocus/>  // Feature 3
   └─ (LoadingChip 중앙 칩 제거)
```

## 3. Feature 1 — 생성 지점 자동 포커싱

### 3-1. 신호: `focusSignal`
`useConceptStream`이 `focusSignal: { x: number; y: number; key: number } | null`을 노출한다.
- `send()` 플로우에서 retrieve 후 **플레이스홀더(첫 개념)를 `nearXY`에 커밋하는 시점**에 `setFocusSignal({ x: nearXY.x, y: nearXY.y, key: <단조 증가 카운터> })`.
- `key`는 답변마다 증가하는 정수(같은 좌표라도 effect가 다시 fire되게 하는 트리거). `Date.now()` 금지(결정론·테스트) — 내부 `useRef` 카운터 `++`.
- 재수화(세션 로드)에서는 `focusSignal`을 설정하지 않는다(라이브 send에서만). 재수화 초기 포커스는 기존 `concepts[0]` 1회 로직 유지.

### 3-2. 카메라 팬
`ConceptCanvasWorkspace`:
```
useEffect(() => {
  if (!focusSignal) return;
  setCamera(focusCamera(vp(), { x: focusSignal.x + CARD_CX, y: focusSignal.y + CARD_CY }, 1));
}, [focusSignal]);   // key가 바뀔 때마다 재실행
```
- `CARD_CX=210, CARD_CY=200`(기존 상수) — 카드 중심 보정.
- NoteCanvas의 `transform 0.7s cubic-bezier` 트랜지션이 "부드럽게 1회 팬"을 담당(추가 애니메이션 코드 불필요).
- 기존 `didInitFocus`(concepts[0]) 초기 포커스는 **재수화 전용**으로 축소: 라이브 send는 `focusSignal`이 담당하므로 중복 팬이 없도록 `didInitFocus`는 그대로 두되(첫 마운트 시 1회), 라이브 첫 답변도 `focusSignal`로 팬 → 동일 지점이라 충돌 없음.

## 4. Feature 2 — 맵 앵커 로딩

### 4-1. 중앙 칩 제거
`ConceptCanvasWorkspace`의 `LoadingChip`(position:fixed/absolute 중앙, `{loading && <LoadingChip/>}`)을 **삭제**한다.

### 4-2. `MapLoadingIndicator` (신규, 맵 내부 렌더)
- 위치: NoteCanvas **children**로 렌더 → 맵 transform(scale/translate) 평면 안에 있어 팬/줌을 따라간다.
- Props: `{ x: number; y: number; visible: boolean }`. `x,y` = `focusSignal.{x,y}`(생성 지점). `visible = loading`.
- 렌더: 절대배치 `left:x+CARD_CX-버블폭/2, top:y-56`(pending 카드 위에 버블). 마스코트(`/nodi-mascot.png`) + 점 3개 바운스(`.nodi-ldot`) + "노트를 쓰는 중…" 라벨. `pointerEvents:none`.
- 스폰 등장은 기존 `.nodi-spawn` 또는 단순 fade-in. `visible=false`면 `null` 반환.
- `focusSignal`이 null이면(첫 마운트 전) 렌더 안 함.

### 4-3. pending 스켈레톤 카드
기존 pending `ConceptCard`(shimmer 제목 + 점 3개 + 펄스 테두리)는 **그대로 유지**. 로딩 버블은 그 위에 겹쳐 뜬다. 로딩 종료(done→`loading=false`) 또는 첫 개념 승격 시 자연 소거.

## 5. Feature 3 — D3 위치 미니맵 개념트리

### 5-1. 클러스터 = 기존 시맨틱 그룹
`grouping.ts`의 `ConceptGroup`(임베딩/제목 유사도 온라인 클러스터)을 **그대로 재사용**한다. 그룹 1개 = 미니맵 점 1개. (맵 좌표도 유사도 기반이라 그룹 멤버는 공간적으로도 뭉쳐 있음 — spatial centroid가 유의미.)

### 5-2. 순수 레이아웃 헬퍼 `minimapLayout.ts`
DOM/React 독립 순수 함수(테스트·재사용):
```
interface MiniNode { id: string; label: string; count: number; cx: number; cy: number; repConceptId: string; wx: number; wy: number }
//   cx,cy = 미니맵 SVG 픽셀 좌표, wx,wy = 월드(맵) 좌표(클릭 팬 대상)
interface MiniViewport { x: number; y: number; w: number; h: number }  // 미니맵 SVG 픽셀 사각형

// 그룹별 멤버 카드 중심의 월드 평균(spatial centroid). 좌표 없는 멤버는 제외.
function groupCentroids(groups: ConceptGroup[], concepts: Concept[]): Array<{id,label,count,repConceptId,wx,wy}>

// 모든 centroid의 bbox(+패딩)를 미니맵(width×height)에 종횡비 보존 매핑하는 스케일 계산.
//   d3.scaleLinear 사용. 단일 배율 s=min(sx,sy)로 왜곡 방지, 중앙 정렬 오프셋 포함.
function fitScale(pts: {wx,wy}[], width, height, pad): { scale:number; ox:number; oy:number }  // world→mini: cx = ox + wx*scale

// 현재 카메라 가시 월드 사각형을 미니맵 픽셀 사각형으로 변환(뷰포트 표시).
//   가시 월드 top-left = (-cam.x/cam.scale, -cam.y/cam.scale), size = (vp.w/cam.scale, vp.h/cam.scale)
function viewportRect(camera, vp, fit): MiniViewport
```
- 결정론(난수 없음). 빈 입력이면 빈 배열/기본 스케일 반환.

### 5-3. 렌더 컴포넌트 `ConceptMinimap.tsx`
- Props: `{ groups, concepts, camera, viewport:{w,h}, activeId, onFocus:(target:{x,y})=>void }`.
- 내부: `groupCentroids` → `fitScale`(SVG 260×180 가정) → `MiniNode[]` 계산 → SVG 렌더.
  - `<rect>` 뷰포트 사각형(`viewportRect`) — 얇은 테두리, 반투명. 팬/줌 시 갱신.
  - 그룹마다 `<circle r=clamp(6+√count*3, 6, 22)>` at (cx,cy) + `<text>` 라벨(길면 말줄임) + count 배지.
  - hover/active(활성 그룹) 강조. `data-no-pan`로 미니맵 위 포인터가 캔버스 팬을 트리거하지 않게.
- 클릭: `onFocus({ x: node.wx, y: node.wy })` — `wx,wy`는 이미 클러스터 멤버 카드 **중심**의 월드 평균이다. 워크스페이스는 `setCamera(focusCamera(vp, { x: wx, y: wy }, 1))`로 그 중심을 화면 중앙에 놓는다(CARD_CX/CY 보정 불필요 — centroid가 이미 중심 좌표).
- D3: `d3-scale`만 사용(선택). SVG DOM은 React가 관리.

### 5-4. 패널 통합 `ConceptTreePanel.tsx`
- 기존 토글(edge 버튼 → slide-in aside)·헤더("개념 트리", 개념 수) **유지**.
- 본문(그룹/멤버 텍스트 아웃라인)을 `<ConceptMinimap …>`로 **교체**. 멤버별 텍스트 버튼·collapse 로직 제거.
- 빈 상태(그룹 0): "질문하면 개념이 여기 모여요." 유지.
- Props 확장: `camera`, `viewport`를 워크스페이스에서 주입(뷰포트 사각형·onFocus 팬 계산용). `onFocus` 시그니처를 `(target:{x,y})=>void`로 변경(기존 `(conceptId)=>`에서). 워크스페이스 `handleFocus`가 좌표 기반으로 조정.

## 6. 무엇이 바뀌나 (파일)

- **신규** `frontend/src/lib/concept/minimapLayout.ts` — 순수 레이아웃(centroid·fitScale·viewportRect).
- **신규** `frontend/src/components/canvas/ConceptMinimap.tsx` — D3 스케일 + React SVG 미니맵.
- **신규** `frontend/src/components/canvas/MapLoadingIndicator.tsx` — 맵 내부 앵커 로딩 버블.
- **수정** `frontend/src/lib/concept/useConceptStream.ts` — `focusSignal` state 추가·노출, `send`에서 set.
- **수정** `frontend/src/components/canvas/ConceptCanvasWorkspace.tsx` — focus effect, MapLoadingIndicator 렌더, LoadingChip 제거, 미니맵에 camera/vp/onFocus 전달, handleFocus 좌표화.
- **수정** `frontend/src/components/canvas/ConceptTreePanel.tsx`(+`.module.css`) — 본문을 미니맵으로 교체, props 확장.

## 7. 데이터 흐름

1. 사용자 질문 → `send` → retrieve → 플레이스홀더 커밋 + `setFocusSignal({x,y,key++})`.
2. 워크스페이스 effect: 카메라가 (x,y)로 팬. `MapLoadingIndicator`가 (x,y)에 표시(`loading=true`).
3. SSE 스트리밍 → 카드/리프 생성(기존). done → `loading=false` → 로딩 버블 숨김.
4. `groups`(useConceptStream) 갱신 → 미니맵이 클러스터 점 재계산·재렌더.
5. 미니맵 점 클릭 → `onFocus({x:wx,y:wy})` → 카메라가 그 클러스터로 팬.
6. 카메라 변화 → 미니맵 뷰포트 사각형 갱신.

## 8. 에러 처리

| 상황 | 동작 |
|---|---|
| 개념 0 | 미니맵 빈 상태 문구, 로딩 버블은 `loading` 시에만 |
| 좌표 없는 구 노드(멤버) | `groupCentroids`에서 해당 멤버 제외(그룹에 유효 멤버 0이면 그룹 스킵) |
| 재수화(세션 로드) | `focusSignal` 미설정 → 답변별 팬 없음, `concepts[0]` 초기 포커스만 |
| `focusSignal` null(첫 마운트) | 로딩 버블·포커스 effect 무동작 |
| 미니맵 위 포인터 | `data-no-pan` → 캔버스 팬 미발생 |

## 9. 테스트

### 9-1. 순수 유닛(node 새너티 — 프론트 유닛 러너 없음)
- `groupCentroids`: 멤버 좌표 평균이 맞는지, 좌표 없는 멤버 제외.
- `fitScale`: bbox가 미니맵 안에 종횡비 보존 매핑(모든 점이 [pad, size-pad] 내), 단일 배율.
- `viewportRect`: 카메라/뷰포트 → 미니맵 사각형이 예상 픽셀 범위.

### 9-2. E2E(Playwright, 기존 하네스)
1. **자동 포커싱**: 먼 위치에 카드가 생기는 질문 → 새 첫 개념이 화면 중앙 근처(뷰포트 중심 ±허용치)로 이동.
2. **맵 앵커 로딩**: 질문 직후 로딩 버블(`data-testid="map-loading"`)이 생성 지점 월드좌표 근처에 표시되고, 화면 중앙 고정 칩은 **없음**(제거 확인). done 후 버블 사라짐.
3. **미니맵 렌더**: 다주제 질문 N개 → 미니맵 점 수 = 그룹 수, 배지 합 = 카드 수, 점 위치가 실제 카드 배치와 상대적으로 일치(왼쪽 카드 → 왼쪽 점).
4. **클릭 내비**: 미니맵 점 클릭 → 본 카메라가 그 클러스터로 팬(클릭 후 해당 클러스터 카드가 뷰포트 안).
5. **뷰포트 사각형**: 캔버스 팬 → 미니맵 사각형 위치가 그에 맞게 이동.

## 10. 비범위

- 미니맵 자체 줌/드래그·리사이즈(정적 축소 뷰만).
- 멤버별(카드 단위) 드릴다운 내비(클러스터 단위만).
- 미니맵 점 간 엣지/링크(관계선) 표시(점만).
- 로딩 버블의 진행률·단계 표시(단순 애니메이션만).
- 서버/DB 변경 없음(전부 프론트 렌더 계층).
