# 고정 교과과정 태그 + 카드 추종 SVG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 태그를 고2 지구과학 7개로 고정(EXAONE 프롬프트 강제)하고, 태그 위치를 지도에 고정 앵커(칠각형)로 두어 카드가 자기 태그 앵커 주변에 모이게 하며(동적 드리프트 폐기), SVG 단일 대표가 앵커 카드를 따라 이동하도록 검증한다.

**Architecture:** 프론트 공용 상수 `curriculumTags.ts`(7 태그→고정 앵커) + `useTagLayout` 응집 타깃을 동적 무게중심→고정 앵커로 변경 + `tagCentroids` 출력을 고정 앵커·populated-only로. EXAONE 프롬프트는 분류를 7개 enum으로 강제. 마커/미니맵/SVG추종은 기존 소비 그대로(입력만 고정 앵커).

**Tech Stack:** Next.js 16/React 19/TS + d3-force(기존), FastAPI(프롬프트 문자열). 백엔드 pytest, 프론트 tsx 새너티 + tsc/eslint + Playwright.

## Global Constraints

- **7개 태그 문자열은 백엔드 프롬프트와 프론트 `CURRICULUM_TAGS`가 정확히 동일**해야 한다(모델 출력 문자열 → 앵커 매핑): `해수의 운동과 순환`, `지구의 형성과 역장`, `지구 구성 물질과 자원`, `한반도의 지질`, `대기의 운동과 순환`, `행성의 운동`, `우리은하와 우주의 구조`.
- **태그 위치 고정**: `tagAnchor(tag)` = 칠각형 앵커(`CENTER=(1600,1100)`, `R=1400`, `θ_i=-π/2+i·2π/7`); 7개 밖/`기타`/미지 → `CENTER`. 결정론.
- **응집=고정 앵커**: `useTagLayout` 카드는 `tagAnchor(node.tag)`로 당겨지고 `forceCollide`로 무겹침. 태그는 안 움직인다. 인터-태그 분리는 고정 앵커가 담당(동적 count 분리 폐기).
- **`tagCentroids` 출력 = 고정 앵커 + count, 카드≥1 태그만**(마커·미니맵이 자동으로 populated-only·고정 위치).
- **SVG/영상**: 단일 대표(최고 스코어) 유지, 앵커 카드 sim 위치 추종(기존 T3 re-anchor) — 본 계획은 검증만.
- **`git add`는 명시 경로만**(레포 미추적 파일 다수 — `git add -A` 금지). 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `backend/app/services/exaone.py` | 프롬프트 | 분류를 7개 enum으로 강제 |
| `frontend/src/lib/concept/curriculumTags.ts` | 7 태그→고정 앵커 | Create |
| `frontend/src/lib/concept/useTagLayout.ts` | 응집=고정앵커·centroids=앵커·populated | Modify |

프론트 유닛 러너 없음 → 순수(`curriculumTags`)는 `npx tsx`; 훅은 tsc/eslint + Playwright.

---

## Task 1: EXAONE 프롬프트 — 7개 고정 태그 강제

**Files:** Modify `backend/app/services/exaone.py`

- [ ] **Step 1: 분류 규칙 교체**

`CONCEPT_CARD_SYSTEM_PROMPT`의 현재 분류 규칙 블록(직전 피처에서 넣은 "분류는 이 개념이 지도에서 어느 무리에… 넓게 잡는다." 4줄)을 아래로 교체:
```
- "분류"는 반드시 다음 7개 중 정확히 하나만 사용한다(문자열을 그대로, 새 분류어 금지):
  해수의 운동과 순환 / 지구의 형성과 역장 / 지구 구성 물질과 자원 / 한반도의 지질 /
  대기의 운동과 순환 / 행성의 운동 / 우리은하와 우주의 구조.
  이 서비스는 고등학교 2학년 지구과학 범위다. 질문이 범위와 조금 달라도 위 7개 중 가장
  가까운 단원으로 분류한다. 표기를 위 목록과 글자 하나까지 똑같이 맞춘다.
```

- [ ] **Step 2: 회귀 확인**

Run: `cd backend && uv run pytest -q`
Expected: 통과(프롬프트 문자열 변경만).
Runtime(선택): dev 서버로 각 단원 질문 → `@concept … | 분류`가 7개 중 하나로만 나오는지 육안(가능 시 SSE 로깅).

- [ ] **Step 3: 커밋**
```bash
git add backend/app/services/exaone.py
git commit -m "$(cat <<'EOF'
[feat]: 분류를 고2 지구과학 7개 단원으로 강제(EXAONE 프롬프트)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `curriculumTags.ts` — 7 태그 고정 앵커

**Files:** Create `frontend/src/lib/concept/curriculumTags.ts`; Test `/tmp/curriculum-unit.ts`

**Interfaces:** Produces `CURRICULUM_TAGS: readonly string[]`, `tagAnchor(tag:string): {x:number;y:number}`, `CENTER`.

- [ ] **Step 1: 실패 새너티**

`/tmp/curriculum-unit.ts`:
```ts
import { CURRICULUM_TAGS, tagAnchor, CENTER } from "/Users/dhkim/Desktop/ai-rookie/Nodi/frontend/src/lib/concept/curriculumTags.ts";

