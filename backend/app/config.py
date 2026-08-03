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
# Upstage·Qdrant·JUDGE 등)이 backend/.env에 있다.
BACKEND_ENV = Path(__file__).resolve().parents[1] / ".env"


class Settings(BaseSettings):
    # --- Postgres (D104: Supabase 제거) ---
    # 두 DSN이 **역할이 다르다** — 구 UserClient/ServiceClient 구분을 DB 역할로
    # 재현한 것이다. app은 RLS가 적용되고, worker는 BYPASSRLS다.
    # worker DSN이 비면 업로드·임베딩 워커가 비활성(구 service_role 부재와 동형).
    database_url: str = "postgresql://nodi_app:nodi_app_dev@localhost:5433/nodi"
    database_worker_url: str = (
        "postgresql://nodi_worker:nodi_worker_dev@localhost:5433/nodi"
    )

    # --- 자체 인증 (D104-4) ---
    # 액세스 토큰 서명 키. 운영에서는 반드시 교체한다(부팅 시 경고).
    jwt_secret: str = "dev-only-change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 12  # 수업 한 타임을 넉넉히 덮는다

    # --- 파일 저장 (D104-5) ---
    # Supabase Storage 대체. 컨테이너·경로 규약은 그대로 유지한다.
    storage_root: str = str(REPO_ROOT / "backend" / ".storage")
    # signed URL 서명 키(HMAC). 비면 jwt_secret을 쓴다.
    storage_sign_secret: str = ""

    # --- AI (Upstage) — 대화 생성 + 임베딩 + 문서 파싱 ---
    #
    # D108: 대화 생성이 EXAONE(Friendli) → Upstage solar로 옮겨졌다.
    # 실측 근거(2026-07-28, 각 3회 중앙값):
    #   도구 판단 1회 왕복  EXAONE 2.73s  vs  solar-pro2 0.78s (3.5배)
    #   개념 카드 형식 준수  둘 다 통과. 다만 EXAONE은 응답에 추론 과정을
    #                        흘렸고(포르투갈어 조각 포함) solar는 깨끗했다.
    # 임베딩·문서 파싱이 이미 Upstage라 벤더가 하나로 줄어드는 효과도 있다.
    # 교과서 도판 비전은 별도 계열(judge_* 노브)로 남는다 — 비전이 필요하고
    # 자체 GPU로 돌리므로 벤더 통합 대상이 아니다(D118). 지금 이 계열이 하는
    # 일은 캡션 생성이다(figure_caption, D131·D134). figure_judge는 설정
    # 게이트·공용 유틸만 남았고, 셋(base_url/model/api_key)이 다 채워져야
    # 동작한다(figure_judge.is_configured).
    #
    # 비대칭 임베딩: 질의 embedding-query / 문서 embedding-passage (혼용 금지).
    upstage_api_key: str = ""
    upstage_base_url: str = "https://api.upstage.ai/v1"
    upstage_chat_model: str = "solar-pro2"
    upstage_embedding_query_model: str = "embedding-query"
    upstage_embedding_passage_model: str = "embedding-passage"
    upstage_document_parse_model: str = "document-parse"
    chat_temperature: float = 0.5
    chat_max_tokens: int = 2048

    # --- ReAct 스킬 루프 (D109) ---
    # 켜면 채팅 턴이 "도구 판단 → 스킬 실행 → 생성" 2단계로 돈다. 끄면 기존
    # 단발 경로 그대로 — 되돌릴 수 있어야 실험이 가능하다.
    # 인사 같은 턴에서 질의 임베딩·Qdrant 검색이 사라지는 대신, 자료를 찾는
    # 턴은 LLM 왕복이 한 번 더 든다(설계 문서 §6-2의 트레이드).
    #
    # 기본값을 켬으로 올렸다(2026-07-28) — 실기동 검증을 마쳤다. 끄는 경로는
    # 롤백 수단으로 남긴다.
    react_enabled: bool = True
    # 도구 호출 라운드 상한. 넘으면 가진 것으로 생성 단계에 넘어간다.
    react_max_steps: int = 3

    # --- Qdrant (벡터 저장소 — pgvector 대체) ---
    # 컬렉션: file_chunks / textbook_figures (전부 upstage.EMBED_DIM, Cosine).
    # Qdrant엔 RLS가 없다 — 스코핑은 백엔드 페이로드 필터로 강제(qdrant_store).
    qdrant_url: str = "http://localhost:6333"

    # /retrieve의 EBS·아트 검색 노브는 D94(기능 제거)로 삭제됨.
    # 카드 배치·좌표는 프론트 소유(d3-force) — 서버 위치 계산 상수는 제거됨.

    # 임베딩은 Upstage embedding-passage/query + Qdrant로 완전 이전됨
    # (D80: 구 Gemini 임베딩 모델·차원 설정 키 제거).
    # Chunks per embedding_batch child job; sub-batched per embed request.
    embedding_batch_size: int = 64
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
    # 한 세션에 주입 가능한 파일 전문의 합산 문자 상한. 모델 컨텍스트
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
    # D95: 다중 표시 — config 전용(admin 오버레이 없음)
    figure_retrieve_top_k: int = 3
    figure_batch_size: int = 8                    # figure_batch 잡 팬아웃 단위
    figure_signed_url_ttl_seconds: int = 21600    # 6h — 수업 시간 내 만료 실질 배제(D87)
    # --- figure 캡션 판정(EXAONE 비전, 플러그형 D88) ---
    # env: JUDGE_BASE_URL / JUDGE_MODEL / JUDGE_API_KEY
    # D97: base_url 기본값 제거(빈 문자열). 기존 기본값은 TTA 게이트웨이 30099를
    # 가리켰으나 그 포트는 프론트엔드(Next.js 8080)로 용도가 바뀌었고 llama.cpp는
    # 8081 내부 전용으로 이동했다(docs/DEPLOYMENT.md) — 즉 **기본값이 판정과
    # 무관한 서비스를 가리키는 상태**였다. 키만 채운 신규 환경이 비전 요청을
    # 엉뚱한 곳으로 보내는 사고를 막기 위해 비우고, 두 값을 모두 명시하게 한다.
    judge_base_url: str = ""
    judge_model: str = "EXAONE-4.5-33B"
    # D93: 판정은 필수 게이트다 — 미설정이면 교과서 업로드 자체가 503으로 거부된다
    # (services/files.py). 판정 생략 폴백은 D88 시절 동작으로, 더 이상 없다.
    judge_api_key: str = ""

    # --- 강의 클립 추천 (D149) ---
    lecture_pipeline_enabled: bool = True          # 인제스트 킬 스위치
    # 직접(본문) 거리 게이트. 0.55였는데 실측에서 정직하게 관련 있는 클립이
    # 떨어졌다 — "측정 표준이 왜 필요해?" ↔ 「국제단위계(SI)와 측정 표준」이
    # 0.588. 청크·도판이 쓰는 0.60에 맞춘다(D163).
    lecture_retrieve_max_distance: float = 0.60
    lecture_atom_enabled: bool = True              # PIKE 원자화+이중 검색
    lecture_atom_max_distance: float = 0.45        # 원자(질문) 거리 게이트
    lecture_atoms_per_clip: int = 4                # 클립당 생성 질문 수
    lecture_atom_concurrency: int = 4              # solar 동시 호출
    lecture_atom_model: str = "solar-pro3"         # 원자 생성 모델(config/env 전용)
    lecture_retrieve_top_k: int = 3                # 추천 개수(config 전용)
    lecture_batch_size: int = 16                   # 임베딩/원자 잡 팬아웃 단위
    # 자동 전사(개정 R2) — 업로드 자막이 없으면 EBS 오디오를 Whisper로 전사.
    lecture_whisper_enabled: bool = True           # 자막 없을 때 자동 전사(오버레이 폴백 가능)
    lecture_whisper_model: str = "small"           # faster-whisper 모델(config/env 전용)
    lecture_whisper_language: str = "ko"           # 전사 언어(config/env 전용)
    lecture_whisper_ffmpeg_timeout_seconds: int = 900  # ffmpeg 스트림·추출 상한

    # ── PIKE-RAG (TASK 6, D129~D132) ─────────────────────────────
    # A. 지식 원자화 (D129) — 킬스위치 off 출하, 캘리브레이션 후 on
    atom_rag_enabled: bool = False
    atom_questions_per_chunk: int = 3      # 청크당 예상 질문 수(비용 직결)
    atom_top_k: int = 5                    # chunk_atoms 컬렉션 top-K
    atom_rag_max_distance: float = 0.45    # 원자 거리 게이트(질문↔질문 — 실측 후 조정)
    atom_gen_concurrency: int = 4          # solar 동시 호출
    atom_batch_size: int = 16              # atom_batch 팬아웃 단위(스테일 120s 여유)
    # C. 질문 정제 (D130)
    rag_query_rewrite_enabled: bool = False
    # D. figure 캡션 비전 생성 (D131·D134 — 생성 단독, 노브 없음)
    figure_page_text_max_chars: int = 4000  # 비전 프롬프트 페이지 컨텍스트 절단
    # B. LLM 의미 청킹 (D132)
    semantic_chunking_enabled: bool = False
    semantic_chunking_max_chars: int = 120_000   # 초과 문서는 통째로 정규식 폴백
    semantic_chunking_max_llm_calls: int = 120   # 경계 판단 콜 수 2차 가드

    # --- App ---
    cors_origins: list[str] = ["http://localhost:3000"]
    environment: str = "development"

    model_config = SettingsConfigDict(
        env_file=str(BACKEND_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def sign_secret(self) -> str:
        """파일 signed URL 서명 키 — 미지정이면 jwt_secret을 공용한다."""
        return self.storage_sign_secret or self.jwt_secret


@lru_cache
def get_settings() -> Settings:
    return Settings()
