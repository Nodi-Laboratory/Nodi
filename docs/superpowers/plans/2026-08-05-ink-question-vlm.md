# 펜으로 그려서 묻기 (D178) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 학생이 캔버스에 그린 표시(동그라미·화살표·손글씨)와 그 주변 카드를 함께 읽어 SOLAR에 넘긴다.

**Architecture:** 질문 획의 bbox에서 주변 카드를 한 번만 골라 상자를 넓히고, 그림 둘을 만든다 — OCR용(획만, 기존 `renderInkPng` 그대로)과 VLM용(월드 좌표로 다시 그린 도식). 두 모델을 `asyncio.gather`로 동시에 돌려(GPU가 갈라져 있어 실제 병렬) 결과를 병합한다. 기하는 전부 순수 함수로 빼서 테스트로 못 박는다 — 틀려도 그럴싸한 그림이 나오므로 눈으로는 못 잡는다.

**Tech Stack:** TypeScript(Next 16 / vitest) · Python(FastAPI / pytest) · Canvas 2D · llama.cpp EXAONE-4.5-33B(OpenAI 호환 비전) · VARCO-VISION-2.0-1.7B-OCR

**스펙:** `docs/superpowers/specs/2026-08-05-ink-question-vlm-design.md`

## Global Constraints

- 주석·docstring·커밋 메시지는 **한국어**. 커밋 프리픽스 `[feat]:`/`[fix]:`/`[docs]:`/`[tune]:`/`[chore]:`/`[perf]:`
- 설계 결정은 **D178**로 코드 주석에 남긴다
- **`git add -A` / `git add .` 금지** — 자기가 만진 파일만 add(병렬 세션이 같은 브랜치를 공유한다)
- 브랜치는 `feat/ink-question-vlm`. **main·dev에 push하지 않는다**
- 새 노브는 `config.py` 기본값 + `admin_console._SPECS` + `db/03_app_settings.sql` **셋 다** 넣어야 콘솔에 뜬다(D62·D113)
- **직접 DB 커넥션을 얻지 않는다** — `db/pool.py`의 `user_conn()` 경로만(D104)
- eslint에 **React Compiler 규칙**이 켜져 있다. 이펙트 내 동기 setState는 에러 — 억제하지 말고 구조로 푼다
- **dev 서버를 띄운 채 `npm run build`를 돌리지 않는다**
- 손대지 않는 파일: `frontend/src/lib/canvas2/penPad.ts`(OCR 그림) · `askInk.ts`(획 판정) · `backend/app/routers/ocr.py`(기존 창구)
- 백엔드 테스트: `cd backend && uv run pytest tests/ -v` (전부 mock — 키·네트워크 불필요)
- 프론트 테스트: `cd frontend && npm test`

---

## File Structure

**새로 만든다**

| 파일 | 책임 |
|---|---|
| `frontend/src/lib/canvas2/inkScene.ts` | 카드 선정·상자 계산. **순수** |
| `frontend/src/lib/canvas2/inkScene.test.ts` | 위의 테스트 |
| `frontend/src/lib/canvas2/figureCrop.ts` | `object-contain` 레터박스 좌표 변환. **순수** |
| `frontend/src/lib/canvas2/figureCrop.test.ts` | 위의 테스트 |
| `frontend/src/lib/canvas2/inkRender.ts` | 도식 PNG 렌더(브라우저 전용). 기하는 안 한다 |
| `frontend/src/lib/api/ink.ts` | `/ink/interpret` 클라이언트 |
| `backend/app/services/ink_marks.py` | VLM 프롬프트 조립·호출·파싱 |
| `backend/app/routers/ink.py` | `POST /api/ink/interpret` |
| `backend/tests/test_ink_marks.py` | 프롬프트·파싱 테스트 |

**고친다**

| 파일 | 무엇 |
|---|---|
| `backend/app/config.py` | 노브 8개 |
| `backend/app/services/admin_console.py` | `_SPECS`에 노브 8개 |
| `db/03_app_settings.sql` | 같은 노브 기본값 행 |
| `backend/app/routers/files.py` | `GET /files/figures/{id}/raw` |
| `backend/app/main.py` | ink 라우터 등록 |
| `backend/app/routers/chat.py` | `ChatStreamBody.ink` |
| `backend/app/services/gemini.py` | `ink_context` 블록 |
| `frontend/src/lib/api/index.ts` | ink 재수출 |
| `frontend/src/components/canvas2/CanvasWorkspace.tsx` | `recognizeInk` 확장 |

**경계**: 기하(`inkScene`·`figureCrop`)는 렌더(`inkRender`)를 모른다. 렌더는 네트워크를 모른다. `ink_marks`는 HTTP를 모른다(라우터가 안다). D126·penPad와 같은 분리다.

---

### Task 1: 노브 8개

**Files:**
- Modify: `backend/app/config.py` (손글씨 OCR 블록 뒤)
- Modify: `backend/app/services/admin_console.py` (`_SPECS`의 "손글씨 인식" 그룹 끝)
- Modify: `db/03_app_settings.sql`

**Interfaces:**
- Produces: `settings.ink_vlm_enabled` · `ink_card_max` · `ink_near_pad` · `ink_box_max_scale` · `ink_figure_zoom_enabled` · `ink_vlm_timeout_seconds` · `ink_card_body_max_chars` · `ink_scene_max_side`

- [ ] **Step 1: `config.py`에 노브를 더한다**

`ocr_queue_timeout_seconds` 바로 뒤에 넣는다:

```python
    # --- 펜 표시 해석 (D178) ---
    # 질문 획 주변의 카드를 함께 읽어 "이거"가 무엇인지 살린다. 비전 모델은
    # judge_* 계열을 그대로 재사용한다(같은 기계 GPU 0).
    ink_vlm_enabled: bool = True
    # 끌어올 카드 상한. 많아지면 SOLAR가 받는 본문이 부풀고 화살표의 의미가 묻힌다.
    ink_card_max: int = 5
    # 근접 판정 반경(월드 px). 화살표 없이 카드 옆에 질문만 쓰는 것이 가장
    # 흔한 사용법이라 이 단이 없으면 그 경우가 빈손이 된다.
    ink_near_pad: int = 120
    # 상자가 원본 획 bbox의 몇 배까지. **클램프가 없으면 배율이 줄어 정작
    # 화살표가 몇 픽셀로 뭉개진다** — 안 되는 게 아니라 그럴싸하게 틀린다.
    ink_box_max_scale: float = 2.5
    ink_figure_zoom_enabled: bool = True
    ink_vlm_timeout_seconds: int = 30
    ink_card_body_max_chars: int = 1200
    ink_scene_max_side: int = 1280
```

