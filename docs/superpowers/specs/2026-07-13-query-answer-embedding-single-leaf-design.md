# 질의→응답 임베딩 위치 보정 · 맵당 리프 1개 대표 설계

날짜: 2026-07-13
상태: 사용자 승인 완료 (스펙 작성 → 구현 계획 전)
선행:
- 2026-07-12-force-cluster-placement-design.md (힘 클러스터 배치, canvas_cards 벡터)
- 2026-07-13 리비전 (리프 무겹침·주제 분리 간격)

## 1. 배경과 목표

두 개의 독립적인 개선을 한 스펙에 담는다(구현·테스트는 분리 가능).

**Part A — 카드 위치 임베딩 정합성.** 현재 새 카드의 위치는 `embed_query(질문)`(질의 임베딩)으로만
정해진다(스트리밍·settle 모두). 그런데 카드가 **저장·비교하는 벡터는 `embed_passages(응답 본문)`**
(응답 passage 임베딩)이다. 즉 "이 질문이 기존 **답변**과 얼마나 관련 있나"(비대칭 query↔passage)로
배치하는데, 목표는 "**같은 개념끼리 뭉치게**"(대칭 개념↔개념)이다. → **초기엔 질의 임베딩으로 즉시
임시 배치, done 시 응답 passage 임베딩으로 최종 위치를 보정**한다.

**Part B — 맵당 추천 리프 1개.** 현재 EBS 영상·삽화(SVG) 리프가 **답변마다** 스폰돼 세션에 누적된다.
→ **맵(세션) 전체에 영상 1개 + 삽화 1개만** 두고, **최고 유사도 스코어**를 내는 후보를 맵 대표로 삼아
더 관련 높은 후보가 나오면 교체한다.

## 2. Part A — 질의(초기) → 응답(보정) 위치

### 2-1. 현재 흐름 (확인)
- `chat.py`: `qvec = embed_query(question)`.
- **스트리밍**: 개념 도착마다 `_place_for_new_concept`가 `_session_cards_as_existing(session_cards, qvec)`
  (각 기존 카드 sim = `cosine(qvec, 기존카드_passage벡터)`)로 임시 배치 → `place{is_final:false}`.
- **settle(done)**: 같은 `qvec` 기반 `existing_final`로 `place_new_card` 재배치, 답변 내 이미 배치된
  개념은 **고정 sim=0.9**로 append → `place{is_final:true}`.
- **저장**: `_save_canvas_cards`가 응답을 다시 파싱·`embed_passages`해서 passage 벡터로 upsert.

### 2-2. 변경 (Part A)
- **스트리밍은 그대로** 질의 임베딩(`qvec`)으로 임시 배치 — 답변 미완성이라 필연적. "초기 위치".
- **settle을 응답 passage 임베딩으로 보정**:
  1. settle 시작 시 답변을 파싱하고 **개념별 passage 벡터 `pvec[i]`를 1배치로 임베딩**
     (`upstage.embed_passages`) — 지금 `_save_canvas_cards`에서 하던 임베딩을 **settle로 앞당겨** 재사용.
  2. 개념 i를 배치할 때 그 개념의 `pvec[i]`로 유사도를 계산한다:
     - 기존 세션 카드 각각: `sim = cosine(pvec[i], 기존카드_passage벡터)`.
     - 같은 답변에서 **이미 배치된 개념 j(<i)**: 고정 0.9 대신 `sim = cosine(pvec[i], pvec[j])`(대칭).
     - 이 sims로 `place_new_card(h_i, existing_i, seed)` → `place{is_final:true}`.
  3. 저장: settle에서 만든 `pvec[i]`·좌표·크기를 `_save_canvas_cards`에 넘겨 **재임베딩 없이** upsert.
- **효과**: 최종 클러스터가 개념↔개념(passage↔passage) 대칭 유사도로 정해져 저장 벡터와 일관.
  질문 표현이 달라도 같은 개념이면 같은 자리에 안착. UX상 "질의 위치 → 응답 보정 위치" 이동(현재도
  settle에서 카드가 이동하므로 새로운 동작은 아님).
- **비용**: 추가 임베딩 호출 없음 — 저장용으로 이미 계산하던 passage 임베딩을 settle 위치 계산에
  재사용(임베딩 위치만 이동).

### 2-3. 순수 헬퍼 (테스트 대상)
`chat.py`에 순수 함수 추가(임베딩·DB 무관, 벡터 주입 테스트 가능):
```
_existing_for_vec(
    session_cards: list[dict],          # scroll 결과({payload{x,y,size_h}, vector})
    placed: list[tuple[x,y,h,pvec]],    # 이 답변에서 이미 배치된 개념
    vec: list[float],                   # 배치할 개념의 passage 벡터
) -> list[ExistingCard]                 # sim = cosine(vec, 각 카드 passage벡터)
```
`_session_cards_as_existing(session_cards, qvec)`는 스트리밍용으로 유지(질의 임베딩). settle은
`_existing_for_vec`를 개념별로 호출한다.

### 2-4. 경계 케이스
- **passage 임베딩 실패**: settle 위치 보정 스킵 → 스트리밍 좌표(`placed_coords`, qvec 기반)로 폴백
  저장(기존 self-격리 규약 유지). error SSE 방출 금지.
- **좌표/벡터 없는 기존 카드**: sim=0.0 취급(기존 `_session_cards_as_existing` 폴백과 동일).
- **개념 0개/빈 답변**: 저장·settle 없음(기존과 동일).

## 3. Part B — 맵당 추천 리프 1개(영상·삽화 각 1)

