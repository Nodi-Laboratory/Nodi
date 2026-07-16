# 학생 파일 세션 컨텍스트 주입 설계 (D83·D84·D85) — TASK 3

- 날짜: 2026-07-15 / 작성: Manager
- 요구(TASKS.md TASK 3): 학생이 세션에 파일을 올리면 **청킹·저장까지만** 하고
  (임베딩·RAG 구축 없음), 청크 전체를 seq 순으로 이어붙여 **해당 세션의
  컨텍스트로 주입**한다. 용량은 EXAONE 256K 토큰 컨텍스트에 맞춰 제한한다.
- 선행: D82에서 개인 공간 파일 RAG가 소멸("이 기능이 대체 예정"으로 명시),
  RAG는 학급 자료 자동 스코프 단일 경로로 확정.

## 1. 현황 (2026-07-15 실측)

- **학생 파일도 전부 RAG 경로를 탄다**: `kind='user_upload'`가
  `embedding_split → 파싱 → 청킹 → embedding_batch → Qdrant`를 그대로 타지만,
  D82 이후 개인 파일을 검색하는 소비 경로가 없다 — 죽은 벡터만 쌓인다.
- **`files.session_id`는 존재했다가 삭제됨**: 0011(D13)에서 도입, D81(0033)에서
  소비 0으로 드랍. 재도입에 충돌 없음.
- **file_chunks RLS는 소유자 read 허용**(0009 `file_chunks_select_own` — 부모
  파일 소유자). USER 스코프 재조회로 본문 접근 불변식 유지 가능.
- **학생 업로드 UI가 없다**: `uploadFile` 호출처는 교사 MaterialsTab뿐.
  캔버스(BottomBar)는 텍스트 입력만 받는다.
- 프롬프트 블록 순서(D35): `system_base → memory_link → rag → comparison`.
  exaone `_build_messages`는 히스토리 무트리밍.
- 세션 행에 `space_kind/space_ref`가 이미 있고(`SESSION_SELECT`) chat_stream이
  읽는다. 청크 상태 CHECK는 `('pending','embedded','failed')`,
  파일 상태 CHECK는 `('uploaded','splitting','embedding','indexed','partial','failed')`.
- 다음 마이그레이션 번호: **0037**. 학생 업로드 바이트 상한: D77 50MB(유지).

## 2. 설계 결정

### D83 — 세션 스코프 전문 주입 아키텍처

**파일-세션 연결**: `files.session_id uuid` 재도입(0037,
`references sessions(id) on delete set null` + partial index). 업로드 멀티파트에
옵션 Form 필드 `session_id` 추가 —

- `kind='user_upload'`에서만 허용, `class_material`에 오면 422.
- 세션 소유자 = 업로더 검증(USER 스코프 세션 조회 + `owner_id == caller` 명시
  비교 — 교사는 학생 세션을 SELECT할 수 있으므로 RLS만으론 부족). 불일치 403,
  세션 없음 404.
- 세션의 `space_kind/space_ref`와 업로드 폼의 공간 인자가 다르면 422
  (프론트는 세션의 공간을 그대로 전달).
- `session_id` 없는 user_upload는 기존 동작(레거시 경로) 유지 — 단 아래 워커
  분기는 **kind 기준**이므로 세션 없는 user_upload도 임베딩은 생략된다
  (D82 이후 소비 경로가 없으므로 옳은 방향).

**워커 분기** (`_handle_split`): 파일 `kind='user_upload'`이면 —

1. 청킹 **오버랩 0** (전문 이어붙이기에 오버랩은 중복 텍스트만 만든다.
   청크 크기는 기존 튜너블 그대로).
2. D84 예산 검사(아래) — 초과 시 청크 저장 없이 `failed` + 한국어 사유.
3. 통과 시 `file_chunks` 저장(`status='stored'` — 0037이 CHECK에 추가.
   'pending'은 영구 대기로 오독되고 'embedded'는 거짓이므로 신규 값),
   `files.context_chars` 기록, **embedding_batch 팬아웃 생략**,
   파일 즉시 `status='indexed'`·`chunk_total=n`·`chunk_done=n`.
   ('indexed' 재사용으로 프론트 FileStatus 타입·FILE_IN_PROGRESS 폴링·재시도
   판별 무변경. user_upload에서 의미는 "세션 컨텍스트 준비 완료" — 주석 명시.)

