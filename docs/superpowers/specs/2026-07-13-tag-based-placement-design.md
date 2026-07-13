# 태그 기반 카드 배치 설계 (벡터 배치 폐기)

날짜: 2026-07-13
상태: 사용자 승인 완료 (스펙 작성 → 구현 계획 전)
선행:
- 2026-07-12-force-cluster-placement-design.md (폐기 대상: 벡터·힘 배치)
- 2026-07-13-query-answer-embedding-single-leaf-design.md (Part A 폐기, Part B 리프 유지)

## 1. 배경과 목표

임베딩(질의/응답 passage) 코사인 유사도 + 힘 솔버 기반 배치가 실사용에서 클러스터가 잘
형성되지 않았다. **벡터 기반 위치 결정을 폐기**하고, EXAONE가 이미 응답에 실어 보내는
**개념 태그(`@concept: 제목 | 분류`의 분류)** 로 위치를 정한다.

**목표:**
- 같은 태그(분류)의 카드는 지도의 **한 앵커로 모여 클러스터**를 이룬다.
- 처음 나온 태그면 **지도에 새 앵커를 생성**(서로 다른 주제는 멀리 분산).
- 서버 권위 유지 — 기존 `place` SSE 계약 그대로라 프론트 렌더·자동포커싱·미니맵·무겹침·단일리프는 유지.

**핵심 결정(승인됨):**
- 태그 = 기존 `cluster`(분류) 재사용 + 프롬프트 강화(안정적·성긴 대분류, 동일 표기 재사용).
- 배치 계산 = **서버 권위**(place SSE 유지, 배치 로직만 벡터→태그로 교체).
- 세션 카드 상태 = **노드 attachments**에서 재구성(canvas_cards 벡터 저장 폐기).

## 2. 태그 소스 + 프롬프트 강화

- `conceptParser`(프론트)는 이미 `@concept: 제목 | 분류`에서 `cluster`를 파싱한다.
- 서버 `concept_blocks.parse`는 현재 `{index,title,body}`만 반환 → **`cluster` 추가**(현재 `parts[1]` 폐기 중).
- 스트리밍 중 `@concept:` 라인 감지 시점(`_CONCEPT_LINE_RE`)에도 태그를 추출(라인에서 `| 뒤`).
- **프롬프트 강화**(`CONCEPT_CARD_SYSTEM_PROMPT`): "분류"를 지도에서 개념을 묶는
  **안정적이고 성긴 대분류**(예: `광합성`, `지구계`, `세포`)로 정하고, 같은 주제의 개념은
  **반드시 동일한 분류어를 재사용**(동의어·띄어쓰기 통일)하도록 명시. 태그 일관성이 클러스터 품질을 좌우.
- 빈 분류(모델 누락) → 서버가 `"기타"` 폴백 태그로 대체.

## 3. 서버 태그→앵커 배치 (canvas_layout.py)

### 3-1. 태그 앵커 (새 태그 = 새 앵커)
세션에서 태그가 **처음 나온 순서** k(0-based)로 결정론 배치 — Vogel(해바라기) 나선:
```
CENTER = (CANVAS_W/2, CANVAS_H/2)      # 예 (1600, 1100)
tag_anchor(k):
    angle = k * 137.5°  (radian)        # 황금각
    r     = TAG_R0 * sqrt(k)            # TAG_R0 = 튜너블(예 560px)
    return (CENTER.x + r*cos(angle), CENTER.y + r*sin(angle))
```
k=0 → 중앙. k=1,2,… → 부채꼴로 고르게 확산(서로 다른 주제 분리). 난수 없음.

### 3-2. 카드 배치 (같은 태그 = 앵커 주변 클러스터)
- 새 개념의 태그 T:
  - T가 세션에 이미 있으면 → T의 앵커(첫 등장 순서 k로 산출).
  - T가 처음이면 → `k = 현재 distinct 태그 수` → 새 앵커.
- 카드 좌표 = **앵커에서 무겹침 나선 탐색**(`_first_free_position` 재사용)으로 가장 가까운 빈 자리.
  같은 태그 카드는 같은 앵커에서 스파이럴 → **앵커 주변에 조밀 클러스터**, 다른 태그는 다른 앵커 → 분리.
- 신규 함수: `place_by_tag(anchor, existing_rects, new_h) -> (x,y)` = 앵커 기준 `_first_free_position`.
- **제거**: `target_distance`, `place_new_card`(힘 이완·코사인 sim), `ExistingCard.sim`. 유지: AABB
  `_overlap`·`_first_free_position`(무겹침), `CANVAS_W/H`, `estimate_card_height`.

### 3-3. 스트리밍 · settle
- **스트리밍**: `@concept:` 감지 → 태그 추출 → `place_by_tag` → `place{is_final:false}`.
- **settle(done)**: 실제 본문 크기로 개념별 재배치(같은 태그 로직) → `place{is_final:true}`.
- 같은 답변 내 이미 배치한 개념도 existing_rects에 합류(무겹침).

## 4. 세션 상태 = 노드 attachments (canvas_cards 폐기)

- 배치에 필요한 "기존 카드의 (태그, x, y, h)"와 "태그 첫 등장 순서"를 **세션 노드들의
  `attachments.canvas.concepts[]`** 에서 재구성. `concepts[]` 항목에 **`tag` 추가**
  (현재 `{i,x,y,h}` → `{i,x,y,h,tag}`).