- [ ] **Step 2: `_SPECS`에 노브를 더한다**

`admin_console.py`의 `ocr_timeout_seconds` 항목 뒤, `]` 앞에 넣는다. `"group"`은 전부 `"손글씨 인식"`이라 새 그룹·`_GROUP_ORDER` 수정이 필요 없다.

```python
    # ── 펜 표시 해석 (D178) ──
    {
        "key": "ink_vlm_enabled",
        "label": "펜 표시 해석",
        "group": "손글씨 인식",
        "widget": "toggle",
        "scope": "live",
        "description": "동그라미·화살표가 어느 카드를 가리키는지 비전 모델로 읽는다.",
        "effect": "표시 해석 on/off",
    },
    {
        "key": "ink_card_max",
        "label": "함께 읽을 카드 수",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 1, "max": 8, "step": 1, "unit": "개",
        "scope": "live",
        "description": "표시 주변에서 끌어올 카드 상한. 많으면 화살표의 의미가 묻힌다.",
        "effect": "질문에 딸려 가는 카드 수",
    },
    {
        "key": "ink_near_pad",
        "label": "근접 판정 반경",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 0, "max": 600, "step": 20, "unit": "px",
        "scope": "live",
        "description": "획에 닿지 않아도 이 거리 안의 카드는 함께 읽는다.",
        "effect": "옆에 쓴 질문이 카드를 잡는 범위",
    },
    {
        "key": "ink_box_max_scale",
        "label": "상자 확대 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 1.0, "max": 6.0, "step": 0.5, "unit": "배",
        "scope": "live",
        "description": "카드를 끌어오며 상자가 커질 수 있는 한계(획 bbox 대비).",
        "effect": "도식에서 획이 뭉개지는 정도",
    },
    {
        "key": "ink_figure_zoom_enabled",
        "label": "도판 확대본 전송",
        "group": "손글씨 인식",
        "widget": "toggle",
        "scope": "live",
        "description": "표시가 교과서 도판에 닿으면 그 도판을 원본 해상도로 한 장 더 보낸다.",
        "effect": "도판 위 표시의 정확도 / 응답 시간",
    },
    {
        "key": "ink_vlm_timeout_seconds",
        "label": "표시 해석 상한",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 5, "max": 120, "step": 5, "unit": "초",
        "scope": "live",
        "description": "넘으면 표시 해석 없이 질문을 보낸다(질문은 막지 않는다).",
        "effect": "느릴 때 기다리는 시간",
    },
    {
        "key": "ink_card_body_max_chars",
        "label": "카드 본문 길이",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 200, "max": 4000, "step": 100, "unit": "자",
        "scope": "live",
        "description": "표시 주변 카드에서 프롬프트에 넣을 본문 길이(카드당).",
        "effect": "질문 프롬프트 크기",
    },
    {
        "key": "ink_scene_max_side",
        "label": "도식 그림 한 변",
        "group": "손글씨 인식",
        "widget": "number",
        "min": 512, "max": 2048, "step": 128, "unit": "px",
        "scope": "live",
        "description": "비전 모델에 보내는 도식 PNG의 긴 변 상한.",
        "effect": "업로드 크기 / 표시 식별력",
    },
```

- [ ] **Step 3: `db/03_app_settings.sql`에 행을 더한다**

파일 끝 `on conflict` 절 앞의 값 목록에 넣는다(주변 항목의 정렬 스타일을 따른다):

```sql
    -- 펜 표시 해석 (D178)
    ('ink_vlm_enabled',                 'true'),
    ('ink_card_max',                    '5'),
    ('ink_near_pad',                    '120'),
    ('ink_box_max_scale',               '2.5'),
    ('ink_figure_zoom_enabled',         'true'),
    ('ink_vlm_timeout_seconds',         '30'),
    ('ink_card_body_max_chars',         '1200'),
    ('ink_scene_max_side',              '1280'),
```

- [ ] **Step 4: 콘솔에 뜨는지 확인**

Run: `cd backend && uv run pytest tests/ -v -k admin`
Expected: PASS (기존 admin 테스트가 `_SPECS` 키와 config 속성의 대응을 본다 — 어긋나면 여기서 깨진다)

`config.py`에 없는 키를 `_SPECS`에 넣으면 실패한다. 실패하면 철자를 맞춘다.

- [ ] **Step 5: 커밋**

```bash
git add backend/app/config.py backend/app/services/admin_console.py db/03_app_settings.sql
git commit -m "[feat]: 펜 표시 해석 노브 8개 (D178)"
```

---

### Task 2: `inkScene.ts` — 카드 선정과 상자

**Files:**
- Create: `frontend/src/lib/canvas2/inkScene.ts`
- Test: `frontend/src/lib/canvas2/inkScene.test.ts`

