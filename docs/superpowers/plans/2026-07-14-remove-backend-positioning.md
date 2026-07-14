# 백엔드 카드 위치 로직 완전 제거 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카드 위치·포커스는 프론트(d3-force + sim 추종)가 소유하므로, 서버의 `place` SSE·`near`·태그 배치·좌표 저장·`canvas_layout`을 완전히 제거한다. 서버는 토큰 스트림 + EBS/삽화 검색·저장만 담당.

**Architecture:** 순서로 무중단 유지 — 먼저 프론트가 서버 `place`/`near`/`place_hint`/attachments 좌표에 의존하지 않게 만들고(서버는 아직 보내되 프론트 무시), 그 다음 백엔드에서 해당 로직을 삭제한다. 프론트는 이미 스트림 토큰을 파싱해 카드+태그(cluster)를 만들고 d3-force로 배치한다.

**Tech Stack:** FastAPI(SSE), Next.js/React/TS. 백엔드 pytest, 프론트 tsc/eslint + Playwright(`/tmp/nodi-e2e-QaXC/`).

## Global Constraints

- **무중단 순서**: Task 1(프론트, place/near 의존 제거) → Task 2(백엔드, 삭제). 각 태스크 종료 시 앱이 동작해야 함.
- 카드 초기 좌표(파서 cstart/플레이스홀더)는 **CENTER 상수**(`curriculumTags`의 `CENTER=(1600,1100)`) — sim이 태그 앵커로 재배치하므로 잠깐의 폴백일 뿐.
- **유지**: 프론트 d3-force/`useTagLayout`/태그 앵커/카메라 sim 추종(직전 커밋), EBS/삽화 검색·단일 대표·카드 추종, retrieve의 ebs/art·degraded, done 훅의 ebs/art attachments 저장.
- **제거**: 서버 `place` SSE·settle 배치·`tag_anchor`/`place_by_tag`/`_first_free_position`/`ExistingCard`·`retrieve near`·`place_hint`·attachments의 concepts 좌표·`canvas_layout.py`·위치 config 상수.
- `git add`는 명시 경로만(레포 미추적 파일 다수 — `git add -A` 금지). 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **(프로세스) 서브에이전트는 opus 4.8 사용.**

---

## Task 1: 프론트 — place/near/place_hint 의존 제거

**Files:** Modify `frontend/src/lib/concept/useConceptStream.ts`, `frontend/src/lib/api.ts`

- [ ] **Step 1: `api.ts` — place/near 타입·콜백 제거**

`api.ts`에서:
- `RetrieveResult`의 `near` 필드 제거(+ 파싱부 `near:{...}` 제거). `ebs`/`art`/`degraded`만.
- `ChatStreamBody`의 `place_hint?` 필드 제거.
- `PlaceEvent` 타입 제거. `streamChat`(consumeSSE) 시그니처에서 `onPlace` 콜백과 `event: place` 분기 제거(수신해도 무시 — 분기 삭제).
grep 확인: `grep -rn "PlaceEvent\|place_hint\|\.near" frontend/src/lib/api.ts` → 없음.

- [ ] **Step 2: `useConceptStream.ts` — cstart 좌표를 CENTER로, place/near 제거**

- import: `import { CENTER } from "./curriculumTags";` 추가. `PlaceEvent` import 제거.
- `pendingCoordsRef` 선언·초기화(`new Map()`)·모든 사용 제거.
- `applyEvent`의 cstart 두 분기(첫 cstart 승격 / 이후 cstart)에서 `pendingCoordsRef`·`near`·placeCoord 로직 제거 → 좌표를 항상 `CENTER`로 주입:
  - 첫 cstart 승격: `const xy = { x: CENTER.x, y: CENTER.y };` (pendingConcept/placeCoord 조회 삭제).
  - 이후 cstart: `reduceConcept(..., { x: CENTER.x, y: CENTER.y })`.
- `onPlace` 콜백(streamChat 옵션) 전체 제거.
- send 플로우의 `nearXY`: `r.near` 의존 제거 → 플레이스홀더/리프 앵커 기준을 CENTER로. 구체:
  - `let nearXY = { x: CENTER.x, y: CENTER.y };` (degraded 분기의 last-card 오프셋은 유지해도 되나, 단순화: 항상 CENTER). 플레이스홀더 커밋 x/y·`focusSignal`(x:CENTER.x, y:CENTER.y, key, id:pid)·리프 `placeRep`의 prefX/prefY 기준을 nearXY(=CENTER)로.
