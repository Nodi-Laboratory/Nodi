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
# EXAONE·EXAONE_ENDPOINT_ID·Gemini 등)이 backend/.env에 있다.
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
    # 컬렉션: file_chunks / art_assets / ebs (전부 4096d, Cosine).
    # Qdrant엔 RLS가 없다 — 스코핑은 백엔드 페이로드 필터로 강제(qdrant_store).
    qdrant_url: str = "http://localhost:6333"

    # --- /retrieve (개념 캔버스: 질의 임베딩 + EBS/아트 노드 검색) ---
    retrieve_ebs_top_k: int = 1
    retrieve_art_top_k: int = 1
    retrieve_ebs_min_score: float = 0.35
    retrieve_art_min_score: float = 0.35

    # 카드 배치·좌표는 프론트 소유(d3-force) — 서버 위치 계산 상수는 제거됨.

    # --- AI (Gemini) — 비임베딩 LLM 작업만 (chat/label/tag; 임베딩은 Upstage) ---
    google_gemini_api_key: str = ""
    # Chat model (streaming). Label model is a lighter/cheaper flash variant.
    # Runtime override (admin) lands in a later stage; static config for now.
    gemini_chat_model: str = "gemini-2.5-flash"
    gemini_label_model: str = "gemini-2.5-flash-lite"
    # Concept tagging uses the same lightweight tier by default.
    gemini_tag_model: str = "gemini-2.5-flash-lite"
    # Hard cap on auto-generated node labels (design: <= 10 chars).
    node_label_max_chars: int = 10
    # Auto concept tags per node (design: 1..3).
    max_tags_per_node: int = 3

    # --- Memory linking (Stage 3a) ---
    # Cap imported (other-branch) nodes injected as reference context per turn.
    memory_max_imported_nodes: int = 12
    # Truncate each imported answer in the reference block (char budget).
    memory_answer_char_cap: int = 400

    # --- File RAG embeddings (Stage 3b-1; Upstage/Qdrant로 이전) ---
    # 임베딩은 Upstage embedding-passage/query 4096d + Qdrant로 이전됨.
    # gemini_embedding_model 키는 이전 완료 전까지 참조하는 코드가 남아 있어
    # 유지(비활성 예정 — 새 코드는 services/upstage.py를 사용할 것).
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimension: int = 4096
    # --- SVG art search (concept-card illustrations) ---
    # Cosine distance cutoff for a query->art match (0=identical). Above this, no
    # illustration is shown for the concept.
    art_match_max_distance: float = 0.42
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
    file_max_bytes: int = 25 * 1024 * 1024

    # --- File RAG search + tagging (Stage 3b-2) ---
    rag_top_k: int = 5  # chunks retrieved per query from linked files
    file_tag_max: int = 50  # concept tags per file (denser than node 1..3)
    # Chars of file text sampled for tag extraction.
    file_tag_sample_chars: int = 6000

    # --- Textbook RAG (전역 교과서 코퍼스, Qdrant `textbook` 컬렉션) ---
    textbook_rag_enabled: bool = True  # 교과서 블록 주입 전체 on/off
    textbook_rag_top_k: int = 4  # 질문당 검색·주입 최대 청크 수
    textbook_rag_max_distance: float = 0.45  # 거리 게이트(1-score), 초과분 탈락

    # --- RAG polish (Stage 3b-3) ---
    # Multimodal model for image OCR (text extraction from images / scans).
    ocr_model: str = "gemini-2.5-flash"
    # File-suggestion ("연결할까요?") tuning.
    # D56: top-N proposed is boostrapped to 1 — suggestions now require a single
    # CONFIDENT top match (was 3, which surfaced borderline extras).
    file_suggestion_top_n: int = 1  # files proposed (1..2)
    file_suggestion_search_k: int = 20  # chunks scanned before grouping by file
    file_suggestion_query_chars: int = 1500  # branch text used as the query
    # D48 content gate (relaxed from D37's 40): a SAFETY FLOOR only — block
    # empty/whitespace-only branch queries. Greetings/small-talk are now caught
    # by the conservative stoplist (_greeting_only) and, decisively, by the
    # distance cutoff + margin below — NOT by a blunt length gate (which used to
    # false-negative short-but-real questions like "미분이 뭐야?").
    file_suggestion_min_query_chars: int = 10
    # DEPRECATED (D63): this key is DEAD — no runtime path reads it. The real
    # suggestion gate is `file_suggestion_suggest_max_distance` (0.38) below.
    # Kept only for non-destructive back-compat; do NOT wire it. Not exposed in
    # the admin console and not seeded by 0022.
    file_suggestion_max_distance: float = 0.50
    # Margin gate: only surface a suggestion when the BEST candidate is at least
    # this much INSIDE the cutoff (best_distance <= cutoff - margin), i.e. only
    # confident matches — borderline ones are not proposed.
    file_suggestion_margin: float = 0.05
    # --- D56: SUGGESTION-ONLY gate (decoupled from RAG injection) ---
    # The proposal query is now the FOCUS node's question (rag._suggestion_query_text),
    # not the whole ancestor chain, so unrelated ancestors no longer pollute it. A
    # STRICTER, suggestion-only cutoff (separate from the 0.50 RAG-injection cutoff)
    # ensures only genuinely-related files surface. Distances are cosine (0=same).
    file_suggestion_suggest_max_distance: float = 0.38
    file_suggestion_suggest_margin: float = 0.05
    # Char cap for the focus-centred suggestion query (focus question + brief
    # parent context + short focus-answer head). Small on purpose (~400..500).
    file_suggestion_suggest_query_chars: int = 450

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