**Interfaces:**
- Consumes: `PenStroke`(`./penPad`) · `Rect`·`intersects`·`inflate`·`union`(`./rect`) · `strokesBBox`(`./askInk`)
- Produces:
  - `interface SceneCard { id, kind, title, body, rect, figureId? }`
  - `interface PickedCard extends SceneCard { n: number; touched: boolean }`
  - `interface InkScene { inkBox: Rect; capture: Rect; cards: PickedCard[]; dropped: number }`
  - `function buildInkScene(strokes: readonly PenStroke[], cards: readonly SceneCard[], opts: InkSceneOpts): InkScene | null`
  - `function segmentHitsRect(ax, ay, bx, by, r: Rect): boolean`
  - `function rectGap(a: Rect, b: Rect): number`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`frontend/src/lib/canvas2/inkScene.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildInkScene, rectGap, segmentHitsRect, type SceneCard } from "./inkScene";
import type { PenStroke } from "./penPad";

const OPTS = { cardMax: 5, nearPad: 120, boxMaxScale: 2.5 };

/** 두 점을 잇는 직선 획. */
function line(ax: number, ay: number, bx: number, by: number): PenStroke {
  return [
    { x: ax, y: ay, p: 0.6 },
    { x: bx, y: by, p: 0.6 },
  ];
}

function card(id: string, x: number, y: number, w = 200, h = 100): SceneCard {
  return { id, kind: "concept", title: id, body: `${id} 본문`, rect: { x, y, w, h } };
}

describe("segmentHitsRect", () => {
  it("사각형을 관통하는 선분을 잡는다", () => {
    expect(segmentHitsRect(0, 50, 300, 50, { x: 100, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("사각형 안에서 끝나는 선분도 잡는다", () => {
    expect(segmentHitsRect(0, 50, 150, 50, { x: 100, y: 0, w: 100, h: 100 })).toBe(true);
  });

  it("비껴가는 선분은 안 잡는다", () => {
    expect(segmentHitsRect(0, 500, 300, 500, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
  });
});

describe("rectGap", () => {
  it("겹치면 0", () => {
    expect(rectGap({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(0);
  });

  it("가로로 떨어진 만큼", () => {
    expect(rectGap({ x: 0, y: 0, w: 100, h: 100 }, { x: 150, y: 0, w: 100, h: 100 })).toBe(50);
  });
});

describe("buildInkScene", () => {
  it("획이 없으면 null", () => {
    expect(buildInkScene([], [card("A", 0, 0)], OPTS)).toBeNull();
  });

  /**
   * **이 테스트가 알고리즘의 이유다.** 대각선 화살표의 bbox는 커다란
   * 직사각형이라, bbox로 판정하면 화살표가 지나가지도 않은 구석 카드가
   * 접촉으로 잡힌다.
   */
  it("대각선 획의 bbox 구석에 있는 카드를 접촉으로 잡지 않는다", () => {
    const arrow = line(0, 0, 2000, 2000);
    const corner = card("구석", 0, 1800, 200, 200); // bbox 안, 대각선에서 멀다
    const scene = buildInkScene([arrow], [corner], OPTS)!;
    const picked = scene.cards.find((c) => c.id === "구석");
    expect(picked?.touched ?? false).toBe(false);
  });

  it("관통당한 카드는 접촉이다", () => {
    const arrow = line(0, 50, 400, 50);
    const scene = buildInkScene([arrow], [card("맞음", 200, 0)], OPTS)!;
    expect(scene.cards[0].touched).toBe(true);
  });

  it("닿지 않았지만 가까운 카드는 근접으로 잡힌다", () => {
    const ink = line(0, 0, 50, 50);
    const near = card("옆", 100, 0);   // 획 bbox에서 50px
    const scene = buildInkScene([ink], [near], OPTS)!;
    expect(scene.cards).toHaveLength(1);
    expect(scene.cards[0].touched).toBe(false);
  });

  it("근접 반경 밖의 카드는 안 잡는다", () => {
    const ink = line(0, 0, 50, 50);
    const far = card("멀다", 5000, 5000);
    expect(buildInkScene([ink], [far], OPTS)!.cards).toHaveLength(0);
  });

  it("상한을 넘으면 접촉을 먼저 남기고 잘린 수를 알린다", () => {
    const ink = line(0, 50, 400, 50);
    const cards = [
      card("접촉", 200, 0),
      card("근접1", 0, 200),
      card("근접2", 0, 260),
      card("근접3", 0, 320),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, cardMax: 2 })!;
    expect(scene.cards).toHaveLength(2);
    expect(scene.cards.some((c) => c.id === "접촉")).toBe(true);
    expect(scene.dropped).toBe(2);
  });

  it("번호는 읽는 순서(위→아래, 같은 줄이면 왼→오른쪽)로 매긴다", () => {
    const ink = line(400, 400, 450, 450);
    const cards = [
      card("아래", 300, 600),
      card("위오른쪽", 500, 300),
      card("위왼쪽", 200, 300),
    ];
    const scene = buildInkScene([ink], cards, { ...OPTS, nearPad: 600 })!;
    expect(scene.cards.map((c) => c.id)).toEqual(["위왼쪽", "위오른쪽", "아래"]);
    expect(scene.cards.map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it("상자는 획 bbox의 boxMaxScale배를 넘지 않는다", () => {
    const ink = line(0, 0, 100, 100);
    const huge = card("큰카드", 150, 0, 4000, 4000);
    const scene = buildInkScene([ink], [huge], OPTS)!;
    expect(scene.capture.w).toBeLessThanOrEqual(scene.inkBox.w * OPTS.boxMaxScale + 0.01);
    expect(scene.capture.h).toBeLessThanOrEqual(scene.inkBox.h * OPTS.boxMaxScale + 0.01);
  });

  /**
   * **종료가 알고리즘의 성질이다.** 상자를 키운 결과로 카드를 다시 주우면
   * 조밀한 캔버스에서 전체를 삼킨다.
   */
  it("키운 상자 안에 들어온 카드를 다시 줍지 않는다", () => {
    const ink = line(0, 0, 100, 100);
    const anchor = card("근접", 150, 0);          // 근접으로 잡힌다 → 상자가 커진다
    const later = card("나중", 420, 0);           // 원래 bbox에서는 멀다
    const scene = buildInkScene([ink], [anchor, later], OPTS)!;
    expect(scene.cards.map((c) => c.id)).toEqual(["근접"]);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npm test -- inkScene`
Expected: FAIL — `Failed to resolve import "./inkScene"`

- [ ] **Step 3: `inkScene.ts`를 쓴다**

