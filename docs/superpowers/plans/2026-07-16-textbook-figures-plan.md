# 교과서 figure 파이프라인 통합 (labs → Nodi)

## Context

labs(`~/Desktop/ai-rookie/labs`)에서 검증한 교과서 figure 파이프라인을 Nodi 제품에 통합한다.
교사가 **"교과서" 업로드 버튼(신규, 기존 "수업자료" 버튼과 분리)**으로 PDF를 올리면:
텍스트는 기존 RAG 인제스트를 그대로 타고(**사용자 확정**), 추가로 figure를 추출·판정·임베딩해
학생 질의와 코사인 유사한 figure를 캔버스에 리프 노드로 띄운다. 수업자료(class_material)
경로는 동작 불변. 캡션 판정은 **비전 방식(labs judge.py 그대로, 사용자 확정)** — 크롭 이미지
+ 후보를 플러그형 엔드포인트(기본 TTA 프록시 EXAONE-4.5-33B)로 전송.

labs 검증 완료 로직: Document Parse `enhanced`(figure별 영어 설명 자동 생성) + `coordinates`
+ `base64_encoding=["figure"]` → 위치기반 캡션 후보 top-3(수평겹침·수직거리 규칙) → 비전 판정
`{selected_index, reason}` → `embed_text = 선택캡션 + 영어설명 + heading` → `embedding-passage`
4096d → Qdrant. **이미지는 벡터화하지 않고 텍스트 프록시를 임베딩**한다.

## 신규 설계 결정 (D-번호, 현재 D85까지 사용)

- **D86 — textbook kind + 파싱 1회 공유 + figure_batch 잡**: 교과서는 `kind='textbook'`
  (PDF 전용). split에서 Document Parse를 **enhanced 1회만** 호출해 텍스트 청킹(markdown)과
  figure 추출(elements)을 한 응답에서 얻는다(enhanced는 페이지당 과금 — 2회 호출은 항상 더
  비쌈). figure는 `figure_batch` 잡(embedding_batch 동형 팬아웃, 배치 8)으로 처리.
- **D87 — figure 이미지는 백엔드 signed URL로 서빙, URL은 영속 금지**: 크롭은 private 버킷
  `files`의 owner-prefix 경로에 저장. USER 스코프 RLS 재조회를 통과한 요청에만 service-role이
  시한부 URL 서명. `attachments.canvas.figures`에는 figure_id만 저장(만료 URL 화석화 방지),
  재수화·onError 시 `GET /files/figures/{id}`로 재발급.
- **D88 — figure 실패 격리 + 판정 강등**: `files.status`는 텍스트 파이프라인 전용으로 불변.
  figure 진행·실패는 `textbook_figures.status` 행 단위로만 추적. 판정 실패/미설정/다운 시
  `selected_index=-1` 강등(위치기반 캡션 유지 — labs 회귀방지 규칙)하고 figure는 반드시
  임베딩까지 진행. 배치 내 연속 5회 판정 실패 시 잔여 판정 생략(회로차단).

## 1. DB 마이그레이션 `supabase/migrations/0038_textbook_figures.sql` (신규, 멱등)

1. `files.kind` check에 `'textbook'` 추가 (제약 drop/재생성 — 실명은 적용 전 확인).
2. `jobs.kind` check에 `'figure_batch'` 추가.
3. `textbook_figures` 테이블: `id uuid pk, file_id fk(files, cascade), seq int, page int,
   element_id int, bbox jsonb, caption, alt, description, figure_type, heading,
   candidates jsonb, selected_index int, judge_reason, match_kind, embed_text,
   image_path text not null, status check('pending','embedded','failed'), created_at,
   unique(file_id, seq)` + `(file_id, seq)` 인덱스.
4. RLS(0024 initplan 패턴 `(select auth.uid())` 준수): select만 — 소유자 or
   (`f.kind='textbook'` and `is_class_member(f.space_ref)`). 쓰기 정책 없음(service_role 전용).
5. 0012 교차읽기 정책 확장: `files_select_class`·`file_chunks_select_class`의
   `kind='class_material'` → `kind in ('class_material','textbook')`.
6. **0013 insert 가드 확장(보안 필수)**: `kind not in ('class_material','textbook') or
   is_class_teacher(space_ref)` — 갱신 없으면 학생이 PostgREST로 textbook 행 직접 삽입 가능.