`class_material` 경로는 무변경(회귀 0 완료 기준).

**주입 빌더**: 신규 `services/session_context.py`의
`build_session_file_context(client, session_id) -> {"block", "files"} | None`.

- 조회: `files where session_id=eq & kind=eq.user_upload & status=eq.indexed`
  `order created_at asc` → 파일별 `file_chunks(seq,chunk_text) order seq asc`
  전량을 USER 스코프로 조회(RLS 재검증 불변식) → `"[세션 파일: {name}]\n" + 전문`
  을 파일 순서대로 연결.
- best-effort: 전체 try/except → 실패·해당 없음 시 None(채팅 불중단 불변식).
- `files` 메타 `[{file_id, name, chars}]`는 턴로그·프론트 관측용.
- chat_stream의 컨텍스트 빌더 gather에 4번째 leg로 추가(기존 병렬 패턴).

### D84 — 컨텍스트 예산 (문자 기준, D62 튜너블)

- 신규 튜너블 `session_context_max_chars` 기본 **150,000자**, clamp
  10,000~300,000. 근거: K-EXAONE 한국어 토크나이저 보수 추정(자당 0.5~1토큰)
  으로 150K자 ≈ 75K~150K 토큰 — 무트리밍 히스토리·RAG·답변 여유를 남긴다.
  상한 300K자는 최악 추정에서도 윈도우 내. D62 규약: config 기본값 +
  `as_int` clamp + 0037 시드 + admin SettingsTab 메타 엔트리.
- **판정 시점 = 워커 파싱·청킹 직후**(업로드 시 바이트 1차 제한은 그대로):
  `신규 파일 문자수 + 같은 세션의 기존 활성 파일(context_chars 합) > 예산`
  이면 거부 — `files.status='failed'`, error에 한국어 사유
  (예: "세션 컨텍스트 예산 초과: 이 파일 약 N자, 세션 잔여 M자").
  청크는 저장하지 않는다. 다중 파일 합산 정책은 이것으로 확정(선착순).
  예산 검사는 **session_id가 있는 파일에만** 적용한다(세션 없는 user_upload는
  주입 대상이 아니므로 예산 무관). 예산 초과 `failed`의 재시도(retry)는 같은
  사유로 재실패한다 — 정도(正道)는 삭제 후 작은 파일 재업로드(사유 문구가 안내).
- `files.context_chars integer`(0037): 워커가 통과 시 기록. 주입·예산 판정
  모두 이 컬럼을 읽어 청크 재합산(N+1)을 피한다.
- **주입 시 이중 방어**: admin이 예산을 낮춘 경우 등 합산 초과가 감지되면
  업로드 순으로 포함하고 초과 파일은 통째 제외 + warning 로그(부분 절단은
  하지 않는다 — 문서 중간 절단은 환각 유발).

### D85 — session_files 프롬프트 블록 (Friendli 프리픽스 캐시)

- `compose_system_structured`에 `session_file_context` 파라미터 +
  `_WRAP_SESSION_FILES` 래퍼 추가. 블록 순서:
  `system_base → session_files → memory_link → rag → comparison`.
  세션 파일 전문은 파일 추가/삭제 전까지 턴 간 불변 → 프롬프트 앞쪽 고정으로
  Friendli 프리픽스 캐시(입력 단가·TTFT)를 살린다. 턴마다 변하는
  memory/rag/comparison은 뒤에 둔다. 파일도 업로드 순(created_at asc)으로
  연결해 새 파일 추가 시 기존 프리픽스가 보존되게 한다.
- 블록 메타: `kind='session_files'`, `source='세션에 올린 파일'`,
  `sources=[{file_id,name,chars}]` — D35 span 규약으로 턴로그(D25)·admin
  하이라이트에 자동 편승.

### 프론트 — 학생 업로드 UX (신규)

- **첨부 진입점**: **프롬프트 창(BottomBar) 입력줄 안의 클립 버튼**
  (사용자 지시 2026-07-15 — 초기 구현의 별도 바 버튼을 task3-5에서 이동).
  활성 세션이 없으면(개인 공간 신규 진입) `ensureSession()`으로 첫 질문과
  동일하게 세션을 자동 생성한 뒤 그 세션으로 업로드한다. `SessionFilesBar`는
  칩 스트립·오류 표시 전용. `uploadFile`에 `session_id` 옵션 추가, 공간
  인자는 세션의 `space_kind/space_ref`를 그대로 전달. 개인 세션·학급 세션
  모두 동일 동선.