### 3-1. 선택 규칙 = 최고 스코어 대표
- 세션(맵) 전체에서 **가장 높은 유사도 스코어**의 EBS 영상 1개 + 삽화 1개만 표시.
- 스코어는 `retrieve`가 이미 반환·저장한다 — 각 노드 `attachments.canvas.ebs[].score`/`art[].score`.
- **라이브 갱신**: 새 질문의 후보 스코어 **>** 현재 대표 스코어면 그 1개를 교체(새 앵커 개념 곁으로 이동
  + 내용 교체). 낮거나 후보 없으면(임계 미달) 유지. 대표가 아직 없고 후보가 있으면 생성.
- **재수화**: 모든 노드의 저장 후보 중 **argmax(score)** 로 영상 1·삽화 1 결정(결정론, 동점은 첫 노드).

### 3-2. 앵커 위치
- 대표 리프는 그 후보를 만든 질문의 **첫 개념 카드 곁**에 배치(기존 무겹침 `placeLeafClear` 재사용).
- 교체 시 새 앵커로 이동(리프 id는 고정 — 예 `map-video`/`map-art` — 부드러운 이동/교체 애니메이션).

### 3-3. 변경점
- **백엔드**: `config.py` `retrieve_art_top_k: 2 → 1`(질문당 삽화 후보 1). EBS는 이미 1. 저장 구조 불변
  (각 노드가 자기 후보+스코어를 계속 저장 — 재수화 argmax의 입력).
- **프론트 `useConceptStream.ts`**: 답변마다 리프를 스폰하던 로직(라이브 배치·재수화 재생성)을 **단일
  대표 갱신**으로 교체. `leafNodes`는 최대 영상 1 + 삽화 1을 유지.
  - 라이브: retrieve 결과의 후보 스코어를 현재 대표와 비교해 교체/유지.
  - 재수화: 전 노드 후보 스캔 → argmax 스코어로 영상 1·삽화 1.
  - 배치: 대표 리프를 앵커 개념 곁에 `placeLeafClear`로(카드·상대 리프 무겹침).

### 3-4. 경계 케이스
- 후보 없음(전 질문 임계 미달) → 리프 없음.
- 스코어 없는 구 노드(구버전 저장) → argmax 대상에서 제외.
- retrieve degraded → 대표 미변경(기존 유지).

## 4. 무엇이 바뀌나 (파일)

- **백엔드 `chat.py`**: settle에서 passage 임베딩 선계산 + `_existing_for_vec`로 개념별 위치 보정 +
  그 벡터를 `_save_canvas_cards`에 전달(재임베딩 제거). 신규 순수 헬퍼 `_existing_for_vec`.
- **백엔드 `config.py`**: `retrieve_art_top_k` 2 → 1.
- **프론트 `useConceptStream.ts`**: 리프 스폰 → 단일 대표(영상 1·삽화 1) 갱신·재수화 argmax.
- (테스트) **백엔드 `tests/`**: `_existing_for_vec` 순수 유닛.

## 5. 데이터 흐름

**Part A:** 질문 → `embed_query` near(즉시, 질의) → 스트리밍 임시 배치(질의) → done →
`embed_passages`(개념별) → 그 벡터로 settle 재배치(응답 보정) → 같은 벡터로 canvas_cards 저장.

**Part B:** retrieve 후보(영상/삽화 + score) → 프론트가 세션 대표와 스코어 비교 → 교체/유지 →
앵커 개념 곁 무겹침 배치. 재수화는 전 노드 argmax(score).

## 6. 에러 처리

| 상황 | 동작 |
|---|---|
| settle passage 임베딩 실패 | 위치 보정 스킵 → 스트리밍(질의) 좌표로 폴백 저장, error 없음 |
| 좌표/벡터 없는 기존 카드 | sim=0.0 |
| retrieve degraded/후보 없음 | 대표 리프 미변경 |
| 스코어 없는 구 노드 | Part B argmax에서 제외 |
| 빈 답변/개념 0 | 저장·settle·리프 없음 |

## 7. 테스트

### 7-1. 백엔드 유닛(`_existing_for_vec`)
- 주입한 벡터로 sim = cosine 정확: 동일 벡터 sim≈1, 직교 sim≈0.
- placed(같은 답변 개념) 포함, 좌표·크기 매핑, 벡터 없는 카드 sim=0.0.
- 결정론(같은 입력 → 같은 ExistingCard 목록).

### 7-2. E2E(Playwright)
- **Part A**: 같은 개념을 다르게 물은 두 질문(예 "광합성이 뭐야?" / "식물이 빛으로 양분 만드는 원리는?")
  → 두 카드가 서로 가깝게 안착(질의만 쓰던 때보다 근접). done 시 카드가 초기→보정 위치로 이동.
- **Part B**: 다주제 질문 N개 → 맵에 영상 노드 **정확히 1개** + 삽화 노드 **정확히 1개**. 더 높은
  스코어 후보가 나오는 질문 후 대표가 그쪽으로 교체(앵커 이동). 새로고침 후에도 영상 1·삽화 1(argmax 동일).

## 8. 비범위

- 대표 선택을 스코어가 아닌 "맵 무게중심/최대 클러스터" 기반으로 하는 고급 정책(스코어 argmax만).
- 리프를 여러 개 보여주는 옵션·토글(맵당 1개 고정).
- 스트리밍 단계의 응답-임베딩 보정(응답 미완성 — settle에서만 보정).
- 서버 저장 스키마 변경(기존 attachments.canvas 그대로; Part B는 프론트 선택).
- retrieve near 자체를 응답 기반으로 바꾸기(near는 답변 전이라 필연적으로 질의 기반).
