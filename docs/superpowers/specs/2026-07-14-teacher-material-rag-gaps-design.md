# 선생님 워크스페이스 자료 RAG — E2E 빈틈 보수 설계 (TASK 2)

- 날짜: 2026-07-14 / 작성: Manager (자율 스펙 게이트 — 사용자 무개입 지시)
- 대상: `docs/TASKS.md` TASK 2 "선생님 워크스페이스 파일 입력 및 RAG 구축"
- 완료 기준(TASKS.md): **선생님이 교과서 PDF를 워크스페이스에 올리고, 학생이 그
  내용을 질의하면 해당 자료의 청크가 출처와 함께 근거로 주입된다.**

## 1. 진단 요약 (2026-07-14 실측)

코드 탐색 2건(백엔드·프론트) + 실앱 E2E 프로브 1건 결과.

**견고한 부분** (재작업 불필요): 업로드 API·권한 3중 방어(라우터 `is_class_teacher`
+ RLS 0013 + Storage 정책), 청킹→임베딩 파이프라인(embedding_worker, 상태 전이
uploaded→splitting→embedding→indexed/partial/failed, 크래시 복구·멱등 재큐),
선생님 자료실의 상태 배지+진행바+2.5s 폴링(MaterialsTab), 재처리 API
(`POST /files/{id}/retry`, owner 전용), RLS 교차 가시성(0012), Qdrant 히트 후
USER 스코프 재조회(rag.search — 불변식 준수).

**완료 기준을 막는 빈틈**:

| # | 심각도 | 위치 | 내용 |
|---|---|---|---|
| G1 | 차단 | 백엔드 | `build_rag_context`(rag.py:199)가 `file_node_links`에 **수동 링크된 파일만** 검색. class_material 자동 주입 경로가 없다. 링크 제안 훅(useFileSuggestions)마저 UI 미배선(소비처 0)이라 학생이 링크를 만들 방법 자체가 없음 → **학급 자료가 학생 질의에 절대 주입되지 않는다.** |
| G2 | 차단 | 백엔드+프론트 | 출처가 학생 화면에 전무. SSE `done` 페이로드에 `rag_sources` 미포함(chat.py:249-262 — 노드 PATCH로만 저장), `ConceptCard`는 sources 미렌더(렌더 소비처는 admin LogsTab뿐). |
| G3 | 차단 | 프론트 | 실패/부분실패 파일의 재시도·삭제 UI 부재 — `retryFile`/`deleteFile`(api.ts:372,382)은 존재하나 소비처 0. 실패 시 선생님이 취할 액션이 없는 데드엔드. |
| G4 | 중요 | 백엔드 | 업로드 형식 화이트리스트 부재 — 미지원 형식(docx/hwp 등)이 UTF-8 디코드로 깨진 청킹 또는 `no extractable text` 실패. 사전 안내·거절 없음. |
| G5 | 사소 | 프론트 | 업로드 성공 피드백 없음, 클라 측 형식 사전 검증 없음(`accept`는 힌트뿐). |
| G6 | 중요 | 백엔드 | **split 즉시 실패 시 파일 터미널 전환 누락** — 미지원 형식(zip)이 Upstage 400으로 split 실패하면 잡만 failed 처리되고 `files.status`가 `splitting`에 **영구 고착**(실패 배지 안 뜸 → G3 재시도 버튼의 전제 붕괴). E2E 프로브 실측. |

E2E 프로브 실측(2026-07-14, `.superpowers/sdd/task2-probe-report.md` + e2e-task2/
스크린샷 12장): 교사 업로드→인덱싱(<1분, Qdrant file_chunks 0→1)은 PASS.
**학생 질의는 FAIL** — SSE·개념 카드는 정상이나 답변이 자료 내용(경도 9.7·카론
분지)과 정면 모순되는 환각, RAG 미주입·출처 미표시·`/file-suggestions` 호출 0회
(G1·G2 재현). zip 업로드는 수락된 뒤 "분할 중" 고착(G4·G6 재현), 재시도·삭제
UI 없음(G3 재현). 테스트 잔존물: 학급 "노디늄 과학 실험반"(코드 EPRFPY)에
파일 2종 — 마무리 E2E에서 G3 삭제 UI로 정리 예정.

