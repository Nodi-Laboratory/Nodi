# 백엔드 카드 위치 로직 완전 제거 설계

날짜: 2026-07-14
상태: 사용자 승인 완료 (스펙 작성 → 구현 계획 전)
선행:
- 2026-07-13-frontend-tag-force-layout-design.md (프론트 d3-force가 위치 소유)
- 2026-07-13-fixed-curriculum-tags-design.md (고정 태그 앵커)

## 1. 배경과 목표

프론트가 d3-force 태그 클러스터로 카드 위치를, sim 위치로 카메라 포커스를 소유한다. 서버가 여전히
계산·전송하는 `place` SSE 좌표·`near`·태그 배치·좌표 저장은 **프론트가 전부 무시**하는 사문화 코드다.

**목표: 백엔드의 카드 위치 계산·전송·저장을 완전히 제거**한다(승인: 완전 제거). 서버는 토큰 스트림과
EBS/삽화 검색·저장만 담당하고, 카드 생성·태그·위치·포커스는 프론트가 소유한다.

**작업 순서(각 단계 동작 유지)**: 먼저 프론트가 서버 place/near에 의존하지 않게 하고(서버는 아직 보내되
프론트가 무시), 다음 백엔드에서 그 로직을 삭제한다.

## 2. 프론트 (place/near 의존 제거) — Task 1

- **`useConceptStream.ts`**:
  - `onPlace`/`PlaceEvent`·`pendingCoordsRef` 제거. cstart 좌표 주입을 **중앙 상수**(CENTER=(1600,1100))로
    고정(sim이 태그 앵커로 배치, 이 값은 잠깐의 폴백일 뿐).
  - `r.near`·`nearXY`의 near 의존 제거 → 플레이스홀더/리프 앵커 기준을 중앙 상수로. `focusSignal`은 중앙
    좌표 + 첫 개념 id(추종은 sim, 직전 커밋 유지).
  - `streamChat` 바디의 `place_hint` 제거.
  - 재수화 `coordMap`(attachments.concepts 좌표) 제거 — 개념은 답변 재파싱(replayNodes)에서, 위치는 sim.
    (attachments.ebs/art 리프 재수화는 유지.)
- **`api.ts`**: `RetrieveResult.near`·`ChatStreamBody.place_hint`·`PlaceEvent` 타입·`streamChat`의 `onPlace`
  콜백 제거. (retrieve의 ebs/art·degraded는 유지.)
- 카드/태그 생성은 프론트 파서(cstart, `@concept: 제목 | 분류`)가 이미 담당 → 서버 place 불필요.

## 3. 백엔드 (계산·전송·저장 제거) — Task 2

- **`chat.py`**: `_next_place_event`·`_tag_state_from_nodes`·`_place_tagged`·`placed_coords/heights/tags`
  삭제. 스트리밍 `@concept` 감지→`_sse("place", …)` 삭제. settle의 태그 배치 루프 + `place{is_final}` 삭제.
  `concept_blocks`·`canvas_layout` import 및 `svc.get_session_nodes`(태그상태용) 호출 제거. done 훅은
  `_patch_canvas_unified`로 **ebs/art만** 저장(concepts 좌표 제거).
- **`retrieve.py`**: 응답에서 `near` 제거(ebs/art·degraded만). `canvas_layout`(CANVAS_W/H) import 제거.
- **`canvas_layout.py`**: **파일 삭제**(외부 importer는 chat/retrieve뿐, 둘 다 제거).
- **`config.py`**: 위치 상수 `tag_r0`·`force_*`·`card_*` 제거(ebs/art·textbook 등은 유지).
- **`concept_blocks.py`**: chat 미사용화 → 모듈·`test_concept_blocks_cluster.py` 삭제(사문화).
- **테스트**: `test_tag_placement.py`·`test_chat_place.py`의 place/settle 관련·`test_retrieve_near.py`(있으면)
  삭제/갱신. 나머지 스위트는 그대로 통과.

## 4. `_patch_canvas_unified` 단순화

- 시그니처를 `(client, node_id, retrieved)` 로 축소(concepts_meta 인자 제거). 본문은 `attachments.canvas`에
  `ebs`/`art`만 기록(concepts 키 제거). done 훅 호출부도 이에 맞춤. retrieved가 없으면 저장 생략.

## 5. 데이터 흐름

질문 → `/retrieve`(ebs/art 검색) → `/chat` 토큰 스트림 → 프론트 파서가 카드+태그 생성 → d3-force 위치 +
카메라 sim 추종 → done 시 노드 저장 + ebs/art attachments 저장. 재수화: 저장 답변 재파싱 → 카드+태그 →
sim 위치, ebs/art로 단일 리프 복원.

## 6. 에러 처리

| 상황 | 동작 |
|---|---|
| retrieve 실패/degraded | ebs/art 없음. 카드는 스트림으로 정상 생성 |
| done 훅 저장 실패 | logger.warning만(기존 self-격리) |
| 서버 place/near 부재 | 프론트가 중앙 폴백+sim으로 정상(의존 없음) |
| 개념 0/빈 답변 | 저장·카드 없음(기존) |

## 7. 테스트

### 7-1. 백엔드 pytest
- place/settle/near/positioning 제거 후 import 에러 없음, 전 스위트 통과.
- done 훅이 ebs/art만 attachments에 저장(concepts 키 없음) 단위 검증.

### 7-2. E2E(Playwright)
- **Task 1 후**(백엔드 미변경): 카드 생성·태그 클러스터·카메라 추종·단일 리프·재수화 정상(프론트가 place 무시).
- **Task 2 후**: 서버 SSE에 `place` 이벤트 없음, retrieve 응답에 `near` 없음. 위 동작 전부 여전히 정상.

## 8. 비범위

- EBS/삽화(SVG·영상) 검색·저장·단일 대표·카드 추종 — 유지.
- 프론트 d3-force/태그 앵커/카메라 추종 — 유지(이번엔 서버 배선만 제거).
- 임베딩(ebs/art/textbook/파일 검색) — 유지.
- Qdrant canvas_cards 컬렉션 정의(이미 미사용) — 방치.
