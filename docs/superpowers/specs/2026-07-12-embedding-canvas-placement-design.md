# 임베딩 유사도 캔버스 배치 — 서버 권위 좌표 설계

날짜: 2026-07-12
상태: 사용자 승인 완료 (구현 전)

## 1. 배경과 목표

현재 개념 카드 배치는 프론트엔드가 결정한다: 첫 카드는 `/retrieve`의 질의 임베딩을
브라우저에서 기존 카드 임베딩과 코사인 비교(near.ts)해 곁에 두고, 이후 개념은
문자열 유사도(mostSimilar)·클러스터명 FNV-1a 해시 앵커로 배치한다. 카드 임베딩은
`/art/search` 응답에서 얻어 브라우저 메모리에만 존재한다.

**목표:**

1. 의미상 유사한 질문·개념 카드가 캔버스에서 자연스럽게 군집하도록, 질의·응답을
   임베딩해 벡터 DB(Qdrant)에 저장하고 코사인 유사도로 배치한다.
2. **좌표 결정 권위를 서버로 이전**한다 — 프론트는 좌표를 받아 렌더링만 한다.
3. 카드가 생성될 위치에 **로딩 애니메이션**을 항상 표시한다 (실패 경로 포함).

**결정된 선택지:** 방향 A(임베딩 유사도 맵) / 캔버스는 **세션 스코프 유지**
(유저 통합 맵 아님) / 서버측 kNN + 서버 좌표 계산 (방식 1 + 좌표까지 서버).

## 2. 아키텍처 개요

```
질문 입력
  → POST /retrieve {question, session_id}
      서버: Upstage embedding-query → Qdrant canvas_cards(세션 필터) kNN top-1
            → 앵커 셀 + 세션 점유칸 회피 → 빈 셀 좌표 계산
      응답: near {x, y, score} (유사 카드 없어도 폴백 좌표를 항상 반환)
  → 프론트: 그 좌표에 로딩 카드(스켈레톤 + 점 3개 바운스) 표시
  → POST /chat/stream {..., place_hint: {x, y}}
      서버: 토큰 중계 중 라인 버퍼에서 "@concept:" 감지
            1번째 개념 → place_hint 셀
            k번째(k≥2) 개념 → 1번째 곁 빈 셀 계산
            → SSE `place` 이벤트 {concept_index, x, y} 즉시 전송
      프론트: place 좌표에 카드 생성(로딩 카드는 1번째 개념으로 전환)
  → done: 서버가 개념별 (제목+본문) embedding-passage 배치 임베딩
          → canvas_cards upsert (좌표 포함)
          → nodes.attachments.canvas.concepts[]에 좌표 기록 (fire-and-forget)
새로고침 → 저장된 좌표를 그대로 렌더링 (재계산 없음)
```

## 3. 데이터 모델

### Qdrant 컬렉션 `canvas_cards` (신규)

- 벡터: 4096d Cosine (기존 컬렉션과 동일 규격, `upstage.EMBED_DIM`)
- 포인트 id: `uuid5(NAMESPACE_URL, "card:{node_id}:{concept_index}")` — 멱등 upsert
- payload: `{owner_id, session_id, node_id, concept_index, title, x, y}`
- 페이로드 인덱스: `session_id` (KEYWORD). Qdrant에는 RLS가 없으므로 모든 검색·scroll에
  `owner_id + session_id` 필터를 백엔드가 강제한다 (qdrant_store 기존 규약).
- `ensure_collections()`에 추가 (부팅 안전 — 실패해도 기동).

### nodes.attachments.canvas (확장)

- 기존: `{ebs[], art[]}` → 추가: `concepts: [{i: number, x: number, y: number}]`
- 리플레이(재수화)의 좌표 원본. `position_x/y`(노드당 1개)는 유지하되 첫 개념 좌표와
  동일 값 (기존 소비처 호환).

## 4. 백엔드 변경

### 4-1. 그리드 배치 모듈 (신규, `services/canvas_layout.py`)

- 프론트 `layout.ts`의 결정론 로직 포팅: 셀 그리드(FX=460, FY=840, MARGIN=40,
  CANVAS 2600×1600), `cell_to_xy`/`xy_to_cell`/`nearest_free_cell`/`place`.
- 점유칸은 호출부가 `canvas_cards` scroll(세션 필터, 벡터 제외)로 구성.
- 클러스터 해시 앵커는 포팅하지 않는다(배치 규칙에서 제거됨). 기본 앵커: 캔버스가
  비면 (40,40), 아니면 "세션의 마지막 카드" 곁.

### 4-2. `/retrieve` 확장 (routers/retrieve.py)

- body: `question` + **`session_id`(신규, 필수)**.
- 기존 ebs/art 검색과 병렬로 `canvas_cards` kNN top-1 (owner+session 필터).
- 좌표 계산: score ≥ 임계(신규 설정 `canvas_near_min_score`, 기본 0.5)면 그 카드
  좌표를 앵커로, 아니면 폴백 앵커로 → 빈 셀 좌표.
- 응답에 `near: {x, y, score|null}` 추가 — **degraded여도 near는 폴백 좌표로 항상
  채운다** (로딩 카드 상시 표시 요구). `embedding` 필드는 응답에서 제거(프론트가
  더 이상 사용 안 함).