## 2. 설계 결정

### D67 — class_material 자동 스코프 주입 (G1)

세션이 학급 공간(`space_kind='class'`)이면, 그 공간의 class_material 파일
(`status in (indexed, partial)` — partial도 임베딩된 청크는 검색 가능)을
**링크 파일과 합집합**으로 Qdrant 검색 후보에 넣는다.

- `rag.build_rag_context(client, chain, query, *, space_kind=None, space_ref=None)`
  로 시그니처 확장. 호출부(chat.py)는 이미 들고 있는 세션 행의
  `space_kind`/`space_ref`를 넘긴다 (sessions.py:37 SELECT에 포함 — 추가 조회 없음).
- **거리 게이트 차등**: 수동 링크 파일의 청크는 기존대로 게이트 없음(사용자가
  명시한 신뢰). **자동 스코프(링크되지 않은 class_material) 청크만**
  `distance ≤ class_material_rag_max_distance` 게이트를 적용해 인사말·무관 질의
  턴의 프롬프트 오염을 막는다.
- **튜너블 2종 (D62 규약)**: `class_material_rag_enabled`(bool, 기본 true —
  신규 자동 주입 경로의 킬 스위치), `class_material_rag_max_distance`(float,
  기본 0.50, clamp 0.1~0.9 — 기존 공유 컷오프 0.50 의미 계승). config 기본값 +
  `app_settings` 시드 마이그레이션 `0029_app_settings_class_rag_seed.sql`
  (admin 콘솔 노출용. **원격 적용은 하지 않는다** — 파일만 추가, 배포 시 적용.
  미적용 상태에서도 config 폴백으로 동작).
- 불변식 유지: 전체 경로 best-effort(실패 시 None), 본문 재조회는 기존
  `search()`의 USER 스코프 RLS 경로 그대로.

**대안 비교**: (a) 링크 제안 UI 배선 후 학생 수락 유도 — 완료 기준 "질의하면
주입"과 불일치(수동 단계 잔존) + 프론트 대공사. (b) 게이트 없는 전면 주입 —
무관 질의에도 교과서 청크가 주입되어 프롬프트 오염·토큰 낭비. **(c) 채택안:
합집합 + 자동 스코프만 거리 게이트** — 기존 링크 경로 무회귀, 신규 경로만
보수적 게이트.

부수 메모: `suggest_files`는 변경하지 않는다. 학급 공간에서 class_material이
자동 주입되므로 제안이 중복될 수 있으나, 제안 UI 자체가 미배선(소비처 0)이라
현재 사용자 영향 없음 — 배선 시점에 재검토.

### D68 — 출처 전달·표시 (G2)

- **백엔드**: SSE `done` 이벤트의 `node` 객체에 `rag_sources`(build_sources
  산출물 그대로: `[{file_id, chunk_id, name, seq, page, distance, snippet}]`)를
  포함한다. 노드 PATCH 영속(D32)은 기존 유지 — done 페이로드는 실시간 표시용.
- **프론트**: 출처는 노드(턴) 단위 provenance이므로 **턴의 첫 개념 카드**에
  출처 칩 푸터로 렌더한다(카드마다 복제하면 노이즈; 첫 카드 앵커는 기존 리프
  앵커 `firstIdxByNode` 패턴과 동일).
  - 라이브: `useConceptStream.send()`의 done 처리에서 `placeholderId`(승격된 첫
    개념 id와 동일 — 승격이 id를 보존)로 해당 개념에 `sources` 부착.
  - 재수화: `replayNodes`가 `NodeRow.rag_sources`(types.ts:92 — 타입 기존 존재)를
    `firstIdxByNode`로 동일 부착 → 새로고침 후에도 표시 유지.
  - 렌더: `ConceptCard` 하단에 파일 단위로 중복 제거한 칩("📄 파일명 · p.N",
    최대 3개 + 초과 개수 표기). CSS Modules 기존 컨벤션.