- `streamChat` 바디에서 `place_hint` 제거.
- **재수화**(`replayNodes`/detail effect): `coordMap`(attachments.canvas.concepts 좌표 적용) 제거 — built 개념 좌표는 CENTER 기본(sim이 배치). attachments.ebs/art 리프 재수화는 유지.
grep 확인: `grep -n "pendingCoordsRef\|onPlace\|place_hint\|r\.near\|PlaceEvent\|coordMap" frontend/src/lib/concept/useConceptStream.ts` → 없음(또는 주석만).

- [ ] **Step 3: 타입/린트**

Run: `cd frontend && npx tsc --noEmit && npx eslint src/lib/concept/useConceptStream.ts src/lib/api.ts`
Expected: EXIT 0(미사용 심볼 없음).

- [ ] **Step 4: E2E (백엔드 미변경 상태에서 정상)**

Run: Playwright `/tmp/nodi-e2e-QaXC/` — 질문 다수 → 카드 생성·태그 클러스터·카메라 추종·단일 리프·재수화 정상(서버는 아직 place/near를 보내지만 프론트가 무시). 환경 제약 시 DONE_WITH_CONCERNS.

- [ ] **Step 5: 커밋**
```bash
git add frontend/src/lib/concept/useConceptStream.ts frontend/src/lib/api.ts
git commit -m "$(cat <<'EOF'
[refactor]: 프론트가 서버 place/near/place_hint에 의존하지 않게 — cstart 좌표 CENTER + sim

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 백엔드 — 위치 계산·전송·저장 삭제

**Files:** Modify `backend/app/routers/chat.py`, `backend/app/routers/retrieve.py`, `backend/app/config.py`; Delete `backend/app/services/canvas_layout.py`, `backend/app/services/concept_blocks.py`, `backend/tests/test_tag_placement.py`, `backend/tests/test_concept_blocks_cluster.py`; Modify `backend/tests/test_chat_place.py`

- [ ] **Step 1: `chat.py` — place/settle/positioning 제거**

- import 제거: `from ..services.canvas_layout import (…)`(estimate_card_height/place_by_tag/tag_anchor), `concept_blocks`.
- 함수 삭제: `_tag_state_from_nodes`, `_place_tagged`, `_next_place_event`(스트림 place), 그리고 `placed_coords`/`placed_heights`/`placed_tags`/`_live_cards`/`_live_tags`/`stream_cards`/`stream_tag_index` 관련 상태.
- 스트리밍 루프의 `@concept` 감지 → `yield _sse("place", _next_place_event(_tag))` 2개소 삭제(라인 버퍼 감지 자체 삭제).
- done 훅 settle 블록(`concept_blocks.parse` 루프 + `place{is_final}` + concepts_meta 구성) 삭제.
- `svc.get_session_nodes(client, session_id)` 호출(태그 상태용) 제거(다른 용도로 안 쓰면).
- done 훅 저장: `_patch_canvas_unified(client, node["id"], body.retrieved)`만 호출(concepts 없이). retrieved 없으면 생략.

- [ ] **Step 2: `_patch_canvas_unified` 단순화**

`_patch_canvas_unified` 시그니처를 `(client, node_id, retrieved)` 로 축소(concepts_meta 인자 제거). 본문:
```python
async def _patch_canvas_unified(
    client: UserClient, node_id: str, retrieved: RetrievedBody | None = None,
) -> None:
    """nodes.attachments.canvas에 ebs/art만 저장(카드 좌표는 프론트 소유 — 저장 안 함)."""
    if retrieved is None:
        return
    try:
        rows = await client.select("nodes", {"id": f"eq.{node_id}", "select": "id,attachments", "limit": "1"})
        if not rows:
            return
        attachments = rows[0].get("attachments") or {}
        if not isinstance(attachments, dict):
            attachments = {}
        attachments["canvas"] = {
            "ebs": [e.model_dump() for e in retrieved.ebs],
            "art": [a.model_dump() for a in retrieved.art],
        }
        await client.update("nodes", {"id": f"eq.{node_id}"}, {"attachments": attachments})
    except Exception:  # noqa: BLE001
        logger.warning("attachments.canvas(ebs/art) 저장 실패 node=%s", node_id, exc_info=True)