### 4-3. `/chat/stream` (routers/chat.py)

- body에 `place_hint: {x, y} | null` 추가 (프론트가 retrieve의 near를 릴레이).
- 스트리밍 루프에서 답변 누적 버퍼를 라인 단위로 스캔해 `@concept:` 발생 시:
  - index 0: `place_hint` 셀(없으면 서버 폴백 계산)
  - index k≥1: index 0 곁 빈 셀(요청 스코프 점유 상태 + 세션 scroll 합집합)
  - `yield _sse("place", {concept_index, x, y})` — token 이벤트 흐름에 즉시 삽입.
- done(노드 저장 성공) 후 fire-and-forget 태스크:
  1. 답변에서 `@concept` 블록 정규식 분리 → 개념별 "제목\n본문 줄들" 텍스트
  2. `embedding-passage` 배치 1회 호출
  3. `canvas_cards` upsert (좌표 포함) + `nodes.attachments.canvas.concepts` PATCH
  - 실패는 로그만 — 스트림·답변 저장에 영향 없음.

### 4-4. 정리(cleanup)

- 노드 삭제 시 `node_id` 필터로 canvas_cards 포인트 삭제 (best-effort).
- 세션 삭제 시 `session_id` 필터 삭제 (best-effort).

## 5. 프론트엔드 변경

### 5-1. 로딩 카드 (요구사항: 생성 위치 로딩 애니메이션)

- `ConceptCard`에 `pending` 분기: 카드 골격 + 제목 자리 shimmer 스켈레톤 +
  기존 `.nodi-ldot` 점 3개 바운스 + pulsing 테두리.
- retrieve의 `near.{x,y}`에 즉시 표시. retrieve가 완전히 실패해도 프론트 로컬
  폴백 좌표(마지막 카드 곁/기본 앵커)로 **항상 표시**.
- 첫 `place`(concept_index 0) 수신 시 같은 id로 실카드 전환 (DOM 재사용 →
  left/top 트랜지션).

### 5-2. 배치 로직 제거·수신 전환

- `useConceptStream`: `place` 이벤트 핸들러 추가 — concept_index별 좌표를 그대로
  적용. `reduceConcept`의 cstart 배치 계산 제거(좌표는 place가 준다).
- 제거: `near.ts`(nearestConceptByEmbedding), `mostSimilar` 배치 경로,
  `similarity.ts`의 배치 사용처, layout.ts의 `placeConcepts` 호출(리프 배치 제외
  — 아래), 클러스터 해시 앵커.
- 유지: `buildGroups`(개념 트리 그룹핑, /art/search 임베딩 기반), EBS/아트 리프
  스폰(당분간 프론트 배치 유지 — 개념 카드 좌표 곁 빈 셀; 서버 이전은 비범위).

### 5-3. 리플레이(재수화)

- `attachments.canvas.concepts[]` 좌표를 그대로 적용. 파서 리플레이는 카드 "내용"
  복원용으로만 사용, 좌표 재계산 로직 삭제.
- `patchNodeCanvas`의 좌표 저장 역할 폐기 (ebs/art 첨부 저장은 유지).

## 6. 기존 데이터

- **백필 없음.** 사용자 결정: 이전 노드는 전부 삭제 가능 (개발 단계).
- 구현 시 `sessions`/`nodes` 전체 삭제(신규 스코프 데이터 리셋)를 안내하는 SQL 또는
  스크립트 1개 제공. 리플레이 하위호환(구 노드에 concepts 좌표 없음) 코드는 두지
  않는다.

## 7. 에러 처리

| 상황 | 동작 |
|---|---|
| Qdrant/Upstage 다운 (retrieve) | degraded=true + near는 폴백 좌표 → 로딩 카드·배치 정상 동작 (군집만 비활성) |
| place 이벤트 유실/스트림 오류 | 기존 규약 유지: done 미수신 시 로딩 카드 회수, 오류 reply 표시 |
| done 훅(임베딩/upsert) 실패 | 로그만. 다음 질문의 kNN 후보에서 해당 카드만 누락 |
| place_hint 누락 | 서버가 폴백 앵커로 자체 계산 |

## 8. 테스트 계획

- 백엔드 유닛: `@concept` 블록 파서, `canvas_layout`(셀 계산·점유 회피 결정론),
  retrieve near 폴백 규칙.
- 백엔드 통합: retrieve(session 필터 kNN) — 테스트 유저 + 실제 Qdrant.
- E2E(Playwright, 기존 하네스 재사용):
  1. 질문 1 → 로딩 카드 표시 → 카드 A 정착
  2. 유사 질문 2 → 로딩 카드가 **A 곁**에 표시 → 새 카드 A 곁 정착
  3. 무관 질문 3 → A 군집과 다른 위치
  4. Qdrant 중단 상태에서도 로딩 카드 표시 + 폴백 배치
  5. 새로고침 → 좌표 동일 재현

## 9. 비범위 (Out of scope)

- 유저 통합 맵(전 세션 누적 캔버스), 교육과정 태그 분류(방향 B), EBS/아트 리프
  배치의 서버 이전, 과거 데이터 백필, 개념 트리 그룹핑 방식 변경.
