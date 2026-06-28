"""Application settings.

Loads configuration from the repository ROOT `.env` (one level above `backend/`).
Secrets are never hardcoded — pydantic-settings reads them from env / .env.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> parents[0]=app, [1]=backend, [2]=repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT_ENV = REPO_ROOT / ".env"


class Settings(BaseSettings):
    # --- Supabase ---
    supabase_url: str = ""
    supabase_project_ref: str = ""
    # JWKS endpoint used to verify ES256-signed user JWTs.
    supabase_jwks_url: str = ""
    supabase_anon_key: str = ""
    # Optional in Stage 0 — server-side privileged ops. App must boot without it.
    supabase_service_role_key: str = ""

    # --- AI (Gemini) ---
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

    # --- Navigator (architecture §7; admin-tunable later) ---
    gemini_navigator_model: str = "gemini-2.5-flash"
    navigator_question_count: int = 3  # questions per navigator fire
    navigator_gate_k: int = 3  # min real nodes on the branch to consider firing
    navigator_gate_c: int = 1  # min shared tags on the branch to fire
    # Space firings along a branch: eligible at K, K+period, K+2*period, ...
    navigator_period: int = 3

    # --- ReAct budget (runaway guard) ---
    react_max_steps: int = 5
    react_max_tokens: int = 100_000

    # --- Memory linking (Stage 3a) ---
    # Cap imported (other-branch) nodes injected as reference context per turn.
    memory_max_imported_nodes: int = 12
    # Truncate each imported answer in the reference block (char budget).
    memory_answer_char_cap: int = 400

    # --- File RAG embeddings (Stage 3b-1) ---
    # NOTE: text-embedding-004 is unavailable on this API key; gemini-embedding-001
    # is the current model and supports output_dimensionality (768 here -> the
    # file_chunks.embedding vector(768) column). Reduced dims are not pre-
    # normalized, so the worker L2-normalizes before storing.
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimension: int = 768
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

    # --- RAG polish (Stage 3b-3) ---
    # Multimodal model for image OCR (text extraction from images / scans).
    ocr_model: str = "gemini-2.5-flash"
    # File-suggestion ("연결할까요?") tuning.
    file_suggestion_top_n: int = 3  # files proposed
    file_suggestion_search_k: int = 20  # chunks scanned before grouping by file
    file_suggestion_query_chars: int = 1500  # branch text used as the query
    # D48 content gate (relaxed from D37's 40): a SAFETY FLOOR only — block
    # empty/whitespace-only branch queries. Greetings/small-talk are now caught
    # by the conservative stoplist (_greeting_only) and, decisively, by the
    # distance cutoff + margin below — NOT by a blunt length gate (which used to
    # false-negative short-but-real questions like "미분이 뭐야?").
    file_suggestion_min_query_chars: int = 10
    # D28: cosine-distance cutoff for "이 자료 연결할까요?" — 0.50 (was 0.75, which
    # let near-everything through given the 768-d L2-normalized embedding's
    # unrelated-pair distance ≈ 0.55..0.75). Admin-tunable via app_settings
    # (`file_suggestion_max_distance`); this is the fallback default.
    file_suggestion_max_distance: float = 0.50
    # Margin gate: only surface a suggestion when the BEST candidate is at least
    # this much INSIDE the cutoff (best_distance <= cutoff - margin), i.e. only
    # confident matches — borderline ones are not proposed.
    file_suggestion_margin: float = 0.05

    # --- App ---
    # Postgres role embedded in Supabase user JWTs (NOT the app role).
    jwt_audience: str = "authenticated"
    cors_origins: list[str] = ["http://localhost:3000"]
    environment: str = "development"

    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV),
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
