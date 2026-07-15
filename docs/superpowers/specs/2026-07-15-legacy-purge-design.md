# 레거시 테이블·컬럼 전면 삭제 설계 (D81)

- 날짜: 2026-07-15 / 작성: Manager
- 요구(사용자 결정): **확인된 레거시 테이블·컬럼을 전부 삭제한다. 기존 데이터
  손실 허용(개발 환경). 원격 DDL까지 적용한다.**
- 근거 조사: 2026-07-15 Manager 실측 — 원격 스키마 × 코드 사용처 전수 대조
  (원장 "사후 발견" 절). 모든 대상은 **생산자 0 또는 소비자 0**이 확인된 것만.

## 1. 삭제 인벤토리 (실측 근거 포함)

### DB — `supabase/migrations/0033_drop_legacy.sql` (Manager가 원격 적용)

| 대상 | 근거 |
|---|---|
| `tags`·`node_tags`·`file_tags` 테이블 + 관련 RPC/트리거(`upsert_node_tags`·`upsert_file_tags`·`get_file_tags`·usage_count 유지 함수 등 — 0005/0014/0016 정의 전수) | 생산자 0(채팅 태그 구설계 제거 + D80 파일 태깅 제거), file_tags 0행, UI 소비는 빈 배열 렌더뿐 |
| `delete_file_cascade` RPC **재정의** — 고아 태그 정리부(D29) 제거한 버전으로 교체(파일 행+청크 cascade는 유지) | node_tags/tags 소멸로 태그 정리부가 참조 오류가 됨 |
| `ai_sessions`·`ai_steps` 테이블 | 생산자 0(네비게이터 ReAct 제거), admin 뷰만 과거 데이터 표시 |
| `files.uploader_id` 컬럼 + `idx_files_uploader`(0025) | 전 행 owner_id와 동일, RLS 미사용, 프론트 미선언 |
| `files.session_id`·`position_x`·`position_y` 컬럼 | 데이터 0행, D58/D59에서 file_graph_nodes로 대체 완료 |
| `file_chunks.embedding` 컬럼 | 0028에서 Qdrant 이전, 벡터 0행·인덱스/RPC 기드랍 |
| `file_chunks.meta` 컬럼 | 쓰기 코드 0·채워진 행 0(page 표시는 작동한 적 없음) |
| `art_assets.embedding` 컬럼 — **단, 코드 grep으로 Supabase측 독자 0 확인 후** (검색은 Qdrant art_assets 컬렉션) | 0028 동일 패턴. 독자가 있으면 보류·보고 |
| `app_settings` 행 delete: `navigator_enabled`·`navigator_c`·`navigator_k`·`navigator_period`·`navigator_question_count`·`label_model`·`navigator_model` (존재하는 것만 — 멱등) | 네비게이터·라벨 생성 제거로 런타임 참조 0(실측) |

기존 0032(embedding_model·ocr_model·embedding_dimension·tag_model 행 정리)도
이번에 함께 원격 적용한다.

### 백엔드 (Task A)

- `routers/tags.py` 삭제 + `main.py` include 제거.
- `routers/files.py`: `GET /files/{id}/tags` 제거, `PATCH /files/{id}/position`
  제거, upload의 `session_id`/`position_x`/`position_y` Form 파라미터 제거.
  `GET /files/chunks/{id}/context`(D41)의 meta/page 파생 제거(구현 위치는
  grep `prev_text`로 특정) — 응답에서 `page` 필드 제거.
- `services/files.py`: `get_file_tags`·`set_file_position` 제거, `FILE_SELECT`
  에서 `uploader_id`·`session_id`·`position_x`·`position_y` 제거, upload_file의
  해당 파라미터·insert 키 제거.
- `services/sessions.py`: `NODE_SELECT_WITH_TAGS`·`_flatten_node_tags` 제거,
  노드 조회는 `NODE_SELECT`로 일원화(`tags` 배열 미반환).
- `routers/chat.py`: done 페이로드의 `"tags": []` 제거.
- `services/rag.py`: `meta` 읽기·`page` 파생 제거 — search select에서 meta 제거,
  `_source_label`의 page 인자 제거, `build_sources`에서 `page` 키 제거.
- `routers/admin.py`: `/traces` 엔드포인트·`_fetch_session_traces`·
  `/logs/{id}`의 ai_steps 부착·`/usage`의 ai_steps 집계 제거. `/usage`가
  ai_steps 전용이면 엔드포인트 자체 제거(프론트 소비 뷰도 Task B에서 제거).
- `config.py`: `node_label_max_chars`·`max_tags_per_node` 제거(참조 0 실측).
- 각 제거 전 잔존 참조 grep 확인, 제거 후 전체 스위트 GREEN.