### D69 — 업로드 형식 화이트리스트 (G4, G5)

- **서버**(`services/files.py upload_file`): 확장자 화이트리스트 검증 —
  `pdf, png, jpg, jpeg, webp, gif`(Upstage Document Parse 경로) +
  `txt, md`(UTF-8 디코드 경로). 그 외 422 + 한국어 사유("지원 형식: PDF, 이미지
  (PNG/JPG/WEBP/GIF), 텍스트(TXT/MD)"). `_extract_text`의 실제 처리 능력과 목록을
  일치시킨다(허용 목록이 곧 처리 가능 목록).
- **클라**(`MaterialsTab`): 동일 목록으로 선택 직후 사전 검증 → 서버 왕복 없이
  같은 사유 메시지 표시. 서버 422 메시지도 기존 error 배너로 표출.

### D70 — 인제스트 실패의 터미널 전환 보장 (G6)

`embedding_worker`의 잡 예외 경로에서 재시도(attempts) 소진 시 **파일도 터미널
상태로 전환**한다 — split 잡 실패 → `files.status='failed'` + `error` 기록,
batch 잡 실패 → 기존 `_finalize_file` 경로(partial). 스테일 잡 복구 경로
(`_recover_stale_jobs`)에는 이미 `_fail_file_for_job`이 있으므로, **즉시 예외
경로(`_process`의 실패 처리)에도 동일 전환을 적용**해 "분할 중" 고착을 없앤다.
부수: `build_rag_context`에 주입 성공 시 INFO 로그 1줄(파일·청크 수) — 마무리
E2E의 주입 증거 확보용(현재 RAG 관측성 0).

### G3 — 실패 파일 재처리 동선 (프론트)

`MaterialsTab`의 `MaterialItem`에:
- `failed`/`partial` 파일: **재시도** 버튼 → `retryFile(id)` → `classMaterialsKey`
  invalidate (폴링이 진행 상태를 이어받음). 요청 중 disabled.
- 모든 파일: **삭제** 버튼 → confirm 후 `deleteFile(id)` → invalidate.
- 업로드 성공 시 간단한 성공 피드백(G5 — 인라인 안내 1줄, 토스트 라이브러리
  신규 도입 금지).

## 3. 비범위 (YAGNI)

- 학생 파일 업로드 UI·전문(全文) 주입 — **TASK 3**.
- 학생용 학급 자료 목록·인덱싱 상태 화면 — 완료 기준 밖(학생은 질의 결과의
  출처 칩으로 자료 존재를 인지).
- 다중 파일 업로드·드래그드롭·업로드 진행률 퍼센트.
- `suggest_files` 로직 변경·file_suggestion UI 배선.
- 마이그레이션 원격 적용(배포 절차), 기존 0022 시드 드리프트(embedding_dimension
  표기) 정리 — 별건.
- `search_file_chunks` 등 0028에서 DROP된 죽은 RPC 정리 — 별건.

## 4. 검증 기준

1. **단위(백엔드)**: ① class 스코프 자동 포함(링크 0개여도 class_material 검색),
   ② 자동 스코프 청크만 거리 게이트 적용(링크 청크는 무게이트), ③ 킬 스위치
   off → 링크 파일만(기존 동작), ④ personal 공간 → 기존 동작 불변,
   ⑤ done 이벤트에 rag_sources 포함, ⑥ 미지원 형식 업로드 422, ⑦ split 잡
   attempts 소진 시 `files.status='failed'` 전환(고착 재현 방지). 전체 스위트 GREEN.
2. **프론트**: `npx tsc --noEmit && npm run build` 스모크 + playwright 실동작
   (재시도/삭제 버튼, 출처 칩 렌더) + 프론트엔드 리뷰어 게이트(스크린샷).
3. **E2E(마무리)**: 선생님이 실제 PDF 업로드 → indexed → 학생이 그 내용 질의 →
   답이 자료 근거 + **첫 개념 카드에 출처 칩** 표시까지 실측 PASS.