```ts
/**
 * 질문 획 주변의 카드를 고르고, 그릴 상자를 정한다 (D178).
 *
 * ## 왜 순수 함수인가
 *
 * 기하는 눈으로 검증할 수 없다 — 틀려도 그럴싸한 그림이 나온다. `penPad`·
 * `connector`가 같은 이유로 lib에 있다. 렌더는 이 파일을 모르고, 이 파일은
 * 캔버스를 모른다.
 *
 * ## 선정은 한 번뿐이다
 *
 * "주변에 카드가 있으면 포함되게 상자를 넓힌다"를 그대로 구현하면 **폭주한다**:
 * 상자를 키우면 새 카드가 들어오고, 그걸 포함하려 또 키우고, 조밀한 캔버스에서는
 * 결국 전체를 삼킨다. **선정은 원래 획 bbox 기준으로 딱 한 번 한다** — 그래서
 * 종료가 수렴의 결과가 아니라 알고리즘의 성질이다(D123과 같은 태도).
 */

import { strokesBBox } from "./askInk";
import { EXPORT_PAD, type PenStroke } from "./penPad";
import { inflate, union, type Rect } from "./rect";
import type { ItemKind } from "./types";

/** 도식에 그릴 후보 카드. rect는 hover 패딩 상자(연결선이 쓰는 그것, D126). */
export interface SceneCard {
  id: string;
  kind: ItemKind;
  title: string | null;
  body: string;
  rect: Rect;
  /** 도판일 때만. 확대본을 받아 올 열쇠다. */
  figureId?: string;
}

export interface PickedCard extends SceneCard {
  /** 1부터. 읽는 순서. VLM 출력의 [카드 N]이 이 번호다. */
  n: number;
  /** 획이 실제로 닿았나(1단). false면 근처에 있을 뿐(2단). */
  touched: boolean;
}

export interface InkSceneOpts {
  cardMax: number;
  nearPad: number;
  boxMaxScale: number;
}

export interface InkScene {
  /** 획 bbox + 여백. 클램프의 기준이다. */
  inkBox: Rect;
  /** 실제로 그릴 상자. */
  capture: Rect;
  cards: PickedCard[];
  /** 상한 때문에 버린 카드 수. **조용히 자르지 않는다.** */
  dropped: number;
}

/** 점이 사각형 안에 있나(변 포함). */
function inside(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 두 선분이 만나나. */
function segCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (d === 0) return false;  // 평행·공선은 잡지 않는다 — 변을 스치는 것은 접촉이 아니다
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * 선분이 사각형에 닿나 — 안에서 끝나는 경우와 관통하는 경우 둘 다.
 *
 * **bbox로 재면 안 된다.** 대각선 화살표의 bbox는 커다란 직사각형이라,
 * 화살표가 지나가지도 않은 구석 카드가 접촉으로 잡힌다.
 */
export function segmentHitsRect(
  ax: number, ay: number, bx: number, by: number, r: Rect,
): boolean {
  if (inside(ax, ay, r) || inside(bx, by, r)) return true;
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  return (
    segCross(ax, ay, bx, by, x1, y1, x2, y1) ||
    segCross(ax, ay, bx, by, x2, y1, x2, y2) ||
    segCross(ax, ay, bx, by, x2, y2, x1, y2) ||
    segCross(ax, ay, bx, by, x1, y2, x1, y1)
  );
}

function strokeHitsRect(stroke: PenStroke, r: Rect): boolean {
  if (stroke.length === 1) return inside(stroke[0].x, stroke[0].y, r);
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1];
    const b = stroke[i];
    if (segmentHitsRect(a.x, a.y, b.x, b.y, r)) return true;
  }
  return false;
}

/** 두 사각형 사이 최단 거리. 겹치면 0. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(dx, dy);
}

/** 한 상자를 기준 상자의 배율 안으로 자른다. 중심은 기준 상자의 중심에 맞춘다. */
function clampBox(box: Rect, base: Rect, scale: number): Rect {
  const maxW = base.w * scale;
  const maxH = base.h * scale;
  if (box.w <= maxW && box.h <= maxH) return box;
  const w = Math.min(box.w, maxW);
  const h = Math.min(box.h, maxH);
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  // 기준 상자(획)가 잘려 나가면 안 된다 — 획을 중심에 두고 자른다.
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function buildInkScene(
  strokes: readonly PenStroke[],
  cards: readonly SceneCard[],
  opts: InkSceneOpts,
): InkScene | null {
  const b = strokesBBox(strokes);
  if (!b) return null;
  const inkBox = inflate(
    { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
    EXPORT_PAD,
  );

  // 1단 접촉 · 2단 근접. **판정 기준은 언제나 inkBox다**(키운 상자가 아니라).
  const scored = cards.map((c) => {
    const touched = strokes.some((s) => strokeHitsRect(s, c.rect));
    return { card: c, touched, gap: rectGap(inkBox, c.rect) };
  });

  const eligible = scored.filter((s) => s.touched || s.gap <= opts.nearPad);
  // 접촉 먼저, 그다음 가까운 순. 상한을 넘으면 여기서 잘린다.
  eligible.sort((a, x) =>
    a.touched !== x.touched ? (a.touched ? -1 : 1) : a.gap - x.gap,
  );
  const kept = eligible.slice(0, Math.max(0, opts.cardMax));
  const dropped = eligible.length - kept.length;

  /**
   * 번호는 **읽는 순서**로 매긴다 — VLM의 공간 추론과 번호가 어긋나지 않게.
   * 같은 줄 판정은 세로 겹침으로 본다(y가 딱 같을 일은 없다).
   */
  kept.sort((a, x) => {
    const ay = a.card.rect.y;
    const xy = x.card.rect.y;
    const sameRow = Math.abs(ay - xy) < Math.min(a.card.rect.h, x.card.rect.h) / 2;
    return sameRow ? a.card.rect.x - x.card.rect.x : ay - xy;
  });

  const picked: PickedCard[] = kept.map((s, i) => ({
    ...s.card,
    n: i + 1,
    touched: s.touched,
  }));

  const merged = union([inkBox, ...picked.map((c) => c.rect)]) ?? inkBox;
  return {
    inkBox,
    capture: clampBox(merged, inkBox, opts.boxMaxScale),
    cards: picked,
    dropped,
  };
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `cd frontend && npm test -- inkScene`
Expected: PASS (12건)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/inkScene.ts frontend/src/lib/canvas2/inkScene.test.ts
git commit -m "[feat]: 질문 획 주변 카드 선정과 상자 계산 (D178)"
```

---

### Task 3: `figureCrop.ts` — 레터박스 좌표 변환

**Files:**
- Create: `frontend/src/lib/canvas2/figureCrop.ts`
- Test: `frontend/src/lib/canvas2/figureCrop.test.ts`