```

- [ ] **Step 3: `retrieve.py` — near 제거**

`retrieve.py`에서 `canvas_layout`(CANVAS_W/H) import 제거, `center`/`near` 제거. 응답을 `{ebs, art, degraded}`로 축소(빈 질문·성공·except 세 분기 모두). ebs/art 검색(질의 임베딩)은 유지.

- [ ] **Step 4: 삭제 + config 정리**

- `git rm backend/app/services/canvas_layout.py backend/app/services/concept_blocks.py backend/tests/test_tag_placement.py backend/tests/test_concept_blocks_cluster.py`
- `config.py`에서 위치 상수 제거: `tag_r0`, `force_s_merge/force_s_min/force_gamma/force_d_max/force_min_gap/force_k_attr/force_k_rep/force_tau/force_iters/force_t0/force_alpha`, `card_w/card_h_min/card_h_max/card_h_per_line`. (retrieve_*·textbook_*·embedding 등 유지.)
- `test_chat_place.py`: place/settle/`_patch_canvas_unified(concepts)` 관련 테스트 삭제·갱신. `_patch_canvas_unified`를 새 시그니처로 부르거나 해당 테스트 제거. 나머지(textbook 등) 유지.
- grep 확인: `grep -rn "canvas_layout\|place_by_tag\|tag_anchor\|_next_place_event\|_tag_state_from_nodes\|concept_blocks\|\"place\"\|is_final\|near\|tag_r0\|force_s_merge\|card_w" backend/app` → 없음(주석 제외).

- [ ] **Step 5: 백엔드 스위트 + E2E**

Run: `cd backend && uv run pytest -q` → 통과(삭제·갱신 후 import 에러 없음).
Runtime(Playwright): 서버 SSE에 `place` 이벤트 없음(예: 토큰만), retrieve 응답에 `near` 키 없음. 카드 생성·태그 클러스터·카메라 추종·단일 리프·재수화 전부 정상. 환경 제약 시 DONE_WITH_CONCERNS로 컨트롤러 위임.

- [ ] **Step 6: 커밋**
```bash
git add backend/app/routers/chat.py backend/app/routers/retrieve.py backend/app/config.py backend/tests/test_chat_place.py
git add -u backend/app/services/canvas_layout.py backend/app/services/concept_blocks.py backend/tests/test_tag_placement.py backend/tests/test_concept_blocks_cluster.py
git commit -m "$(cat <<'EOF'
[refactor]: 백엔드 카드 위치 로직 완전 제거 — place SSE·settle·near·canvas_layout 삭제

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- §2 프론트 place/near/place_hint/coordMap 제거 → Task 1. ✓
- §3 백엔드 chat/retrieve/canvas_layout/config/concept_blocks 삭제 → Task 2. ✓
- §4 `_patch_canvas_unified` ebs/art만 → Task 2 Step 2. ✓
- §5 흐름(토큰 스트림+ebs/art, 재수화 재파싱) → Task 1 Step 2·Task 2. ✓
- §7 테스트(pytest·E2E place/near 부재) → Task 2 Step 5, Task 1 Step 4. ✓
- §8 비범위(ebs/art·프론트 레이아웃·임베딩 유지). ✓
- 갭 없음.

**2. Placeholder scan:** 삭제 태스크라 "삭제 대상 + grep 확인 + 핵심 치환(CENTER, `_patch_canvas_unified` 본문)"으로 구체화. 코드 필요한 곳(§Task2 Step2)엔 실제 코드. ✓

**3. Type consistency:**
- `CENTER`(curriculumTags) — Task 1 cstart/placeholder/focusSignal 좌표. ✓
- `_patch_canvas_unified(client, node_id, retrieved)` — Task 2 Step 2 정의 ↔ Step 1 호출 일치. ✓
- 무중단 순서: Task 1 후 프론트가 place/near 무시(서버 여전히 전송) → 동작; Task 2 후 서버 미전송 → 프론트 이미 무의존 → 동작. ✓

**주의(실행):** Task 2 삭제 중 `test_chat_place.py`가 삭제 함수(place/settle/`_patch_canvas_unified(concepts)`)를 참조하면 그 참조를 제거해야 스위트가 collect된다. `retrieved`가 `body.retrieved`(RetrievedBody|None) — done 훅 호출부에서 그대로 전달.
