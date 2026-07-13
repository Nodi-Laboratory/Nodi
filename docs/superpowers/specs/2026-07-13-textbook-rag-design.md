# 교과서 RAG 설계 (2026-07-13)

한국 교과서 코퍼스를 임베딩해 두고, 사용자의 매 질문마다 유사 개념을 검색해
거리 게이트를 통과한 청크를 EXAONE 시스템 프롬프트에 `[교과서에서 참고]`
블록으로 주입하여 답변 품질을 높인다.

교과서 인제스트는 **admin 개발자가 직접 운영하는 오프라인 파이프라인**이다:
전용 폴더에 교과서 파일을 넣고 스크립트를 실행하면 벡터 DB(Qdrant)에
저장되고, 서비스는 그 컬렉션을 읽기만 한다.

## 배경 / 현재 구조

- 임베딩: Upstage 비대칭 4096d (`embedding-query` / `embedding-passage`),
  L2 정규화 — `services/upstage.py`
- 벡터 스토어: Qdrant (`file_chunks`, `art_assets`, `ebs`, `canvas_cards`)
- 기존 RAG: 분기에 **연결된 파일**의 청크만 검색해
  `[연결된 자료에서 참고]` 블록으로 주입 (`rag.build_rag_context`)
- 프롬프트 조립: `gemini.compose_system_structured` — 시스템 프롬프트 문자열과
  블록별 char span 메타의 단일 소스 (D35)
- 오프라인 인제스트 선례: `scripts/ingest_ebs.py` (EBS 카탈로그 → Qdrant `ebs`)

교과서는 사용자 소유 파일이 아닌 **시스템 공용 지식 베이스**이므로, 사용자
파일 파이프라인(`files`/`file_chunks`, RLS)에 넣지 않고 EBS처럼 전용 Qdrant
컬렉션 + 오프라인 인제스트로 다룬다.

## 결정 사항

| 항목 | 결정 |
|---|---|
| 데이터 소스 | 보유한 교과서 PDF/텍스트 |
| 인제스트 주체 | admin 개발자가 전용 폴더 + 스크립트로 직접 운영 |
| 적용 범위 | 모든 질문에 항상 검색, 거리 게이트로 주입 여부 결정 |
| 코퍼스 범위 | 단일 컬렉션·필터 없음으로 시작, 과목/학년 필터 대비 페이로드 설계 |
| 아키텍처 | 전용 `textbook` Qdrant 컬렉션 + 폴더 기반 오프라인 인제스트 |

## 1. 교과서 폴더 + 인제스트 파이프라인

### 폴더 구조 — `backend/textbooks/`

admin 개발자가 임베딩할 교과서 파일을 넣는 전용 폴더.

```
backend/textbooks/
  README.md              # 사용법 (커밋)
  manifest.example.json  # 메타 예시 (커밋)
  manifest.json          # 실제 메타 (선택, 커밋 안 함)
  *.pdf / *.txt / *.md   # 교과서 파일 (커밋 안 함)
```

- `.gitignore`에 `backend/textbooks/*` 추가, `README.md`와
  `manifest.example.json`만 예외로 커밋 — 교과서 원문은 저작권·용량 문제로
  저장소에 넣지 않는다.
- **메타데이터**: 폴더의 `manifest.json`이 있으면 파일별
  `{filename, source_name, subject, grade}`를 읽는다. 매니페스트가 없거나
  항목이 없는 파일은 `source_name = 파일명(확장자 제외)`, `subject`/`grade`
  빈 값으로 인제스트한다 — 메타 없이도 파이프라인이 돌아간다.

### 인제스트 스크립트 — `scripts/ingest_textbook.py`

`ingest_ebs.py` 패턴을 따르는 독립 스크립트. 폴더를 스캔해 전부 인제스트한다.

```
python scripts/ingest_textbook.py                 # backend/textbooks/ 스캔
python scripts/ingest_textbook.py --dir <path>    # 다른 폴더 지정
python scripts/ingest_textbook.py --dry-run       # 파싱·청킹까지만
```