**Interfaces:**
- Consumes: `Rect`(`./rect`)
- Produces:
  - `function containRect(box: Rect, naturalW: number, naturalH: number): Rect`
  - `function worldToFigure(x: number, y: number, box: Rect, naturalW: number, naturalH: number): { x: number; y: number } | null`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`frontend/src/lib/canvas2/figureCrop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { containRect, worldToFigure } from "./figureCrop";

const BOX = { x: 100, y: 100, w: 200, h: 200 };

describe("containRect", () => {
  it("비율이 같으면 상자를 꽉 채운다", () => {
    expect(containRect(BOX, 400, 400)).toEqual(BOX);
  });

  it("세로로 긴 그림은 좌우에 띠가 생긴다", () => {
    // 200x400 그림 → 높이에 맞춰 100x200, 좌우 각 50
    expect(containRect(BOX, 200, 400)).toEqual({ x: 150, y: 100, w: 100, h: 200 });
  });

  it("가로로 긴 그림은 위아래에 띠가 생긴다", () => {
    expect(containRect(BOX, 400, 200)).toEqual({ x: 100, y: 150, w: 200, h: 100 });
  });
});

describe("worldToFigure", () => {
  it("꽉 찬 그림의 가운데는 그림의 가운데다", () => {
    expect(worldToFigure(200, 200, BOX, 400, 400)).toEqual({ x: 200, y: 200 });
  });

  /**
   * **이 테스트가 이 파일이 있는 이유다.** 레터박스를 무시하고 아이템 rect에
   * 그대로 매핑하면 동그라미가 그림의 엉뚱한 데 얹히는데, 결과물은
   * "그럴싸한 그림"이라 눈으로는 안 잡힌다.
   */
  it("세로로 긴 그림에서는 띠만큼 밀린다", () => {
    // 그려진 영역은 x 150~250. 그 왼쪽 끝이 그림의 x=0이다.
    expect(worldToFigure(150, 100, BOX, 200, 400)).toEqual({ x: 0, y: 0 });
    expect(worldToFigure(250, 300, BOX, 200, 400)).toEqual({ x: 200, y: 400 });
  });

  it("띠 위의 점은 그림 밖이다", () => {
    expect(worldToFigure(120, 200, BOX, 200, 400)).toBeNull();
  });

  it("상자 밖의 점도 그림 밖이다", () => {
    expect(worldToFigure(0, 0, BOX, 400, 400)).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd frontend && npm test -- figureCrop`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: `figureCrop.ts`를 쓴다**

```ts
/**
 * 도판의 `object-contain` 레터박스 좌표 변환 (D178).
 *
 * `FigureItem`의 `<img>`는 `object-contain`이라 **아이템 상자와 그림이 실제로
 * 그려지는 영역이 다르다** — 세로로 긴 도판은 좌우에, 가로로 긴 도판은
 * 위아래에 빈 띠가 생긴다.
 *
 * 이걸 무시하고 아이템 rect에 그대로 매핑하면 학생이 그린 동그라미가 그림의
 * 엉뚱한 데 얹힌다. **그런데 결과물은 그럴싸한 그림이라 눈으로는 안 잡힌다** —
 * 그래서 순수 함수로 빼고 테스트로 못 박는다(D126·penPad와 같은 이유).
 */

import type { Rect } from "./rect";

/** 상자 안에서 그림이 실제로 차지하는 영역. */
export function containRect(box: Rect, naturalW: number, naturalH: number): Rect {
  if (naturalW <= 0 || naturalH <= 0) return box;
  const scale = Math.min(box.w / naturalW, box.h / naturalH);
  const w = naturalW * scale;
  const h = naturalH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * 월드 좌표 → 그림 자체의 픽셀 좌표. 그림 밖(띠 위·상자 밖)이면 null.
 *
 * null을 그냥 버리지 말 것 — 획 하나가 그림 안팎을 오가면 안쪽 구간만
 * 이어 그려야 한다(호출부가 구간을 끊는다).
 */
export function worldToFigure(
  x: number,
  y: number,
  box: Rect,
  naturalW: number,
  naturalH: number,
): { x: number; y: number } | null {
  const r = containRect(box, naturalW, naturalH);
  if (r.w <= 0 || r.h <= 0) return null;
  const fx = ((x - r.x) / r.w) * naturalW;
  const fy = ((y - r.y) / r.h) * naturalH;
  if (fx < 0 || fy < 0 || fx > naturalW || fy > naturalH) return null;
  return { x: fx, y: fy };
}
```

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `cd frontend && npm test -- figureCrop`
Expected: PASS (7건)

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/canvas2/figureCrop.ts frontend/src/lib/canvas2/figureCrop.test.ts
git commit -m "[feat]: 도판 레터박스 좌표 변환 (D178)"
```

---

### Task 4: `inkRender.ts` — 도식 PNG

**Files:**
- Create: `frontend/src/lib/canvas2/inkRender.ts`

**Interfaces:**
- Consumes: `InkScene`·`PickedCard`(Task 2) · `containRect`·`worldToFigure`(Task 3) · `drawStrokes`·`exportScale`(`./penPad`)
- Produces:
  - `const MARK_COLOR = "#e03131"`
  - `async function renderScenePng(scene: InkScene, strokes, figures: Map<string, ImageBitmap>, maxSide: number): Promise<Blob | null>`
  - `async function renderFigurePng(card: PickedCard, bitmap: ImageBitmap, strokes, maxSide: number): Promise<Blob | null>`

**주의:** 이 파일에는 **기하가 없다.** 상자·좌표는 Task 2·3이 이미 정했고 여기서는 그리기만 한다. vitest 환경에 캔버스가 없어 단위 테스트는 두지 않는다 — 검증은 Task 10의 e2e다.

- [ ] **Step 1: 파일을 쓴다**

핵심만 적는다(전체는 구현 시 채운다):

```ts
/**
 * VLM에 보낼 도식을 그린다 (D178).
 *
 * ## 화면 캡처가 아니다
 *
 * `html2canvas`류를 버린 **결정적인 이유는 뷰포트다** — 패딩으로 끌어온 카드가
 * 화면 밖에 있으면 캡처할 방법이 없는데, 카드를 끌어오는 기준은 "획 주변"이지
 * "화면 안"이 아니다. 도식은 월드 좌표로 그리므로 그 문제가 성립하지 않는다.
 * (덤으로 다른 펜 요소 제거가 공짜다 — 그릴 것만 그리므로.)
 *
 * ## 색이 의미를 나른다
 *
 * 질문 획은 **빨강**이다. 프롬프트가 "빨간 표시"라고 지칭할 수 있어야 카드
 * 테두리와 섞이지 않는다. OCR 그림(`renderInkPng`)은 지금처럼 검정이다 —
 * VARCO가 기대하는 형태이고, D176의 "화면과 전송본은 같은 획" 원칙은 그쪽에
 * 그대로 남는다.
 *
 * ## 기하는 여기 없다
 *
 * 상자와 좌표는 `inkScene`·`figureCrop`이 정한다. 이 파일은 그린다.
 */