if (CURRICULUM_TAGS.length !== 7) throw new Error("expected 7 tags");
// 각 태그 앵커가 서로 다름 + CENTER와 떨어짐
const seen = new Set<string>();
for (const t of CURRICULUM_TAGS) {
  const a = tagAnchor(t);
  const key = `${Math.round(a.x)},${Math.round(a.y)}`;
  if (seen.has(key)) throw new Error("duplicate anchor " + t);
  seen.add(key);
  if (Math.hypot(a.x - CENTER.x, a.y - CENTER.y) < 500) throw new Error("anchor too close to center " + t);
}
// 인접 앵커 분리 하한
const a0 = tagAnchor(CURRICULUM_TAGS[0]), a1 = tagAnchor(CURRICULUM_TAGS[1]);
if (Math.hypot(a0.x - a1.x, a0.y - a1.y) < 400) throw new Error("adjacent anchors too close");
// 미지/기타 → CENTER
const u = tagAnchor("존재하지않는태그");
if (u.x !== CENTER.x || u.y !== CENTER.y) throw new Error("unknown tag not centered");
if (tagAnchor("기타").x !== CENTER.x) throw new Error("기타 not centered");
console.log("PASS", { n: CURRICULUM_TAGS.length, a0, a1 });
```

- [ ] **Step 2: 실패 확인** — `cd frontend && npx tsx /tmp/curriculum-unit.ts` → FAIL(모듈 없음).

- [ ] **Step 3: 구현**

`frontend/src/lib/concept/curriculumTags.ts`:
```ts
// 고2 지구과학 7개 고정 태그 → 지도 고정 앵커(칠각형). EXAONE 프롬프트의 분류 문자열과
// 반드시 정확히 일치해야 한다(모델 출력 → 앵커 매핑). 미지/"기타"는 중앙 폴백.

export const CANVAS_W = 3200;
export const CANVAS_H = 2200;
export const CENTER = { x: CANVAS_W / 2, y: CANVAS_H / 2 };

// 순서 = 칠각형 인덱스. 백엔드 CONCEPT_CARD_SYSTEM_PROMPT와 글자까지 동일.
export const CURRICULUM_TAGS = [
  "해수의 운동과 순환",
  "지구의 형성과 역장",
  "지구 구성 물질과 자원",
  "한반도의 지질",
  "대기의 운동과 순환",
  "행성의 운동",
  "우리은하와 우주의 구조",
] as const;

const R = 1400; // 칠각형 반경(px) — 클러스터 간 분리
const _ANCHORS = new Map<string, { x: number; y: number }>();
CURRICULUM_TAGS.forEach((t, i) => {
  const th = -Math.PI / 2 + (i * 2 * Math.PI) / CURRICULUM_TAGS.length;
  _ANCHORS.set(t, { x: CENTER.x + R * Math.cos(th), y: CENTER.y + R * Math.sin(th) });
});