- 스트림 시작 시 세션 노드(생성순)를 1회 조회 → `[(tag,x,y,h), …]` + distinct 태그 순서.
- **제거**:
  - `retrieve._compute_near`(질의 임베딩 코사인) + `canvas_near_min_score`.
  - `qdrant_store.scroll_canvas_cards / upsert_canvas_card / search_canvas_cards` 사용(및 chat의
    `_scroll_session_cards`/`_save_canvas_cards` 벡터 임베딩·upsert). `COL_CANVAS_CARDS` 컬렉션은
    미사용으로 남긴다(마이그레이션 없음).
  - Part A(응답 passage 임베딩 위치 보정) 및 `_existing_for_vec`.
- **유지**: Upstage 임베딩은 **EBS/삽화/교과서/파일 검색 전용**(카드 위치엔 미사용). done 훅은
  `attachments.canvas`에 concepts(+tag) + ebs/art만 저장(임베딩·canvas_cards upsert 삭제).

## 5. 초기 로딩 위치 (태그는 답변 전 미지)

- 태그는 첫 `@concept:` 스트리밍에서 확정되므로 retrieve 시점엔 알 수 없다.
- `retrieve`의 `near`는 **비임베딩 폴백** — 빈 세션이면 중앙(CENTER), 아니면 기존 카드와 안 겹치는
  중앙 근처 빈 자리(`_first_free_position(CENTER, 기존rects)`). 로딩 카드를 즉시 표시.
- 첫 `place`(태그 앵커) 이벤트가 카드를 그 자리로 이동(기존 placeholder→place 이동 흐름 그대로).
- 자동 포커싱: `focusSignal`은 첫 `place`(is_final=false, concept_index 0) 좌표에도 재조정(프론트가
  이미 concept_index 0의 place로 placeholder를 이동시키므로, 그 좌표로 포커스 신호 갱신).
- `retrieve`는 **ebs/art 검색은 그대로**(질의 임베딩 유지) — near만 비임베딩 폴백으로 축소.

## 6. 무엇이 바뀌나 (파일)

- **`exaone.py`**: CONCEPT_CARD_SYSTEM_PROMPT 분류 규칙 강화(안정적 대분류·동일 표기 재사용).
- **`concept_blocks.py`**: `parse` 반환에 `cluster` 추가.
- **`canvas_layout.py`**: `tag_anchor(k)`·`place_by_tag` 신설; `target_distance`·`place_new_card`·sim 제거.
- **`chat.py`**: 스트리밍/ settle을 태그 배치로 교체; 세션 상태를 attachments에서 재구성; 벡터 임베딩·
  canvas_cards upsert 제거; done 훅은 concepts(+tag)+ebs/art만 저장.
- **`retrieve.py`**: `_compute_near`(임베딩) 제거 → near 비임베딩 폴백; ebs/art 검색 유지.
- **`config.py`**: `TAG_R0`(앵커 반경) 추가, `canvas_near_min_score` 제거, `retrieve_art_top_k`(=1 유지).
- **프론트 `useConceptStream.ts` / persisted 스키마**: `attachments.canvas.concepts[].tag` 파싱 허용
  (렌더는 좌표만 사용 — 무변경에 가까움). 미니맵은 좌표 기반이라 그대로 동작(태그 그룹핑은 비범위).

## 7. 데이터 흐름

질문 → `/retrieve`(ebs/art만 임베딩, near=중앙/빈자리 폴백) → 로딩 카드 → SSE 스트리밍 중
`@concept: 제목 | 분류` 감지 → 태그 앵커/클러스터 배치 → `place{is_final:false}` → 답변 완료 →
settle에서 실제 크기로 태그 재배치 → `place{is_final:true}` → done 훅이
`attachments.canvas.concepts[{i,x,y,h,tag}]`(+ebs/art) 저장. 재수화는 저장 좌표를 그대로 렌더.

## 8. 에러 처리

| 상황 | 동작 |
|---|---|
| 분류 빈 문자열 | `"기타"` 폴백 태그로 배치 |
| attachments 조회 실패 | 빈 세션 취급(중앙 앵커부터) |
| settle 실패 | 스트리밍 좌표로 폴백 저장(기존 self-격리: warning만, error SSE 금지) |
| retrieve degraded | near=중앙, ebs/art 없음(기존 규약) |
| 무겹침 포화 | `_first_free_position` 나선(캔버스 공간 있는 한 무겹침 보장) |

## 9. 테스트

### 9-1. 백엔드 유닛
- `tag_anchor(k)`: 결정론(같은 k→같은 좌표), k=0=중앙, 서로 다른 k가 충분히 분산(거리 하한).
- `place_by_tag`: 같은 앵커 다수 배치 시 앵커 주변 조밀·무겹침; 다른 앵커는 서로 멀리.
- `concept_blocks.parse`: `@concept: 제목 | 분류` → `cluster="분류"`; `|` 없으면 `cluster=""`.

### 9-2. E2E(Playwright)
1. 같은 분류를 유도하는 질문 3개(예 광합성 주제) → 카드들이 **한 앵커로 조밀 클러스터**.
2. 다른 분류 질문(예 지구계) → **다른 앵커로 멀리 분리**.
3. 카드끼리 무겹침 유지(가변 높이 포함).
4. 새로고침 → 저장 좌표로 동일 재현.

## 10. 비범위

- 미니맵 그룹핑을 임베딩→태그로 전환(좌표 기반 유지; 별도 작업).
- 태그 표기 정규화/동의어 병합(프롬프트 지시에 의존, 후처리 없음).
- `COL_CANVAS_CARDS` 컬렉션 물리 삭제/마이그레이션(미사용으로 방치).
- EBS/삽화/교과서/파일 검색의 임베딩(카드 위치와 무관 — 그대로 유지).
- Part B 단일 리프(유지 — 이번 변경과 독립).