```

내용:
- `renderScenePng` — 흰 배경 → 카드마다 둥근 사각 테두리(`#adb5bd`) + 좌상단 번호 배지(원 + 흰 숫자) + 제목(굵게) + 본문 줄바꿈(`measureText` 기반, 상자 높이에서 잘림) → 도판이면 테두리 안에 `containRect` 자리에 `drawImage` → 마지막에 `drawStrokes(ctx, strokes, { color: MARK_COLOR })`
- 폰트는 `600 15px system-ui, sans-serif` / 본문 `13px system-ui, sans-serif`. **손글씨 폰트를 쓰지 않는다** — VLM이 읽을 글자다
- 배율은 `exportScale(scene.capture, 1, maxSide)`를 그대로 쓴다(`penPad`와 같은 규칙)
- `renderFigurePng` — 도판 원본 크기(긴 변 `maxSide`로 클램프) 캔버스에 비트맵을 꽉 채워 그리고, 각 획의 점을 `worldToFigure`로 옮겨 **null인 구간에서 끊어** 그린다

- [ ] **Step 2: 타입 검사**

Run: `cd frontend && npx tsc --noEmit`
Expected: 오류 없음

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/lib/canvas2/inkRender.ts
git commit -m "[feat]: VLM에 보낼 도식 렌더 (D178)"
```

---

### Task 5: 도판 원본 바이트 창구

**Files:**
- Modify: `backend/app/routers/files.py` (`get_figure` 뒤)

**Interfaces:**
- Produces: `GET /api/files/figures/{figure_id}/raw` → 이미지 바이트

**왜 필요한가:** 도판을 `ctx.drawImage`로 그리면 **다른 출처일 때 캔버스가 오염돼 `toBlob`이 `SecurityError`를 던진다** — 그림이 안 나오는 게 아니라 내보내기가 통째로 실패한다. 배포는 같은 출처(`/api`)라 안 걸리지만 로컬에서 `http://localhost:8000/api`로 둔 개발자는 **여기서만** 깨진다. `fetch` + Authorization으로 바이트를 직접 받아 `createImageBitmap`으로 그리면 오염이 성립하지 않는데, `<img src>`는 Authorization을 못 실으므로 signed URL이 이 경로에 안 맞는다.

- [ ] **Step 1: 창구를 더한다**

`get_figure`가 쓰는 RLS 재조회를 그대로 재사용하고, signed URL 대신 `storage.download`로 바이트를 준다. `Cache-Control: private, max-age=300`.

- [ ] **Step 2: 확인**

Run: `cd backend && uv run pytest tests/ -v -k files`
Expected: PASS

- [ ] **Step 3: 커밋**

```bash
git add backend/app/routers/files.py
git commit -m "[feat]: 도판 원본 바이트 창구 — 캔버스 오염 회피 (D178)"
```

---

### Task 6: `ink_marks.py` — VLM 프롬프트와 파싱

**Files:**
- Create: `backend/app/services/ink_marks.py`
- Test: `backend/tests/test_ink_marks.py`

**Interfaces:**
- Consumes: `settings.judge_base_url`·`judge_model`·`judge_api_key`·`ink_vlm_*`(Task 1). `figure_caption.py`의 호출 형태를 따른다
- Produces:
  - `MARKS_SYSTEM: str`
  - `def build_marks_messages(cards: list[dict], scene_uri: str, figure_uri: str | None, figure_n: int | None) -> list[dict]`
  - `def parse_marks(content: str) -> tuple[int | None, str]`
  - `async def read_marks(...) -> tuple[int | None, str]` — **어떤 실패든 `(None, "")`**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`backend/tests/test_ink_marks.py`:

```python
"""펜 표시 해석 (D178) — 프롬프트 조립과 출력 파싱."""

from app.services import ink_marks


def test_정상_출력을_번호와_설명으로_가른다():
    out = "가리킴: 2\n설명: 화살표가 [카드 2]를 가리킨다. [카드 1]은 닿지 않는다."
    pointed, note = ink_marks.parse_marks(out)
    assert pointed == 2
    assert note.startswith("화살표가 [카드 2]")


def test_가리키는_카드가_없으면_None():
    pointed, note = ink_marks.parse_marks("가리킴: 없음\n설명: 동그라미만 있다.")
    assert pointed is None
    assert note == "동그라미만 있다."


def test_설명이_여러_줄이어도_다_가져온다():
    out = "가리킴: 1\n설명: 첫 줄.\n둘째 줄.\n셋째 줄."
    _, note = ink_marks.parse_marks(out)
    assert "둘째 줄." in note and "셋째 줄." in note


def test_형식을_어기면_전체를_설명으로_본다():
    """모델이 형식을 벗어나도 **버리지 않는다** — 설명은 여전히 쓸모가 있다."""
    pointed, note = ink_marks.parse_marks("화살표가 지질학 카드를 가리킨다.")
    assert pointed is None
    assert note == "화살표가 지질학 카드를 가리킨다."


def test_빈_출력은_빈_결과():
    assert ink_marks.parse_marks("") == (None, "")
    assert ink_marks.parse_marks("   \n  ") == (None, "")


def test_번호가_숫자가_아니면_None():
    pointed, _ = ink_marks.parse_marks("가리킴: 지질학\n설명: 뭔가.")
    assert pointed is None


def test_명부에_없는_번호는_버린다():
    """VLM이 4를 말했는데 카드가 3장이면 매핑이 어긋난다 — 조용히 틀리느니 버린다."""
    pointed, _ = ink_marks.parse_marks("가리킴: 9\n설명: 뭔가.", card_count=3)
    assert pointed is None


def test_프롬프트에_카드_명부가_텍스트로_들어간다():
    """이미지 속 작은 제목을 읽게 시키면 틀린다 — 그림에서 풀 문제는 기하뿐이다."""
    cards = [{"n": 1, "title": "천문학"}, {"n": 2, "title": "지질학"}]
    msgs = ink_marks.build_marks_messages(cards, "data:image/png;base64,AAA", None, None)
    text = "".join(
        p["text"] for m in msgs for p in m["content"]
        if isinstance(p, dict) and p.get("type") == "text"
    )
    assert "1 = 천문학" in text
    assert "2 = 지질학" in text


def test_도판_확대본이_있으면_두_번째_그림을_설명한다():
    cards = [{"n": 1, "title": "지질학"}]
    msgs = ink_marks.build_marks_messages(
        cards, "data:image/png;base64,AAA", "data:image/png;base64,BBB", 1
    )
    parts = [p for m in msgs for p in m["content"] if isinstance(p, dict)]
    images = [p for p in parts if p.get("type") == "image_url"]
    text = "".join(p["text"] for p in parts if p.get("type") == "text")
    assert len(images) == 2
    assert "두 번째 그림" in text and "[카드 1]" in text


def test_도판이_없으면_그림은_한_장():
    msgs = ink_marks.build_marks_messages(
        [{"n": 1, "title": "지질학"}], "data:image/png;base64,AAA", None, None
    )
    images = [
        p for m in msgs for p in m["content"]
        if isinstance(p, dict) and p.get("type") == "image_url"
    ]
    assert len(images) == 1


def test_시스템_프롬프트가_세_지시를_담는다():
    s = ink_marks.MARKS_SYSTEM
    # 없으면 작은 모델의 요약이 큰 모델의 근거가 된다
    assert "설명하지 마라" in s
    # 없으면 뭉뚱그려서 SOLAR가 카드 셋 다 설명한다 — 이 지시가 배제의 전부다
    assert "닿지 않았다고" in s
    # 없으면 id 매핑이 문자열 추측이 된다
    assert "[카드 N]" in s
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `cd backend && uv run pytest tests/test_ink_marks.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.ink_marks`

- [ ] **Step 3: `ink_marks.py`를 쓴다**

`parse_marks(content, card_count=None)`:
- 앞뒤 공백 제거. 비면 `(None, "")`
- `가리킴:`으로 시작하는 줄에서 정수를 뽑는다(`없음`·비정수·`card_count` 초과는 `None`)
- `설명:` **이후 전체**를 note로. `설명:` 줄이 없으면 원문 전체를 note로(형식을 어겨도 버리지 않는다)

`MARKS_SYSTEM`은 스펙의 시스템 프롬프트를 그대로.

`build_marks_messages`는 `figure_caption.build_caption_messages`의 모양을 따른다 — `[{"role":"system",...},{"role":"user","content":[{"type":"text"...},{"type":"image_url"...}]}]`.

`read_marks`는 `httpx`로 `{judge_base_url}/chat/completions`에 POST(`max_tokens: 400`, `timeout=ink_vlm_timeout_seconds`). **어떤 예외든 `(None, "")`으로 강등하고 `logger.warning`을 남긴다** — 조용히 넘기지 않는다(D135 주석의 교훈).

- [ ] **Step 4: 테스트를 통과시킨다**

Run: `cd backend && uv run pytest tests/test_ink_marks.py -v`
Expected: PASS (11건)

- [ ] **Step 5: 커밋**

```bash
git add backend/app/services/ink_marks.py backend/tests/test_ink_marks.py
git commit -m "[feat]: 펜 표시 해석 프롬프트와 파싱 (D178)"
```

---

### Task 7: `POST /api/ink/interpret`

**Files:**
- Create: `backend/app/routers/ink.py`
- Modify: `backend/app/main.py` (라우터 등록)

**Interfaces:**
- Consumes: `services.ocr.recognize`(기존) · `services.ink_marks.read_marks`(Task 6)
- Produces: `{"text": str, "marks_note": str, "pointed": int | None, "confidence": None}`

- [ ] **Step 1: 라우터를 쓴다**

`routers/ocr.py`의 오류 갈래(501/413/422/503/502)를 **그대로** 따른다. 다른 점:
- `scene_png`·`figure_png`·`cards`(JSON 문자열)를 선택으로 더 받는다
- `asyncio.gather(ocr_task, vlm_task, return_exceptions=True)`
- **VLM 예외는 삼킨다** — `marks_note=""`, `pointed=None`. OCR 예외만 위로 올린다

```python
# OCR만 다르게 대하는 이유: 다른 둘은 **곁들이**고 OCR은 **질문 자체**다.
# 손글씨를 못 읽으면 대체할 것이 없다.
```

- `ink_vlm_enabled`가 off거나 `scene_png`이 없으면 VLM을 아예 안 부른다

- [ ] **Step 2: `main.py`에 등록한다**

`ocr` 라우터 옆에 `ink`를 더한다.

- [ ] **Step 3: 확인**

Run: `cd backend && uv run pytest tests/ -v`
Expected: PASS (전체)

- [ ] **Step 4: 커밋**

```bash
git add backend/app/routers/ink.py backend/app/main.py
git commit -m "[feat]: OCR·표시 해석을 함께 도는 창구 (D178)"
```

---

### Task 8: 프론트 배선

**Files:**
- Create: `frontend/src/lib/api/ink.ts`
- Modify: `frontend/src/lib/api/index.ts`
- Modify: `frontend/src/components/canvas2/CanvasWorkspace.tsx` (`recognizeInk`, 1057~1100줄 근처)

**Interfaces:**
- Consumes: Task 2·3·4의 순수 함수와 렌더 · Task 5의 `/figures/{id}/raw` · Task 7의 창구
- Produces: `interpretInk(...)` · `CanvasWorkspace`가 들고 있는 `inkCardIds`·`inkMarksNote`

- [ ] **Step 1: `lib/api/ink.ts`를 쓴다**

`lib/api/ocr.ts`의 오류 문구 매핑(`ocrErrorMessage`)을 재사용한다.

- [ ] **Step 2: `recognizeInk`를 확장한다**

순서:
1. `markPending()` → `askStrokes()` (지금 그대로)
2. `toStrokes(els)` → `renderInkPng` (지금 그대로)
3. **새로** 아이템 rect를 모아 `SceneCard[]`를 만든다 — `positions`(월드 좌표) + `sizes`(실측)에서. **DOM을 새로 재지 않는다**(강제 리플로우 없음)
4. `buildInkScene(...)` → 도판이 접촉했고 `ink_figure_zoom_enabled`면 `/figures/{id}/raw`를 fetch → `createImageBitmap`
5. `renderScenePng` · (조건부) `renderFigurePng`
6. `interpretInk(...)` 한 번
7. `text`는 지금처럼 입력창에 **덧붙이고**, `pointed`·`marks_note`·`card_ids`는 다음 질문에 실을 state에 둔다

**도판 fetch 실패는 삼킨다** — 라벨 상자로 그리고 계속한다.

- [ ] **Step 3: 타입·린트**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 오류 없음. React Compiler 규칙 위반이 나면 **억제하지 말고 구조로 푼다**

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/lib/api/ink.ts frontend/src/lib/api/index.ts frontend/src/components/canvas2/CanvasWorkspace.tsx
git commit -m "[feat]: 표시·카드를 함께 보내도록 질문 필기 경로 확장 (D178)"
```

