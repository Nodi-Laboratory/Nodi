# Nodi

> 지구과학·과학 개념을 **손으로 쓴 노트처럼 펼쳐지는 무한 캔버스**에서 배우는 학습 앱.
> 질문하면 EXAONE이 개념 카드를 스트리밍하고, 질의 임베딩으로 카드가 놓일 자리를 잡은 뒤
> 관련 **EBS 영상**과 **SVG 일러스트**를 개념 주변에 노드로 함께 띄운다.

Next.js(App Router) 프론트엔드 · FastAPI 백엔드 · Supabase(Postgres/RLS/Auth) ·
**Qdrant**(벡터) · **Upstage**(임베딩 + 문서 파싱) · **EXAONE**(대화 생성) 스택.

---

## 주요 기능

- **개념 캔버스** — pan/zoom 무한 캔버스에 개념 카드를 손글씨 스타일로 배치. `(app)/space/[spaceId]`.
- **임베딩 기반 배치** — 사용자 질의를 임베딩해 가장 유사한 기존 개념 근처에 **잠정 배치**하고,
  EXAONE 응답(개념)이 오면 최종 격자 칸으로 **재조정**(부드러운 이동 애니메이션).
- **추천 노드** — 질의와 의미가 가까우면 **EBS 영상 노드**·**SVG 아트 노드**를 개념 옆에 별도로 생성.
- **선생님/학생 워크스페이스** — Supabase Google OAuth 로그인/가입, 역할(student/teacher/admin),
  개인(personal)·학급(class) 세션 스코프, RLS로 접근 제어, 온보딩(학급 코드 가입).
- **파일 RAG** — 업로드한 자료를 **Upstage Document Parsing**으로 추출·청킹·임베딩해 답변 근거로 활용.

---

## 아키텍처

```
프론트(Next.js, (app)/space/[spaceId])
  ConceptCanvasWorkspace = NoteCanvas + ConceptCard + VideoNode/ArtNode
  useConceptStream: (1) POST /retrieve → 잠정배치+추천노드 스폰
                    (2) POST /chat/stream(SSE, EXAONE) → 개념 스트리밍 → 재조정
                    (3) PATCH /nodes/{id} → 위치·추천노드 영속(attachments.canvas)
        │
백엔드(FastAPI)
  services/upstage.py   임베딩(embedding-query/passage, 4096d) + 문서 파싱(document-parse)
  services/qdrant_store 컬렉션 file_chunks / art_assets / ebs (size=4096, Cosine)
  services/exaone.py    대화 생성(스트리밍) — 그대로 유지
  services/gemini.py    라벨/태그/네비게이터(비임베딩 LLM) — 그대로 유지
  routers/retrieve.py   질의 임베딩 + Qdrant(ebs/art) 검색
        │
Supabase(관계형 + RLS + Auth + Storage)   ·   Qdrant(벡터만; RLS 없음 → 앱이 스코프 필터 강제)
```

**임베딩/벡터 스택 (2026-07 이전)**: 과거 Gemini 768d + pgvector → **Upstage 4096d + Qdrant**로 전면 이전.
- 임베딩은 비대칭 모델(질의 `embedding-query`, 문서 `embedding-passage`), 출력 정규화(내적=코사인).
- PDF/이미지 텍스트 추출은 **Upstage Document Parsing**(기존 Gemini OCR 대체).
- Qdrant에는 **벡터만** 저장. 관계형/소유권은 Supabase(RLS)에 두고, RAG 검색은 RLS로 스코프한
  `file_id`로 payload 필터 + 청크 텍스트는 유저 스코프 Supabase에서 재조회 → 교차 유저 유출 방지.
- 마이그레이션 `0028`이 pgvector 컬럼/HNSW 인덱스/검색 RPC를 제거.

---

## 저장소 구조

```
Nodi/
├─ frontend/                 Next.js (App Router, TypeScript)
│  └─ src/
│     ├─ app/(app)/space/[spaceId]/   대화 캔버스 라우트
│     ├─ components/canvas/           NoteCanvas·ConceptCard·VideoNode·ArtNode …
│     └─ lib/concept/                 useConceptStream·layout·near·grouping …
│  └─ public/art/{slug}.svg           개념 일러스트(정적 서빙)
├─ backend/                  FastAPI
│  ├─ app/services/          upstage·qdrant_store·exaone·embedding·rag·embedding_worker …
│  ├─ app/routers/           retrieve·chat·art·nodes·sessions·me …
│  └─ scripts/               ingest_ebs.py·generate_art.py·ebs_catalog.json·art_seeds.json
├─ supabase/migrations/      0001 … 0028_vectors_to_qdrant.sql
└─ docker-compose.yml        qdrant 서비스
```

---

## 사전 준비

- Node.js 20+ / npm
- Python **3.11+** (권장 3.12; 시스템 3.9는 `str | None` 타입 문법 미지원)
- Docker 데몬 (Docker Desktop 또는 colima 등) — Qdrant 컨테이너용
- 계정/키: **Supabase 프로젝트**, **Upstage API 키**, **EXAONE(Friendli) 키**, **Google Gemini 키**
  (라벨/태그/네비게이터용), *(선택)* Anthropic 키(오프라인 아트 생성용)

