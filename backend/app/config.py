"""Application settings.

Loads configuration from `backend/.env` (the folder that contains `app/`).
Secrets are never hardcoded — pydantic-settings reads them from env / .env.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> parents[0]=app, [1]=backend, [2]=repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
# 설정은 backend 폴더 내부의 .env를 읽는다(루트 .env 아님). 전체 설정(Supabase·
# EXAONE·EXAONE_ENDPOINT_ID·Upstage·Qdrant 등)이 backend/.env에 있다.
BACKEND_ENV = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    # --- Supabase ---
    supabase_url: str = ""
    supabase_project_ref: str = ""
    # JWKS endpoint used to verify ES256-signed user JWTs.
    supabase_jwks_url: str = ""
    supabase_anon_key: str = ""
    # Optional in Stage 0 — server-side privileged ops. App must boot without it.
    supabase_service_role_key: str = ""

    # --- AI (EXAONE / Friendli) — chat-answer generation ---
    # Friendli serverless endpoint (OpenAI-compatible chat completions). Replaces
    # Gemini for the streamed chat answer. Embeddings now run on Upstage
    # (4096d, Qdrant) — see the Upstage/Qdrant sections below.
    exaone_api_key: str = ""  # Friendli API key (starts with flp_)
    exaone_model: str = "LGAI-EXAONE/K-EXAONE-236B-A23B"  # serverless model id
    # 전용 엔드포인트 ID. 설정되면 dedicated(/dedicated/v1, model=endpoint_id, 예약 GPU →
    # 공유 rate limit 없음)로, 비어 있으면 serverless(/serverless/v1, model=exaone_model)로 요청.
    exaone_endpoint_id: str = ""
    friendli_base_url: str = "https://api.friendli.ai"
    exaone_temperature: float = 0.5
    exaone_max_tokens: int = 2048

    # --- AI (Upstage) — 임베딩(4096d) + 문서 파싱(Document Parse) ---
    # 비대칭 임베딩: 질의 embedding-query / 문서 embedding-passage (혼용 금지).
    # PDF/이미지 텍스트 추출은 document-parse가 기존 Gemini OCR을 대체.
    upstage_api_key: str = ""
    upstage_base_url: str = "https://api.upstage.ai/v1"
    upstage_embedding_query_model: str = "embedding-query"
    upstage_embedding_passage_model: str = "embedding-passage"
    upstage_document_parse_model: str = "document-parse"

    # --- Qdrant (벡터 저장소 — pgvector 대체) ---
    # 컬렉션: file_chunks / canvas_cards / textbook_figures (전부 4096d, Cosine).
    # Qdrant엔 RLS가 없다 — 스코핑은 백엔드 페이로드 필터로 강제(qdrant_store).
    qdrant_url: str = "http://localhost:6333"

    # /retrieve의 EBS·아트 검색 노브는 D94(기능 제거)로 삭제됨.
    # 카드 배치·좌표는 프론트 소유(d3-force) — 서버 위치 계산 상수는 제거됨.

    # --- Memory linking (Stage 3a) ---
    # Cap imported (other-branch) nodes injected as reference context per turn.
    memory_max_imported_nodes: int = 12
    # Truncate each imported answer in the reference block (char budget).
    memory_answer_char_cap: int = 400

    # 임베딩은 Upstage embedding-passage/query 4096d + Qdrant로 완전 이전됨
    # (D80: 구 Gemini 임베딩 모델·차원 설정 키 제거).
    # Chunks per embedding_batch child job; sub-batched per embed request.
    embedding_batch_size: int = 64
    embedding_request_max_chunks: int = 32  # per embed_content call
    embedding_worker_concurrency: int = 3  # parallel jobs claimed per poll
    embedding_worker_poll_seconds: int = 5
    embedding_max_attempts: int = 3
    # A 'running' job older than this (no progress) is considered orphaned by a
    # crashed worker and recovered (requeued while attempts remain, else failed).
    embedding_stale_seconds: int = 120
    # Text chunking.
    chunk_size_chars: int = 1200
    chunk_overlap_chars: int = 150
    # Supabase Storage bucket for uploaded files.
    storage_bucket: str = "files"
    # Upper bound on a single uploaded file (bytes) — guard before processing.
    # D77: 학생·개인 업로드 25→50MB 상향(2026-07-15 사용자 결정).
    file_max_bytes: int = 50 * 1024 * 1024
    # D77: 학급 자료(class_material, 교사 전용) 전용 상한 — 대용량 교과서 PDF.
    # Upstage 파서 하드 리밋(요청당 50MB)은 D78 PDF 분할 파싱으로 우회한다.
    class_material_max_bytes: int = 500 * 1024 * 1024

    # --- File RAG search (Stage 3b-2) ---
    rag_top_k: int = 5  # chunks retrieved per query from class_material
    # --- D73/D82: 학급 자료 자동 RAG 스코프 (단일 경로) ---
    # 학급 세션이면 그 학급의 class_material(indexed/partial)을 링크 없이 검색
    # 후보에 넣는다. enabled는 자동 주입 경로의 킬 스위치(D62 오버레이).
    class_material_rag_enabled: bool = True
    # 전(全) 청크에 적용하는 거리 게이트(D82: 링크 개념 소멸로 무게이트 예외 없음).
    # distance = 1 - score (Qdrant cosine). 한국어 비대칭 임베딩에서 온토픽 질의
    # 거리가 0.50~0.56에 분포(E2E 실측)해 기존 0.50이 온토픽을 차단하고 인사말은
    # 0.87이라, 마진을 확보하며 0.50→0.60 상향(2026-07-15).
    class_material_rag_max_distance: float = 0.60

    # --- D84: 학생 세션 파일 전문 주입 예산 (TASK 3) ---
    # 한 세션에 주입 가능한 파일 전문의 합산 문자 상한. K-EXAONE 256K 토큰
    # 윈도우에 무트리밍 히스토리·RAG·답변 여유를 남기는 보수 기본값
    # (150K자 ≈ 한국어 75K~150K 토큰). 판정은 워커 저장 시점(초과 거부) +
    # 주입 시점 이중 방어. clamp 10_000~300_000 (as_int 호출부와 동기).
    session_context_max_chars: int = 150_000

    # --- 교과서 figure 파이프라인 (TASK 4, D86~D88) ---
    # 이 task(0038)는 스키마·설정·컬렉션만 추가하고 런타임은 무변경 — 아래 노브는
    # 후속 task의 인제스트·retrieve 경로가 소비한다. D62: admin 오버레이 > 기본값.
    figure_pipeline_enabled: bool = True          # 킬 스위치(enhanced 과금·장애 대응)
    figure_retrieve_max_distance: float = 0.60    # distance=1-score 규약(D73 게이트와 동일 스케일)
    figure_judge_concurrency: int = 4             # TTA 프록시 미실측 — 보수 기본
    figure_retrieve_top_k: int = 3                # D95: 다중 표시 — config 전용(admin 오버레이 없음)
    figure_batch_size: int = 8                    # figure_batch 잡 팬아웃 단위
    figure_signed_url_ttl_seconds: int = 21600    # 6h — 수업 시간 내 만료 실질 배제(D87)
    # --- figure 캡션 판정(EXAONE 비전, 플러그형 D88) — env: JUDGE_BASE_URL/JUDGE_MODEL/JUDGE_API_KEY ---
    judge_base_url: str = "http://proxy.tta-gpu.gov-nhncloud.com:30099/v1"
    judge_model: str = "EXAONE-4.5-33B"
    judge_api_key: str = ""                       # 미설정 → 판정 생략(위치기반 캡션 유지)

    # --- App ---
    # Postgres role embedded in Supabase user JWTs (NOT the app role).
    jwt_audience: str = "authenticated"
    cors_origins: list[str] = ["http://localhost:3000"]
    environment: str = "development"

    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def jwks_url(self) -> str:
        """Resolved JWKS URL, derived from SUPABASE_URL if not given explicitly."""
        if self.supabase_jwks_url:
            return self.supabase_jwks_url
        if self.supabase_url:
            return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        return ""

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/rest/v1" if self.supabase_url else ""

    @property
    def auth_issuer(self) -> str:
        """Expected `iss` claim of Supabase-issued user JWTs."""
        return f"{self.supabase_url.rstrip('/')}/auth/v1" if self.supabase_url else ""

    @property
    def storage_url(self) -> str:
        return (
            f"{self.supabase_url.rstrip('/')}/storage/v1" if self.supabase_url else ""
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
