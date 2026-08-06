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
    #
    # 2026-08-04: 대화 생성 모델을 solar-pro2 → solar-pro3으로 올렸다(사용자
    # 지시). 이 값은 판단 단계(solar.complete)와 생성 단계(solar.stream_answer)를
    # 모두 지배한다 — 개념 카드 형식은 생성 단계 프롬프트가 강제하므로 모델을
    # 바꾸면 형식 준수를 다시 확인해야 한다. 인제스트 시점 LLM 작업(원자 질문
    # D129·의미 청킹 D132)도 solar.complete를 재사용하므로 함께 바뀐다.
    # 강의 클립 원자화만 자기 노브(lecture_atom_model)로 따로 간다.
    upstage_api_key: str = ""
    upstage_base_url: str = "https://api.upstage.ai/v1"
    upstage_chat_model: str = "solar-pro3"
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
    # D195: 잡 하나가 맡는 청크 수. 이 안에서 요청 크기(Upstage 상한 100)로
    # 다시 쪼개 **동시에** 보내므로, 잡을 잘게 나눌 이유가 사라졌다. 64였을 때는
    # 잡 하나 = 요청 하나였고, 잡은 폴 주기(5초)·워커 동시성(3)에 묶여 있어
    # 청크 5,000개짜리 교과서가 79잡 = 최소 27폴 = 큐에서만 135초였다.
    # 300 = 요청 3건(100×3)이라 아래 동시성 4 안에 한 번에 들어간다.
    embedding_batch_size: int = 300
    # D195: 잡 하나가 동시에 띄우는 임베딩 요청 수. 실제 동시 요청은
    # 워커 동시성(3) × 이 값이다 — Upstage 429가 잦으면 낮춘다.
    embedding_request_concurrency: int = 4
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
    # 한 세션에 주입 가능한 파일 전문의 합산 문자 상한. 판정은 워커 저장 시점
    # (초과 거부) + 주입 시점 이중 방어. clamp 10_000~180_000 (as_int 호출부와 동기).
    #
    # D195: **문자를 세는 이유는 토큰을 셀 수 없어서다.** 어림이 필요한데,
    # 옛 주석의 어림("150K자 ≈ 75K~150K 토큰")은 실측과 두 배 어긋났다.
    # solar-pro3 실물 호출로 usage.prompt_tokens를 재서 다시 잡았다
    # (2026-08-06, 각 1만 자):
    #
    #     한국어 교과서 문어체  2.31자/토큰   (가장 빽빽하다)
    #     한국어 학생 구어체    3.10자/토큰
    #     영어·수식 섞임        3.98자/토큰
    #
    # 최악(2.31)으로 150K자 = 약 65K 토큰이고, solar-pro3 컨텍스트는
    # **131,072 토큰**이다 — 딱 절반이다. 나머지 절반이 무트리밍 히스토리 ·
    # 학급 자료 RAG · 시스템 프롬프트 · 추론 토큰 · 답변의 몫이라 기본값은
    # 그대로 둔다. 바꾼 것은 **상한**이다: 옛 clamp 300_000은 최악 입력에서
    # 130K 토큰 ≈ 윈도 전부라, 운영자가 노브를 끝까지 올리면 파일만으로
    # 컨텍스트가 차서 히스토리도 답변도 들어갈 자리가 없었다.
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

    # --- 손글씨 OCR (D176) ---
    # VARCO-VISION-2.0-1.7B-OCR 서버(FastAPI, 인증 없음). 프롬프트창의 펜 입력이
    # 여기로 그림을 보내 글자를 받는다.
    #
    # **주소 기본값은 judge_base_url에서 끌어온다** (사용자 지시 2026-08-04):
    # 두 모델이 **같은 기계의 다른 GPU**에 떠 있어(비전 GPU0/llama.cpp,
    # OCR GPU1) 호스트가 늘 같다. 배포마다 IP를 두 번 적게 하면 한쪽만 바뀐 채
    # 남는다 — judge가 사는 호스트의 ocr_port로 유도하고, 다른 기계로 옮길 때만
    # OCR_BASE_URL로 덮는다(services/ocr.py resolve_base_url).
    ocr_enabled: bool = True                       # 킬 스위치(모델 서버 점검 등)
    ocr_base_url: str = ""                         # env OCR_BASE_URL. 비면 judge 호스트 유도
    # 유도 시 붙일 포트. **내부 포트(8083)다** (D177).
    #
    # 문서 표의 30020은 **외부 포워딩**용이다(8083 → 30020). 백엔드는 모델
    # 서버와 **같은 기계**에서 부르므로(유도의 전제가 그것이다) 포워딩을 거칠
    # 이유가 없고, 실제로 30020은 기계 안에서 열려 있지도 않다 —
    # 실측 2026-08-05: `All connection attempts failed`로 프로덕션에서 손글씨
    # 인식이 통째로 죽어 있었다. 밖에서 부를 일이 생기면 OCR_BASE_URL로 덮는다.
    ocr_port: int = 8083
    # 문서 권장 2048. 한 줄 질문은 수십 토큰이면 끝나지만 **부족하면 출력이
    # 중간에 잘린다**(문서 경고). 여러 줄을 살리게 되면서(D177) 길어질 여지가
    # 커져 관리자 노브로 뺐다 — 잘리는 것이 GPU를 조금 더 무는 것보다 나쁘다.
    ocr_max_new_tokens: int = 1024
    ocr_max_image_bytes: int = 8 * 1024 * 1024     # 입력판 PNG는 보통 수십 KB
    # 문서 실측 6~8초. 자리를 잡은 **뒤**의 한 건 상한이다(대기는 아래 큐 몫).
    ocr_timeout_seconds: int = 45
    # 모델 서버는 **GPU 락으로 요청을 직렬 처리한다**(문서). 그래서 우리가 더
    # 많이 밀어 넣어도 처리량은 안 늘고 모두의 대기만 길어진다 — 들어가는 수를
    # 우리 쪽에서 막고, 자리를 못 잡으면 **빨리 포기하고 안내한다**(D177).
    ocr_max_concurrent: int = 2
    # 자리를 기다리는 상한. 넘으면 "지금 붐빈다"고 알린다 — 학생을 90초 세워
    # 놓고 결국 실패시키는 것보다 낫다.
    ocr_queue_timeout_seconds: int = 15

    # --- 펜 표시 해석 (D178) ---
    # D176은 손글씨를 글자로 바꿨지만 학생이 그은 **화살표는 아무 데도 가지
    # 않았다** — "이거에 대해서 설명해줘"만 도착하고 "이거"가 사라진다. 질문 획
    # 주변의 카드를 함께 읽어 그 지시대상을 살린다.
    #
    # 비전 모델은 judge_* 계열을 그대로 재사용한다(같은 기계 GPU 0, llama.cpp).
    # OCR은 GPU 1이라 둘이 **실제로 병렬로** 돈다.
    ink_vlm_enabled: bool = True
    # 끌어올 카드 상한. 많아지면 SOLAR가 받는 본문이 부풀고 화살표의 의미가 묻힌다.
    ink_card_max: int = 5
    # 근접 판정 반경(월드 px). 화살표 없이 카드 옆에 질문만 쓰는 것이 **가장
    # 흔한 사용법**이라, 이 단이 없으면 그 경우가 통째로 빈손이 된다.
    ink_near_pad: int = 120
    # 상자가 원본 획 bbox의 몇 배까지 커질 수 있나. **클램프가 없으면** 카드를
    # 끌어온 만큼 상자가 커지고, 한 변 상한 때문에 배율이 줄어 **정작 화살표가
    # 몇 픽셀로 뭉개진다** — 기능이 안 되는 게 아니라 그럴싸하게 틀린다.
    ink_box_max_scale: float = 2.5
    ink_figure_zoom_enabled: bool = True
    ink_vlm_timeout_seconds: int = 30
    ink_card_body_max_chars: int = 1200
    ink_scene_max_side: int = 1280

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
    # D190: **개념 카드 하나에 영상 하나**(사용자 지시 2026-08-06). 카드가
    # 정사각형 썸네일 카드가 되면서 여러 개가 붙으면 답보다 곁다리가 커진다.
    lecture_retrieve_top_k: int = 1                # 카드당 추천 개수
    # --- D194 질문 방향성 코치 ---------------------------------------------
    # 사용자 인터뷰의 공통 문제("스스로 질문하기가 안 된다")에 대한 장치.
    # 예시 질문을 주지 않고 **방향만** 말한다 — 베낀 질문은 자기 질문이 아니다.
    question_coach_enabled: bool = True
    # n — 이 수만큼 쌓인 브랜치에 하나 더 이어지면(n+1) 말을 건다.
    # 재발동 간격(n+3)은 여기서 파생된다(따로 만지게 하지 않는다).
    question_coach_min_cards: int = 3
    # 판정 모델. 방향 낱말 몇 개를 고르는 일이라 가벼운 모델로 충분하다(D182 동형).
    question_coach_model: str = "solar-pro2"

    lecture_batch_size: int = 16                   # 임베딩/원자 잡 팬아웃 단위
    # 자동 전사(개정 R2) — 업로드 자막이 없으면 EBS 오디오를 Whisper로 전사.
    lecture_whisper_enabled: bool = True           # 자막 없을 때 자동 전사(오버레이 폴백 가능)
    lecture_whisper_model: str = "small"           # faster-whisper 모델(config/env 전용)
    lecture_whisper_language: str = "ko"           # 전사 언어(config/env 전용)
    lecture_whisper_ffmpeg_timeout_seconds: int = 900  # ffmpeg 스트림·추출 상한

    # ── 교차 세션 개념 연결 (D176) ────────────────────────────────
    # 거리는 상한이 아니라 **띠**다. 너무 가까운 히트는 융합이 아니라 중복이라
    # 바닥 아래는 버린다("어제도 광합성, 오늘도 광합성").
    # 숫자는 **실측이다**(2026-08-04, embedding-query/passage, 한국어 개념 카드):
    #   중복(같은 주제 다른 표현) 0.347 · 융합(다른 과목, 축 공유) 0.567~0.686 ·
    #   남남 0.880~0.904. 처음 눈대중으로 잡았던 0.20~0.38은 **중복만 걸리고
    #   융합은 전부 놓치는** 값이었다 — 재 보지 않았으면 기능이 한 번도 안 떴다.
    # D181: 전용 OCR GPU가 내려갔을 때 비전 모델로 손글씨를 읽는 예비 경로.
    # **예비이지 대체가 아니다** — 언제나 VARCO를 먼저 부르고, 그쪽이 못 받을
    # 때만 쓴다(범용 비전은 안 쓴 글자를 지어낼 여지가 더 크다).
    ocr_vision_fallback_enabled: bool = True

    crosslink_enabled: bool = True
    # 거리 띠는 **실측으로 그었다** (2026-08-06, embedding-passage 실물 호출).
    # 세 갈래를 각각 여러 쌍 재 보니 깨끗하게 갈렸다:
    #
    #   중복(같은 주제를 다르게 쓴 것)  0.223 ~ 0.347
    #   연결(과목은 다른데 이어지는 것)  0.500 ~ 0.618   ← 배지가 떠야 하는 구간
    #   남남(아무 상관 없는 것)          0.693 ~ 0.765
    #
    # 옛 천장 0.72는 **남남을 통과시켰다**("광합성 ↔ 시의 운율" 0.693,
    # "판 구조론 ↔ 현재완료" 0.719). 지금은 각 구간 사이 빈 곳의 가운데다.
    crosslink_min_distance: float = 0.42   # 이보다 가까우면 같은 얘기 — 버린다
    crosslink_max_distance: float = 0.66   # 이보다 멀면 남남
    crosslink_top_k: int = 8               # 검색 폭(링크는 통과한 첫 1개만)

    # ── 캔버스 화면 동작 (D174) ───────────────────────────────────
    # 지금까지 프론트에 상수로 박혀 있어 **관리자가 아무것도 못 만졌다.**
    # 서버가 값을 갖고 `GET /settings/client`로 내려보낸다.
    canvas_cards_per_turn: int = 1         # 한 턴에 만들 개념 카드 수 (D162)
    canvas_type_chars_per_frame: int = 2   # 글자 나오는 속도(프레임당 글자 수)
    canvas_focus_zoom: float = 2.35        # 새 카드로 확대할 배율 **상한** (D166)
    canvas_map_node_zoom: float = 1.8      # 지도에서 노드·간선이 보이기 시작하는 배율
    canvas_connectors_default_on: bool = True  # 캔버스 연결선 기본 표시 (D151)
    canvas_col_gap: int = 760              # 태그 열 사이 간격
    canvas_row_gap: int = 240              # 부모–자식 세로 간격
    canvas_sib_gap: int = 200              # 형제 서브트리 좌우 간격
    # 상시 켜기 (D172) — 거리 띠를 무시하고 가장 가까운 후보를 무조건 잇는다.
    # **테스트용이다.** 켜 두면 "드물게"라는 성질이 사라진다.
    crosslink_always_on: bool = False
    # D182: 관련성 판정은 **가벼운 모델**로 (사용자 지시 2026-08-06).
    # 배지 하나에 대화 생성과 같은 모델을 쓸 이유가 없다 — 하는 일은 "이 둘이
    # 실제로 이어지나"라는 예/아니오 판단과 두어 문장이다. 빈 문자열이면 전역
    # 채팅 모델을 그대로 쓴다(옛 동작).
    crosslink_model: str = "solar-pro2"

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