7. `get_chunk_context` RPC(0020)의 kind 리터럴 동일 확장(교과서 청크 "⋯" 패널 접근).
8. 튜너블 시드: `figure_pipeline_enabled`(true), `figure_retrieve_max_distance`(0.60),
   `figure_judge_concurrency`(4).

## 2. 업로드 경로 `backend/app/services/files.py` (라우터 무변경)

- kind 화이트리스트(files.py:133-137)에 `"textbook"` 추가.
- space 강제(:138-142)·교사 검증(:157-159): `kind in ("class_material","textbook")`.
- **교과서는 PDF 전용**: D75 검사 직후 `kind=="textbook" and ext!="pdf"` → 422 한국어 사유.
- `resolve_upload_max_bytes`(:71-83): textbook도 `class_material_max_bytes`(500MB) 공유.
- session_id 가드(:144-148)는 `kind != "user_upload"` 조건이라 무변경.
- `delete_file`: `_qdrant_delete_file_points`를 컬렉션 인자화해 `textbook_figures` 포인트도
  purge + 행 image_path 기반 크롭 Storage 삭제(best-effort). 행 자체는 FK cascade.

## 3. 파싱 `backend/app/services/upstage.py`

- `_parse_form(figures: bool = False)`: True면 `mode=enhanced`, `coordinates=true`,
  `output_formats=["markdown","html"]`, `base64_encoding=["figure"]`. False는 기존 그대로
  (class_material 경로 보존).
- `_pdf_segments` → 조각별 **시작 페이지(0-base)를 함께 반환**하도록 리팩터
  (기존 호출부·`test_pdf_split.py`는 그린 유지).
- 신규 `parse_document_full(data, filename) -> tuple[str, list[dict]]`: (markdown, 전역
  page/element_id 보정된 elements). PDF는 **조각당 ≤48MB 그리고 ≤100페이지로 사전 분할**해
  전 조각이 sync 경로만 탄다 — async(>100p) 경로의 페이지 번호 기준 불확실성을 원천 회피,
  오프셋을 결정론적으로 소유(D78 대응). 조각 elements에 `page += seg_start`,
  `id += 요소수 누적` 적용 후 병합.

## 4. figure 추출·판정 (신규 모듈 2개)

- `backend/app/services/figure_extract.py`: labs `extract.py` 순수 함수 1:1 이식(bbox,
  match_description 수평겹침>0·수직거리≤0.05·아래쪽 우선, 폴백 paragraph→alt,
  rank_candidates 중심거리 top-3, figure_description/figure_type/alt 정규식, nearest_heading,
  embed_text 8000자 절단). 래퍼 `extract_figures(elements) -> list[record(image_bytes/ext 포함)]`
  + `text_from_elements(elements)`(figure 카테고리 제외 텍스트 재조립 — enhanced 영어 설명의
  RAG 청크 오염 차단, 빈 결과면 전체 markdown 폴백).
- `backend/app/services/figure_judge.py`: labs `judge.py` async 이식.
  config: `judge_base_url`(기본 TTA 프록시)/`judge_model`(EXAONE-4.5-33B)/`judge_api_key`(기본
  "" — 미설정 시 판정 생략·위치기반 유지). 요청 파라미터 labs 실측 그대로(max_tokens 512,
  temp 1.0, top_p 0.95, presence 1.5, enable_thinking off), salvage 정규식·범위밖 -1 강등·1회
  재시도 포함. 타임아웃 `httpx.Timeout(120, connect=10)`, 동시성 세마포어
  `figure_judge_concurrency`(기본 4, TTA 미실측 보수값), 연속 5회 실패 회로차단.

## 5. 워커 `backend/app/services/embedding_worker.py`

- `_handle_split` textbook 분기: `parse_document_full` 호출 → **figure 팬아웃(독립
  try/except, 실패해도 텍스트 계속)** → 텍스트는 `text_from_elements` 결과로 기존
  청킹→file_chunks→embedding_batch 경로 무수정 합류.
  - figure 팬아웃: `figure_pipeline_enabled` 확인 → extract → 크롭을
    `{owner_id}/{file_id}/figures/p{page}_e{eid}.{jpg|png}`로 storage_upload →
    `textbook_figures` 행 insert(status pending) → `figure_batch` 잡 팬아웃(batch_range 8).
  - 멱등 정리(:311-321 확장): textbook이면 기존 figure 행 삭제 + Qdrant figure 포인트 purge
    + 잔여 figure_batch 잡 가드.