### 프론트엔드 (Task B)

- `lib/api.ts`: `listTags`류·co-occurrence·`getFileTags`·`patchFilePosition`·
  admin traces/usage 함수 제거, `uploadFile` opts의 `sessionId`/`positionX`/
  `positionY` 제거, `ChunkContext.page` 제거.
- `lib/queries.ts`: fileTags 쿼리 2개·`tagsKey` 등 태그 쿼리 제거.
- `lib/types.ts`: `TagRow`·`CooccurrenceRow` 제거, `NodeRow.tags`·
  `ChatDoneEvent.node.tags` 제거, `FileRow.session_id/position_x/position_y`
  제거, `RagSource.page` 제거.
- `components/teacher/ReadOnlyThread.tsx`: 태그 칩 렌더 블록 제거(항상 빈 배열).
- `components/canvas/ConceptCard.tsx`: `sourceChips`의 page 접미사(`· p.N`) 제거.
- `components/admin/LogsTab.tsx`: ReAct traces·usage 뷰 부분 제거(터닝 로그
  뷰는 유지).
- `components/admin/SettingsTab.tsx`: 죽은 엔트리 7개 제거 — `label_model`
  (~55)·`navigator_model`(~64)·`navigator_enabled`(~187)·
  `navigator_question_count`(~195)·`navigator_k`(~206)·`navigator_c`(~217)·
  `navigator_period`(~228). "네비게이터" 그룹이 비면 GROUP_ORDER에서도 제거.
- 각 제거 전 잔존 참조 grep, `npx tsc --noEmit` exit 0.

## 2. 유지 (범위 밖 — 건드리지 않는다)

- ~~`nodes`의 navigator 컬럼 3종~~ → **삭제로 결정 변경** (2026-07-15 사용자
  지적 + 실측: navigator 노드 0행·navigator_question 전부 null·navigator_meta
  기본값 {}뿐 — "활성 소비자"는 과거 데이터 방어 필터일 뿐, 데이터 손실 허용
  환경에서 전제 소멸). §5 Task C로 2차 웨이브 수행.
- `nodes`의 `label`·`connections`·`reference_sources` — 활성(기억 연결·비교
  참조 칩).
- `file_graph_nodes`(D58 배치), `turn_logs`(D25 관측성), `jobs` — 활성.
- `files.updated_at`·`mime` — 활성/표준.
- pgvector extension 자체 — 드랍하지 않음(안전).

## 3. 적용 순서 (필수 — 어기면 라이브 장애)

1. Task A/B 코드가 dev에 회수된 **후에만** Manager가 0032·0033을 원격 적용한다
   — 현행 코드가 삭제 대상 컬럼(FILE_SELECT의 uploader_id 등)을 SELECT 중이라
   역순이면 실행 중인 서버가 즉시 깨진다. (적용 전까지 신규 코드는 삭제된
   컬럼을 참조하지 않으므로 DDL 미적용 상태에서도 동작.)
2. 적용 후 전체 스위트 + 스모크 재확인.

## 5. Task C — navigator 컬럼 퍼지 (2차 웨이브, Task A/B 회수 후 순차)

Task A/B와 파일이 겹쳐(chat.py·sessions.py·rag.py·types.ts·useConceptStream 등)
**회수 후 별도 에이전트**로 수행한다.

- DB — `supabase/migrations/0034_drop_navigator.sql`(파일만, Manager 적용):
  `alter table public.nodes drop column if exists is_navigator, drop column if
  exists navigator_question, drop column if exists navigator_meta;`
  (navigator 행 0 실측 — delete 불요.)
- 백엔드: `sessions.py` NODE_SELECT에서 3컬럼 제거·append_node의 관련 키 제거,
  `chat.py`/`memory.py`/`rag.py`의 `is_navigator` 필터 제거(체인은 이제 전부
  실노드), `nodes.py`의 navigator 참조 제거(grep으로 특정).
- 프론트: `types.ts` NodeRow 3필드·NavigatorMeta 제거, `useConceptStream.ts`
  `reals` 필터 제거, `api.ts`·기타 navigator 참조 grep 전수 제거.
- 검증: 전체 스위트 GREEN + grep 0건 + tsc/build PASS. 원격 적용은 0032·0033과
  함께 코드 회수 후 일괄.

## 4. 검증 기준

- 백엔드 전체 스위트 GREEN + 제거 심볼 잔존 참조 grep 0건(마이그레이션 SQL·
  docs 역사 기록 제외). 프론트 tsc/build PASS.
- 원격 적용 후: 자료실 목록/업로드/삭제, 학생 세션 열람(ReadOnlyThread),
  채팅 턴+출처 칩, admin 로그 목록이 오류 없이 동작(스모크 — 리뷰어 확인).