---

## 환경 변수

설정은 **저장소 루트 `.env`**(gitignored)에서 읽는다. 프론트는 `frontend/.env.local`.

### 루트 `.env` (백엔드)

| 키 | 용도 | 필수 |
|---|---|---|
| `UPSTAGE_API_KEY` | 임베딩 + 문서 파싱 | ✅ |
| `QDRANT_URL` | 벡터 저장소 (기본 `http://localhost:6333`) | ✅ |
| `EXAONE_API_KEY` | 대화 생성(Friendli serverless) | ✅ |
| `GOOGLE_GEMINI_API_KEY` | 노드 라벨·개념 태그·네비게이터 | ✅ |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | 인증·데이터·스토리지 | ✅ |
| `SUPABASE_PROJECT_REF`, `SUPABASE_JWKS_URL` | JWT 검증(미지정 시 URL에서 파생) | ⭕ |
| `ANTHROPIC_API_KEY` | 오프라인 SVG 아트 생성(`generate_art.py`)에서만 | ⭕ |

### `frontend/.env.local`

| 키 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 브라우저 Supabase 클라이언트 |
| `NEXT_PUBLIC_API_BASE_URL` | 백엔드 주소 (예: `http://localhost:8000`) |

예시 파일: `backend/.env.example`, `frontend/.env.local.example`.

> ⚠️ `.env`에 넣은 키는 절대 커밋하지 말 것. 노출된 키는 즉시 회전(rotate).

---

## 로컬 실행

```bash
# 0) Qdrant (벡터 저장소)
docker compose up -d qdrant          # 대시보드: http://localhost:6333/dashboard

# 1) 백엔드 (FastAPI)  — 루트 .env 채운 뒤
cd backend
python3 -m venv .venv && source .venv/bin/activate   # (uv 사용 시: uv venv --python 3.12 .venv)
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000            # GET /health 로 상태 확인

# 2) 프론트엔드 (Next.js) — 다른 터미널
cd frontend
npm install
npm run dev                                          # http://localhost:3000
```

---

## 데이터 시딩 (검색 활성화)

Qdrant 컬렉션은 비어 있으면 검색이 아무것도 반환하지 않는다. 최초 1회 채운다.

```bash
cd backend && source .venv/bin/activate

# EBS 영상 카탈로그(32종) → Qdrant `ebs`
python scripts/ingest_ebs.py            # --dry-run 으로 미리보기

# SVG 아트(frontend/public/art/*.svg) → Supabase art_assets + Qdrant `art_assets`
#  · 파일이 이미 있으면 재사용(임베딩·인덱싱만), 없으면 ANTHROPIC_API_KEY로 Claude 생성
python scripts/generate_art.py          # --force 로 재인덱싱, --dry-run 지원
```

기본 8종 아트: `earth-interior · plate-tectonics · water-cycle · photosynthesis ·
solar-system · cell-structure · pythagorean-theorem · supply-demand`
(시드는 `backend/scripts/art_seeds.json`, 파일은 `frontend/public/art/`).

**업로드 파일 RAG 재임베딩**: 과거 768d(pgvector) 데이터는 4096d(Qdrant)로 다시 임베딩해야
검색된다 — 관리자 requeue로 각 파일 재처리(`embedding_worker`가 Upstage로 재임베딩→Qdrant 업서트).

---

## 데이터베이스 마이그레이션

`supabase/migrations/`에 순번대로 적용. 최신은 **`0028_vectors_to_qdrant.sql`**:
pgvector 컬럼(`file_chunks.embedding`·`art_assets.embedding`)을 nullable로, HNSW 인덱스와
검색 RPC(`search_file_chunks`·`search_art_assets`)를 제거한다.

> ⚠️ `0028`은 검색 RPC를 삭제하므로 **반드시 Upstage/Qdrant 백엔드 신버전과 함께** 적용한다.
> 구버전 백엔드는 이 마이그레이션 이후 아트/RAG 검색이 실패한다.

---

## 검증 (스모크)

```bash
# 백엔드 컴파일/임포트
cd backend && python -m compileall -q app scripts && python -c "from app.main import app; print('ok')"

# 프론트 타입/빌드
cd frontend && npx tsc --noEmit && npm run build

# 검색 스모크 예시 (질의 임베딩 → Qdrant)
#   "달의 위상은 왜 변해?"  → EBS "달의 위상 변화"
#   "광합성이 뭐야?"        → ART  photosynthesis
#   무관한 질의             → 임계(≈0.35) 미달로 추천 노드 미생성
```

Qdrant 코사인 임계는 `retrieve_ebs_min_score` / `retrieve_art_min_score`(기본 0.35),
개념 근접 배치 임계는 프론트 `NEAR_EMBED_THRESHOLD`(0.5)로 조정한다.

---

## 참고

- 자세한 백엔드 엔드포인트 목록: `backend/README.md`
- 이 이전 작업의 설계 배경/결정: `~/.claude/plans/nodi-nodi-figma-temporal-reddy.md`
- 대화 생성은 EXAONE, 임베딩·문서 파싱은 Upstage, 라벨/태그/네비게이터는 Gemini가 담당한다.