- `_handle_figure_batch`(신규): 범위 내 pending 행 → 크롭 storage_download → 판정(강등 규칙
  D88) → `final_embed_text` → `embed_passages` 일괄 → Qdrant `COL_TEXTBOOK_FIGURES` 업서트
  (포인트 id=행 uuid, **페이로드 {figure_id, file_id, owner_id}만** — 신뢰 경계 불변식) →
  행 update(embedded + 판정 메타). 임베딩/Qdrant 실패는 행 failed + 잡 failed(기존 attempts
  규약). **파일 status·_finalize_file 호출 없음**(D88).
- `_process` 디스패치 + `_fail_file_for_job` figure_batch 분기(행만 failed, 파일 불변).
- `requeue_file`: failed figure 행 reset→pending 후 figure_batch 재팬아웃(텍스트와 대칭).
- `qdrant_store.py`: `COL_TEXTBOOK_FIGURES = "textbook_figures"` + `ensure_collections` 등록
  + `file_id` KEYWORD 페이로드 인덱스.

## 6. 검색 `backend/app/routers/retrieve.py` + URL 재발급

- `RetrieveBody.session_id` 실사용: USER 스코프 세션 조회 → `space_kind=='class'`일 때만
  figure 검색. **자체 try/except 별도 레그** — 실패 시 `figures:[]`, ebs/art는 살림.
- 스코프: `kind=eq.textbook` 파일 id 파생(USER 스코프, **status 필터 없음** — figure 가용성은
  텍스트 status와 독립 D88; Qdrant엔 embedded figure 포인트만 존재) → `search(...,
  file_ids=..., score_threshold = 1 - figure_retrieve_max_distance)` → 히트 id USER 스코프
  재조회(RLS 재검증, 못 읽으면 탈락) → `service.storage_sign`으로 signed URL(D87, TTL config
  `figure_signed_url_ttl_seconds` 기본 21600) → `figures: [{figure_id, file_id, page,
  caption(선택캡션 우선), url, score}]`.
- `service_client.py`에 `storage_sign(bucket, path, expires_in)` 신설(`POST /object/sign/...`).
- 재발급: `routers/files.py`에 `GET /files/figures/{figure_id}`(D41 chunk context 패턴 동형)
  — USER 스코프 1행 조회(RLS, 404) → 서명 → `{figure_id, url, caption, page}`.
- config: `figure_retrieve_top_k`(1, config 전용 — retrieve_ebs_top_k 동형).

## 7. 채팅 영속 `backend/app/routers/chat.py`

- `RetrievedFigureItem {figure_id, file_id, page, caption, score}`(**url 없음**, D87) →
  `RetrievedBody.figures` → `_patch_canvas_unified`가 `attachments.canvas.figures` 저장
  (단일 writer 유지).

## 8. RAG 텍스트·교사 목록 확장

- `rag.py class_material_file_ids`(:169-187): `kind in.(class_material,textbook)` — 교과서
  텍스트 청크가 `[학급 자료에서 참고]` 후보에 자동 합류.
- `teacher.py list_materials`(:142-151): 동일 in-필터 — 자료실 한 목록에 kind 배지 구분.
  FILE_SELECT에 kind 포함 여부 확인·필요 시 추가.

## 9. 프론트엔드 (`frontend/src/`)

| 파일 | 변경 |
|---|---|
| `components/teacher/MaterialsTab.tsx` | 버튼 2개(기존 불변 + "교과서 업로드" `accept=".pdf"`, `pendingKindRef`로 kind 분기 → `uploadFile(..., {kind:"textbook"})`), 행에 "교과서" 배지 |
| `lib/api.ts` | `RetrieveResult.figures` 파싱(방어적), `ChatStreamBody.retrieved.figures`(url 제외), `getFigure(figureId)` 신설, `NodeCanvasAttachment.figures` |
| `lib/concept/types.ts` | `CanvasLeafNode.type`에 `"figure"` + `figure?: {figureId, url, caption, page?}` |
| `lib/concept/leafPlacement.ts` | `LEAF_DIMS.figure = {w:260, h:240}` |
| `components/canvas/FigureNode.tsx` 신규 | VideoNode 이식: 이미지+캡션 푸터, 클릭 라이트박스(원본 img, Esc), 라벨 "교과서 도판", url 없으면 스켈레톤, `<img onError>` 시 getFigure 1회 재발급 |
| `components/canvas/ConceptCanvasWorkspace.tsx`(:247-254) | 렌더 분기 3항(video/art/figure) |
| `lib/concept/useConceptStream.ts` | `mapFigureScoreRef`(:207 동형)+스냅샷 롤백(:396-400,:494-499), send에서 `r.figures[0]` 대표 교체 `placeRep("map-figure",...)`, retrieved.figures 매핑, 재수화(:548-603) argmax → url "" 선배치 후 `getFigure`로 채움(resolveArt 비동기 후처리 패턴) |