- **처리 파이프라인** (파일별):
  1. PDF 바이트 로드 → `upstage.parse_document()`로 텍스트 추출
     (`.txt`/`.md`는 그대로 읽음)
  2. `embedding.chunk_text()`로 청킹 (기존 `chunk_size_chars` /
     `chunk_overlap_chars` 설정 사용)
  3. `upstage.embed_texts(kind="passage")` 배치 임베딩 (배치 상한은
     upstage 모듈이 처리)
  4. Qdrant `textbook` 컬렉션에 업서트
- **포인트 id**: `uuid5(NAMESPACE_URL, f"textbook:{source_name}:{seq}")` —
  결정론적, 재실행 시 중복 없이 덮어씀 (EBS 규약과 동일)
- **페이로드**: `{chunk_text, source_name, subject, grade, seq}`
  (+ 파서가 페이지를 주면 `page`). 본문을 페이로드에 직접 저장 —
  공용 코퍼스라 RLS 재검증이 불필요하므로 Supabase 테이블 없음.
- **재인제스트 정합성**: 같은 `source_name`의 청크 수가 줄면 옛 tail
  포인트가 남으므로, 업서트 전에 해당 `source_name` 필터로 기존 포인트를
  삭제한 뒤 새로 넣는다.
- **에러 처리**: 파일별 실패는 stderr 로깅 후 다음 파일 계속. 종료 시
  성공/실패 요약 출력, 실패가 있으면 exit code 1.

## 2. Qdrant 컬렉션 — `services/qdrant_store.py`

- `COL_TEXTBOOK = "textbook"` 추가, `ensure_collections()`에 포함
  (4096d, cosine — 기존 컬렉션과 동일)
- `subject`, `grade`, `source_name`에 keyword 페이로드 인덱스 생성 —
  지금은 검색 필터를 쓰지 않지만, 이후 사용자 학년 필터를 켤 때
  마이그레이션 없이 필터만 추가하면 되도록 대비 (`source_name` 인덱스는
  재인제스트 삭제에도 사용)
- `textbook_point_id(source_name, seq)` 헬퍼 추가 (id 규약의 단일 소스)

## 3. 런타임 검색 + 프롬프트 주입

### `rag.build_textbook_context(query_vector) -> dict | None`

- 입력: 이미 임베딩된 질문 벡터 (아래 재사용 참고). 빈 벡터면 즉시 None.
- 함수 진입 시 `app_settings.get_overlay()`로 4장의 노브 3종
  (`enabled`/`top_k`/`max_distance`)을 읽는다 — `enabled=false`면 즉시 None
  (관리자 변경이 다음 턴에 바로 반영, D62 패턴).
- Qdrant `textbook` top-k 검색 → `distance = 1 - score` 변환(기존 규약)
- **거리 게이트**: `distance <= textbook_rag_max_distance`인 청크만 사용.
  통과 청크가 0개면 None — 인사·잡담·교과 외 질문은 여기서 자연 탈락.
- 블록 렌더링: 첫 줄 `[교과서에서 참고]`, 이후 청크마다
  `- [source_name · p.N] 본문` (page 없으면 `- [source_name · #seq] 본문`)
- 반환: `{"block": str, "sources": [...]}` — sources는 기존 `build_sources`
  shape 호환(`{name, seq, page, distance, snippet}`; `file_id`/`chunk_id`
  없음 — 프론트는 chunk_id를 optional로 이미 처리, D41. "⋯" 이웃 청크
  패널은 미지원(Supabase에 본문 없음)).
- **불변식 유지**: 전체 try/except → 실패 시 None. RAG는 절대 채팅을 막지
  않는다.

### `routers/chat.py` — 질문 임베딩 재사용 (추가 API 비용 0)

현재 `qvec = upstage.embed_query(body.question)`(캔버스 배치용)이 컨텍스트
gather **뒤**에 있다. 이를 gather **앞**으로 이동하고, 그 벡터를
`rag.build_textbook_context(qvec)`에 넘겨 gather의 4번째 leg로 추가한다.