// 태그 → 고정 앵커. 7개 밖/"기타"/미지 → 중앙.
export function tagAnchor(tag: string): { x: number; y: number } {
  return _ANCHORS.get(tag) ?? CENTER;
}
```

- [ ] **Step 4: 통과 + 타입/린트** — `cd frontend && npx tsx /tmp/curriculum-unit.ts && npx tsc --noEmit && npx eslint src/lib/concept/curriculumTags.ts` → PASS·EXIT 0.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/lib/concept/curriculumTags.ts
git commit -m "$(cat <<'EOF'
[feat]: curriculumTags — 고2 지구과학 7개 태그 고정 앵커(칠각형)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `useTagLayout` — 응집=고정 앵커, centroids=앵커·populated

**Files:** Modify `frontend/src/lib/concept/useTagLayout.ts`

**Interfaces:** Consumes T2 `tagAnchor`. 반환 시그니처 불변(`{positions, tagCentroids}`).

- [ ] **Step 1: import + 상수**

상단 import에 추가하고 `tagSeed` import는 제거(더 이상 사용 안 함):
```ts
import { tagCentroids as centroidsOf, CARD_W } from "./tagLayoutCore";
import { tagAnchor } from "./curriculumTags";
```
`CHARGE`를 약화(인터-태그 분리는 고정 앵커가 담당, 클러스터 내 분산용):
```ts
const CHARGE = -500;    // 클러스터 내 균등 분산(인터-태그 분리는 고정 앵커)
```

- [ ] **Step 2: 시드를 고정 앵커 근처로**

노드 생성부(현재 `const seed = tagSeed(...)` 및 `tagIndexRef`)를 아래로 교체. `tagIndexRef`는 제거(앵커가 태그 문자열로 고정이라 첫등장 순서 불필요):
```ts
      if (!n) {
        const cardIdx = tagCountRef.current.get(tag) ?? 0;
        tagCountRef.current.set(tag, cardIdx + 1);
        // 자기 태그 고정 앵커 근처로 시드(결정론 소나선 → 초기 겹침 방지, 즉시 제자리).
        const a = tagAnchor(tag);
        const cr = 60 * Math.sqrt(cardIdx + 1);
        const cang = (cardIdx + 1) * 2.399963; // 황금각(rad)
        n = { id: it.id, tag, h: it.h, x: a.x + cr * Math.cos(cang), y: a.y + cr * Math.sin(cang) };
        nodes.set(it.id, n);
      } else {
```
(`tagIndexRef` 선언 줄 삭제.)

- [ ] **Step 3: 응집을 고정 앵커로**

`cohesion` 커스텀 포스를 동적 무게중심 대신 고정 앵커로:
```ts
    // 태그 응집: 각 카드를 자기 태그의 "고정 앵커"로 당김(무게중심 아님 → 태그 위치 고정).
    const cohesion = (alpha: number) => {
      for (const n of arr) {
        const a = tagAnchor(n.tag);
        n.vx = (n.vx ?? 0) + (a.x - n.x) * COHESION * alpha;
        n.vy = (n.vy ?? 0) + (a.y - n.y) * COHESION * alpha;
      }
    };
```

- [ ] **Step 4: `snapshot`의 tagCentroids를 고정 앵커·populated로**

`snapshot`을 아래로 교체(무게중심 대신 고정 앵커; count는 노드에서 집계; 카드 있는 태그만):
```ts
function snapshot(arr: LNode[]): { positions: Positions; tagCentroids: Centroids } {
  const positions: Positions = new Map();
  const counts = new Map<string, number>();
  for (const n of arr) {
    positions.set(n.id, { x: n.x, y: n.y });
    counts.set(n.tag, (counts.get(n.tag) ?? 0) + 1);
  }
  const tagCentroids: Centroids = new Map();
  for (const [tag, count] of counts) {
    const a = tagAnchor(tag);
    tagCentroids.set(tag, { x: a.x, y: a.y, count }); // 위치=고정 앵커, populated-only
  }
  return { positions, tagCentroids };
}
```
(파일 상단 주석의 "무게중심으로 응집"도 "고정 앵커로 응집"으로 갱신. `centroidsOf` import가 더 이상 안 쓰이면 제거해 eslint no-unused 통과.)

- [ ] **Step 5: 타입/린트 + E2E**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useTagLayout.ts`
Expected: EXIT 0(미사용 `tagSeed`/`centroidsOf`/`tagIndexRef` 잔재 없음).
Runtime(Playwright `/tmp/nodi-e2e-QaXC/`): 서로 다른 단원 질문 → 각 태그가 **고정 위치**에 클러스터(재질의해도 태그 위치 불변), 카드 있는 태그만 마커, SVG가 카드 이동 시 함께 이동(단일 대표), 무겹침. 환경 제약 시 DONE_WITH_CONCERNS.

- [ ] **Step 6: 커밋**
```bash
git add frontend/src/lib/concept/useTagLayout.ts
git commit -m "$(cat <<'EOF'
[feat]: useTagLayout 응집을 고정 태그 앵커로 — 태그 위치 고정, centroids=앵커·populated

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §2 7개 태그 프롬프트 강제 → T1. ✓
- §3-1 curriculumTags 고정 앵커 → T2. §3-2 응집=고정앵커·centroids=앵커·populated → T3. ✓
- §3-3 마커/미니맵 → 변경 없이 tagCentroids 소비(고정 앵커·populated 자동 반영). ✓
- §4 SVG 카드 추종 → 기존 T3 re-anchor 유지, E2E 검증(T3 Step5). ✓
- §7 테스트(tagAnchor 새너티·E2E) → T2·T3. ✓
- §8 비범위(동적 드리프트 폐기·서버 사문화 후속). ✓

**2. Placeholder scan:** 코드 스텝에 실제 코드. T3은 대형 파일 국소 치환이라 정확한 치환 지점+코드 명시. ✓

**3. Type consistency:**
- `tagAnchor(tag)→{x,y}` — T2 정의 ↔ T3 cohesion/seed/snapshot 사용 일치. ✓
- `useTagLayout` 반환 `{positions, tagCentroids: Map<tag,{x,y,count}>}` 불변 → 마커/미니맵 소비부 무변경. ✓
- 7개 태그 문자열: T1(프롬프트) ↔ T2(`CURRICULUM_TAGS`) 글자 단위 동일(§Global Constraints 명시). ✓
- `concept.cluster`(파서 태그) → 워크스페이스 `layoutItems` `tag: c.cluster||"기타"` → `tagAnchor`가 7개/기타 매핑. ✓

**주의(실행):** T3 후 `tagSeed`(tagLayoutCore)·`centroidsOf`가 useTagLayout에서 미사용이 되면 import 제거로 eslint green. `tagLayoutCore`의 `tagSeed`/`tagCentroids`는 다른 참조 없으면 사문화(제거는 후속, 비차단).