학생 BottomBar 첨부(user_upload)는 무변경.

## 10. 튜너블 (D62 3단: config + as_* clamp + 0038 시드)

| 키 | 기본 | 비고 |
|---|---|---|
| `figure_pipeline_enabled` | true | 킬 스위치(과금·장애 대응), 시드 |
| `figure_retrieve_max_distance` | 0.60 | clamp 0.1–0.9, 시드(distance=1-score 규약) |
| `figure_judge_concurrency` | 4 | clamp 1–32, 시드 |
| `figure_retrieve_top_k` / `figure_batch_size` / `figure_signed_url_ttl_seconds` | 1 / 8 / 21600 | config 전용 |
| env: `JUDGE_BASE_URL` / `JUDGE_MODEL` / `JUDGE_API_KEY` | TTA 프록시 / EXAONE-4.5-33B / "" | `.env`, `backend/.env.example` 갱신. **키 미설정 시 판정 생략(위치기반)** |

## 11. 검증

- 단위: `cd backend && python -m pytest tests/ -v` — 신규 `test_figure_extract.py`(매칭
  규칙·후보 랭킹·8000자 절단), `test_figure_judge.py`(salvage·강등·회로차단),
  `test_worker_figures.py`(텍스트/figure 격리·멱등 재실행 시 행 수 불변),
  `test_retrieve_figures.py`(비구성원 figures=[] — RLS 스코프, figure 레그 실패 시 ebs/art
  생존). 기존 스위트(특히 test_upload_*, test_rag_class_scope, test_pdf_split,
  test_delete_qdrant_purge)는 **무수정 그린 필수**(class_material 회귀 게이트).
- 프론트: `cd frontend && npx tsc --noEmit && npm run build`.
- 수동 E2E: ① 교사로 labs `고등 한국사 1 교과서 (1).pdf` 교과서 버튼 업로드 → indexed +
  Qdrant `textbook_figures` count>0 + Storage `figures/` 크롭 확인 ② JUDGE_API_KEY 없이
  재업로드 → 텍스트 indexed + match_kind에 judge 없음(격리 확인) ③ 학생으로 학급 세션
  "무령왕릉" 질의 → FigureNode 표시 + 교과서 텍스트 RAG 칩 ④ 새로고침 → 재수화 fresh URL
  복원 ⑤ 타 학급 학생 → figure 미표시 ⑥ 파일 삭제 → figure 미표시 + Qdrant/Storage 정리.
- 마이그레이션 0038은 DRAFT로 작성(원격 적용은 사용자 승인 후 — 0037 관례).

## 12. 커밋 순서 (각 커밋 독립 배포 안전)

1. `[feat]:` 0038 마이그레이션 + config 키 + Qdrant 컬렉션 상수/ensure
2. `[feat]:` upstage `parse_document_full` + D78 페이지 오프셋 리팩터 (+테스트)
3. `[feat]:` figure_extract.py labs 이식 (+테스트)
4. `[feat]:` figure_judge.py async 판정 클라이언트 (+테스트)
5. `[feat]:` files.py kind=textbook 수용(PDF 전용·교사·500MB) + delete 확장 (+테스트)
6. `[feat]:` 워커 textbook 분기 + figure_batch 핸들러 + requeue (+테스트)
7. `[feat]:` /retrieve figures + storage_sign + GET /files/figures/{id} + rag/teacher 필터 (+테스트)
8. `[feat]:` chat attachments.canvas.figures 영속 (+테스트)
9. `[feat]:` 프론트 교과서 버튼 + FigureNode 리프(라이브/영속/재수화)
10. `[docs]:` CLAUDE.md 파이프라인·불변식 갱신(D86~D88), TASKS.md 기록

## 스코프 노트

- 교사 UI의 figure 진행률 표시(files.figure_status 컬럼류)는 v1 제외 — figure는 best-effort
  백그라운드이고 행 단위 상태 + requeue로 복구 가능. 필요해지면 후속.
- `figure_pipeline_enabled` off 시 enhanced 파싱을 표준 파싱으로 다운시프트하는 과금 최적화는
  후속(주석으로 남김).