- 새 임베딩 호출이 생기지 않는다 (기존 3회 → 3회 유지: rag 질의, qvec,
  suggest는 별도 경로).
- qvec 임베딩 실패(`[]`) 시: 기존과 동일하게 sim 0.0 degraded 배치 +
  교과서 컨텍스트 생략. 채팅은 계속된다.
- 트레이드오프: qvec 임베딩(~수백 ms)이 gather와 직렬화되어 첫 토큰이
  약간 늦어질 수 있으나, gather 안에서 rag 질의 임베딩도 같은 API를 타므로
  실측상 병목 변화는 작다. (원하면 qvec도 gather에 합류시키는 후속 최적화
  가능 — v1 범위 밖.)

### `gemini.compose_system_structured`

- `textbook_context: str | None`, `textbook_sources: list | None` 파라미터
  추가
- 새 블록 kind `"textbook_rag"` — parts 배열에서 기존 `"rag"` 블록 뒤에
  배치, source 라벨 `"교과서 참고"`
- D35 구조를 그대로 따르므로 턴 로그·관리자 프롬프트 하이라이트가 자동
  지원됨

## 4. 설정 — `config.py` + D62 admin 오버레이

| 키 | 기본값 | 설명 |
|---|---|---|
| `textbook_rag_enabled` | `true` | 전체 on/off (admin 토글) |
| `textbook_rag_top_k` | `4` | 검색·주입 최대 청크 수 (1–20) |
| `textbook_rag_max_distance` | `0.45` | 거리 게이트 (0.1–0.9) |

세 키 모두 `app_settings` 오버레이로 실시간 조정 가능 (기존
`rag_top_k` 패턴과 동일). 0.45는 기존 제안 게이트(0.38)와 구 컷오프(0.50)
사이의 시작값 — 운영하며 관리자 슬라이더로 조정한다.

## 5. 에러 처리 요약

- 인제스트: 파일별 실패 → 로깅 후 계속, 종료 시 요약.
- 런타임: `build_textbook_context` 전체 try/except → None. Qdrant 다운,
  컬렉션 없음, 임베딩 실패 모두 "교과서 블록 없음"으로 강등될 뿐 채팅을
  막지 않는다.

## 6. 테스트

- `test_rag_textbook.py` (신규, Qdrant/설정 모킹):
  - 게이트 통과 청크 → block/sources 반환, 라벨 형식 검증
  - 전부 게이트 탈락 → None
  - 빈 질문 벡터 → None
  - Qdrant 예외 → None (채팅 불변식)
  - `textbook_rag_enabled=false` → None
- `compose_system_structured`: textbook 블록 포함 시 prompt_span 오프셋
  검증 (기존 span 테스트 패턴 확장)
- 인제스트: `--dry-run` 경로 스모크 (폴더 스캔, 매니페스트 병합, 청크
  카운트)

## 변경 파일

| 파일 | 변경 |
|---|---|
| `backend/textbooks/` (README, manifest.example.json) | 신규 폴더 |
| `backend/scripts/ingest_textbook.py` | 신규 |
| `backend/app/services/qdrant_store.py` | COL_TEXTBOOK, 인덱스, id 헬퍼 |
| `backend/app/services/rag.py` | `build_textbook_context` |
| `backend/app/services/gemini.py` | textbook 블록 파라미터/kind |
| `backend/app/routers/chat.py` | qvec 이동 + 4번째 gather leg |
| `backend/app/config.py` | 설정 3종 |
| `.gitignore` | `backend/textbooks/*` 제외 규칙 |
| `backend/tests/` | 신규/확장 테스트 |

프론트엔드 변경 없음 (sources shape 호환, chunk_id optional 기존 처리).

## 범위 밖 (YAGNI)

- 과목/학년 필터 적용 (페이로드·인덱스만 대비)
- 교과서 관리 UI / 온라인(업로드) 인제스트
- 이웃 청크("⋯") 패널 지원
- 리랭커, 하이브리드(BM25) 검색