- **세션 파일 칩 스트립**(캔버스 하단, BottomBar 인접): 파일별 상태 —
  처리 중(uploaded/splitting 스피너), **"세션 컨텍스트로 사용 중"**(indexed
  배지), 실패(빨간 칩 + 서버 error 사유 그대로 + 삭제 버튼). 삭제는 기존
  `DELETE /files/{id}` 재사용. 폴링은 기존 FILE_IN_PROGRESS 패턴 재사용.
- **세션 파일 목록 API**: `GET /files`의 `space_kind`를 옵션으로 완화하고
  옵션 쿼리 `session_id`를 추가 — `session_id`가 오면 세션 기준 조회(공간
  인자 무시, RLS가 소유자 스코프), 없으면 기존대로 `space_kind` 필수(422).
  프론트 `listSessionFiles(sessionId)` 추가.
- 예산 초과·형식 거부 등 업로드 4xx의 detail(한국어)을 칩/토스트로 노출.

## 3. 대안 비교

- **세션 연결**: (a) 채택 — `files.session_id` 재도입(선례 0011, 소비 경로
  명확). (b) `session_files` 조인 테이블 — 다세션 공유는 요구에 없음(YAGNI).
  (c) 연결 없이 공간 전체 주입 — 세션 격리 요구 위반(같은 학급/개인 공간의
  다른 세션 파일이 섞임).
- **분기 위치**: (a) 채택 — 워커 분기. 파싱(D78 분할 포함)·잡 관측성·재시도·
  삭제 동선을 전부 재사용, 코드 변화 최소. (b) 업로드 요청 내 동기 파싱 —
  대형 PDF에서 요청 타임아웃·이벤트 루프 블로킹(AGENTS.md 비동기 규율 위반
  소지). (c) 채팅 시점 스토리지 재파싱 — 턴 지연 폭발, 매 턴 Upstage 비용.
- **예산 원장**: (a) 채택 — `files.context_chars` 기록. (b) 매번 청크 문자
  재합산 — 세션 파일 수 × 청크 수 N+1. (c) 예산 검사 없이 주입 시 절단 —
  "명확한 사유와 함께 거부" 완료 기준 위반.
- **터미널 상태**: (a) 채택 — 'indexed' 재사용(프론트·admin 파급 0).
  (b) 신규 'ready' — 의미는 정확하나 FileStatus 유니언·폴링 셋·상태 렌더
  전부 파급, 이득 없음.

## 4. 불변식 준수

- **채팅 불중단**: session_context 빌더는 best-effort, 실패 시 None.
- **Qdrant 신뢰 경계**: 무관 — user_upload는 Qdrant에 아예 쓰지 않는다.
  본문 조회는 USER 스코프(RLS 재검증).
- **비대칭 임베딩**: 무접촉(임베딩 자체가 없음).
- **거리 규약**: 무접촉. **튜너블(D62)**: as_int + clamp + 0037 시드 + admin 메타.

## 5. 비범위 (기록만)

- 기존에 이미 임베딩된 user_upload 벡터(Qdrant)·'embedded' 청크 정리 —
  코드가 더는 참조하지 않는 죽은 데이터(TASK 1 textbook 컬렉션과 동일 취급,
  수동 정리 메모만 남긴다). 기존 파일은 세션 연결이 없어 주입 대상도 아니다.
- 세션 삭제 시 고아 파일(session_id → null) 정리 정책, 노드-파일 링크 UI 부활,
  예산 초과 파일의 부분 주입, 히스토리 트리밍.
- 교사 class_material 경로·화이트리스트(D75)·용량(D77)·분할 파싱(D78) 무변경.

## 6. 완료 기준 (TASKS.md와 동일 + 구체화)

1. 학생이 세션에 파일 업로드 → 임베딩 잡 0개 생성, Qdrant 무접촉 →
   `indexed` 후 다음 질의부터 파일 전문이 근거로 주입(턴로그 블록 증거).
2. 예산 초과 파일은 `failed` + 한국어 사유가 프론트 칩에 노출.
3. 선생님 class_material RAG(D73 자동 스코프·출처 칩) 회귀 0 — 전체 스위트 GREEN.
4. "세션 컨텍스트로 사용 중" 표시가 실브라우저에서 확인(E2E).