---

### Task 9: SOLAR에 넘기기

**Files:**
- Modify: `backend/app/routers/chat.py` (`ChatStreamBody`, 82~93줄)
- Modify: `backend/app/services/gemini.py` (`compose_system_structured`)
- Modify: `frontend/src/lib/api/chat.ts` (질문 보낼 때 `ink` 실기)

**Interfaces:**
- Produces: `ChatStreamBody.ink: InkContext | None`

- [ ] **Step 1: `InkContext`를 더한다**

```python
class InkContext(BaseModel):
    """펜 표시 해석 결과 (D178).

    **카드 본문은 받지 않는다** — id만 받고 서버가 user_conn()으로 다시 읽는다.
    클라이언트가 보낸 본문을 프롬프트에 그대로 넣는 것은 기존 신뢰 경계
    규약(D104)과 결이 안 맞는다.
    """
    marks_note: str = Field(default="", max_length=2000)
    card_ids: list[str] = Field(default_factory=list, max_length=8)
```

- [ ] **Step 2: 카드를 다시 읽어 블록을 만든다**

`canvas_items`에서 `user_conn()` 경로로 id 목록을 조회한다. **찾지 못한 id는 버린다.** 본문은 `ink_card_body_max_chars`로 자른다.

```
[화면에 그린 표시]
{marks_note}

[표시 주변의 카드]
[카드 1] 천문학: …
[카드 2] 지질학: …
```

**번호가 두 블록에서 같아야 한다** — 대응이 깨지면 SOLAR가 엉뚱한 카드를 설명하고, 그 답은 그럴싸해서 아무도 못 잡는다. 번호는 `card_ids`의 순서(= 프론트가 매긴 `n`)를 그대로 쓴다.

- [ ] **Step 3: `compose_system_structured`에 `ink_context=`를 더한다**

`tree_context` 뒤에 놓는다 — `session_files`가 앞에 있어야 Friendli 프리픽스 캐시가 보존된다(D85).

- [ ] **Step 4: 확인**

Run: `cd backend && uv run pytest tests/ -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add backend/app/routers/chat.py backend/app/services/gemini.py frontend/src/lib/api/chat.ts
git commit -m "[feat]: 표시 해석과 주변 카드를 프롬프트에 주입 (D178)"
```

---

### Task 10: 실측과 e2e

**Files:**
- Create: `frontend/e2e/ink-marks.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-05-ink-question-vlm-design.md` (실측 결과 기록)

- [ ] **Step 1: e2e를 쓴다**

`ask-ink.spec.ts`의 획 긋는 방식(hover → 닿음 → 이동 → 뗌 → hover)을 그대로 쓴다. 확인할 것:
- 카드 옆에 획을 긋고 [글자 인식]을 누르면 요청에 `scene_png`과 `cards`가 실린다
- 카드가 하나도 근처에 없으면 `scene_png`이 안 실린다
- 보낸 도식 PNG의 **실제 크기**가 `ink_scene_max_side` 이하다

- [ ] **Step 2: EXAONE 비전 해상도를 잰다**

스펙에 적어 둔 **모르는 사실**이다 — 고정 해상도면 도판 확대본이 필수, 동적 타일링이면 도식 한 장으로 갈음할 수 있다.

서버에서 도판 하나로 두 형태를 실제로 물어본다:
1. 도식 한 장(1280px)만 주고 도판 안 글자를 읽게 한다
2. 도식 + 확대본을 주고 같은 것을 읽게 한다

둘의 정확도를 비교해 결과를 스펙 "지연" 절에 적는다. **추측으로 정하지 않는다.**

- [ ] **Step 3: 로컬에서 손으로 한 번 돌린다**

카드 3장을 만들고 그중 하나에 동그라미 + 화살표 + "이거에 대해서 더 자세하게 설명해줘"를 쓴 뒤 [AI에게 묻기]. 확인:
- VLM이 **닿지 않은 두 카드를 닿지 않았다고** 말하는가 (이게 이 기능의 핵심)
- SOLAR의 답이 가리킨 카드에 대한 것인가
- 관리자 콘솔 "손글씨 인식" 그룹에 노브 8개가 다 뜨는가

- [ ] **Step 4: 커밋**

```bash
git add frontend/e2e/ink-marks.spec.ts docs/superpowers/specs/2026-08-05-ink-question-vlm-design.md
git commit -m "[docs]: 펜 표시 해석 e2e와 비전 해상도 실측 (D178)"
```

---

## Self-Review

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| 그림을 나누는 이유 | Task 4 (도식) — OCR 쪽은 기존 `renderInkPng` 그대로 |
| 도식이지 캡처가 아님 | Task 4 |
| 그림 2 도판 확대 | Task 3·4·5 |
| 카드 선정 알고리즘 (1단·2단·상한·클램프·한 번만) | Task 2 |
| 캔버스 오염 회피 | Task 5 |
| 레터박스 | Task 3 |
| VLM 프롬프트 세 지시 | Task 6 |
| 창구·실패 정책 | Task 7 |
| SOLAR 주입 (id만, 번호 대응) | Task 9 |
| 노브 8개 | Task 1 |
| 지연·비전 해상도 실측 | Task 10 |
| 안 하는 것(표시 저장·판정 로그·화살표 각도) | 어느 태스크에도 없음 — 의도대로 |

**타입 일관성**: `SceneCard`·`PickedCard`·`InkScene`은 Task 2가 정의하고 Task 4·8이 그 이름 그대로 쓴다. `parse_marks`는 Task 6이 `(int | None, str)`을 내고 Task 7이 그 순서로 받는다. `containRect`·`worldToFigure`는 Task 3 정의를 Task 4가 쓴다.

**남은 판단**: Task 4·5·7·8·9는 코드 전문 대신 계약과 제약을 적었다. 순수 함수(Task 2·3·6)만 전문을 확정한 것은 **거기가 틀려도 안 보이는 곳**이기 때문이다 — 나머지는 실패가 화면이나 테스트에 바로 드러난다.
