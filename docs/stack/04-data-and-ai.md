# 04 · 데이터와 모델

## Postgres

로컬은 도커(`docker compose up -d`, 포트 **5433** — 기계에 이미 도는 5432와 안
부딪히게). 배포는 supervisor가 띄운다.

- 표 **24** · RLS 정책 **68** · 함수 **111** (2026-08-10 실측)
- 확장: `citext`(이메일 대소문자) · `pgcrypto` · `plpgsql`
- 정본은 코드가 아니라 DB다: `select count(*) from pg_policies where schemaname='public'`

### 표 지도

| 묶음 | 표 |
| --- | --- |
| 계정·공간 | `users`(해시, app에 GRANT 없음) · `profiles` · `classes` · `class_members` |
| 대화 | `sessions` · `nodes`(턴 원문) · `canvas_items` · `canvas_drawings` · `item_links` |
| 자료 | `files` · `file_chunks` · `chunk_atoms` · `textbook_figures` |
| 강의 | `lecture_packages` · `lecture_videos` · `lecture_clips` · `lecture_clip_atoms` · `class_lecture_packages` · `clip_thumbnails` |
| 운영 | `jobs` · `app_settings` · `ai_logs` · `crosslink_runs` · `hand_fonts` |

### 스키마 다루기

- 새로 만드는 DB: `db/01_schema.sql` 등 SQL 5개가 이름순 자동 적용(빈 볼륨 1회).
- 이미 도는 DB: `db/migrations/*.sql` — **전부 멱등**하게 쓴다. 배포가 매번 전부
  적용한다.
- ⚠️ **둘 다 고친다.** 마이그레이션만 쓰면 새 DB에 없고, 스키마만 고치면 운영에
  반영이 안 된다.
- ⚠️ **"안 쓰이는 인덱스"가 외래키면 지우지 않는다.** SELECT가 안 쓸 뿐,
  CASCADE로 부모를 지울 때 그 인덱스가 없으면 표 전체 훑기가 된다.

## Qdrant

포트 **6333**. 컬렉션 **6** — 전부 **1024차원 · Cosine**.

| 컬렉션 | 담는 것 |
| --- | --- |
| `file_chunks` | 자료·교과서 본문 청크 |
| `chunk_atoms` | 청크당 예상 질문(PIKE) |
| `textbook_figures` | 교과서 도판 |
| `lecture_clips` | 강의 클립 |
| `lecture_clip_atoms` | 클립당 예상 질문 |
| `canvas_concepts` | 개념 카드(교차 연결용) |

### 불변식 셋

1. **Qdrant는 신뢰 경계가 아니다.** 페이로드에 본문을 안 넣는다 — 히트 뒤
   사용자 스코프 클라이언트로 **재조회**해 RLS가 다시 판정한다.
2. **임베딩은 비대칭.** 질의는 `embedding-query`, 문서는 `embedding-passage`.
   혼용 금지.
3. **거리 규약** `distance = 1 - score`.

⚠️ **행과 벡터는 함께 지운다.** 한쪽만 지우면 검색이 히트를 내고 본문 재조회가
빈손이 된다 — 오류 없이 조용히 틀린다.

### 왜 1024차원인가

Upstage 임베딩은 Matryoshka라 잘라 쓸 수 있다. 미니 코퍼스 실측으로 1024를
골랐다(`services/upstage.py` 머리말에 표가 있다).

## 스토리지

파일 실물은 로컬 디스크(`storage_root`). 브라우저에는 **서명 URL**로만 준다.

⚠️ **서명 URL을 저장하지 않는다**(D87). 만료되므로 필요할 때 재발급한다 —
도판 아이템이 `url` 없이 존재하는 때가 정상이다.

⚠️ **`<img src>`는 Authorization을 못 싣는다.** 토큰이 필요한 그림은
`lib/ui/useAuthedImage.ts`로 받아서 그린다. 학급 사진이 이 함정에 걸려 **한 번도
안 보였다**(D219).

## 모델

| 쓰임 | 모델 | 어디서 |
| --- | --- | --- |
| 대화 생성 · 도구 판단 | Upstage `solar-pro3` | 외부 API |
| 임베딩 | Upstage `embedding-query` / `embedding-passage` (1024d) | 외부 API |
| 문서 파싱 | Upstage Document Parse | 외부 API |
| 교차 연결 판정 | `solar-pro2` | 외부 API |
| 교과서 도판 캡션 | `EXAONE-4.5-33B` (비전) | **자체 GPU**(llama.cpp) |
| 손글씨 OCR | VARCO-VISION-2.0-1.7B-OCR | **자체 GPU** |

**모델 서버를 브라우저가 직접 부르지 않는다.** 그쪽은 인증이 없고 CORS가 열려
있어 주소가 곧 공개 GPU 창구가 된다.

### 스킬 11종

`think` · `set_media_intent` · `search_class_material` ·
`search_textbook_figure` · `search_lecture_clip` · `get_concept` ·
`read_my_notes` · `list_session_files` · `read_session_file` ·
`list_class_materials` · `summarize_class_questions`

목록은 **테스트가 지킨다**(`catalog.ALL_DECLARED` ↔ 레지스트리 일치) — 오타
하나로 스킬이 조용히 사라지는 것을 막는다.

### 안 쓰는 모델

**Whisper·OpenAI 계열을 제품에서 쓰지 않는다**(D221). 대회 규정이다. EBS 강의
파싱·전사는 저장소 밖 오프라인 스크립트(`.claude/scripts/parse_lectures.py`,
Gemini STT)가 하고, 관리자는 그 결과 파일을 관리자 콘솔에 끌어다 놓는다.

## 인제스트 파이프라인

```
업로드 → embedding_split → 문단 인지 청킹(1,200자/오버랩 150)
                         → embedding_batch(64청크) → embedding-passage → Qdrant
                         ├ figure_batch  (교과서만) 크롭 → 비전 캡션 → 임베딩
                         └ atom_batch    (노브 on) 예상 질문 → 임베딩
```

- 50MB 넘는 PDF는 페이지 분할 파싱.
- 용량 상한은 kind별: 교사 자료 500MB · 학생 50MB.
- 형식 화이트리스트는 **서버와 화면이 같은 목록**을 본다.
- 학생 업로드(`user_upload`)는 RAG를 안 만든다 — 청킹·저장만 하고 **세션 전문
  주입**으로 쓴다(세션당 15만 자 상한).

## 로컬에서 띄우기

```bash
docker compose up -d                       # postgres 5433 + qdrant 6333
cd backend && uv run uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev                 # http://localhost:3000
```

⚠️ 다른 포트로 백엔드를 띄웠다면 프런트에 `BACKEND_ORIGIN`을 준다. cmd에서는
`set "BACKEND_ORIGIN=http://127.0.0.1:8001" && npm run dev` — 따옴표가 없으면
`&&` 앞 **공백까지 값에 들어가** 프록시가 `Invalid URL`로 죽는다.

설정이 맞는지는 `GET /health/config`가 알려 준다(비밀값은 안 보여 준다).
⚠️ 이 창구를 공개 rewrite로 열지 않는다.
