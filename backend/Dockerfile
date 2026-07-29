# Nodi 백엔드 (FastAPI + 업로드 워커)
#
# 워커는 별도 컨테이너가 아니다 — services/worker/ 잡이 앱 프로세스 안에서
# 돈다(README "앱 프로세스 안에서 돈다"). 그래서 서비스가 하나뿐이다.
#
# 빌드: docker compose --profile app build backend
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# uv가 시스템 파이썬이 아니라 /app/.venv를 쓰게 고정한다. 컨테이너 안이라
# 가상환경이 없어도 되지만, 있어야 uv sync의 --frozen 검증 경로가 로컬과 같다.
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# 의존성만 먼저 — app/ 이 바뀌어도 이 레이어는 캐시에서 재사용된다.
# uv.lock 그대로 설치하므로(--frozen) 로컬과 같은 버전이 들어간다.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 애플리케이션 코드. 테스트(tests/)는 이미지에 넣지 않는다 — .dockerignore 참고.
COPY app ./app
RUN uv sync --frozen --no-dev

# 업로드 원본 저장소(D104-5, 구 Supabase Storage). compose가 볼륨을 여기 붙이고
# STORAGE_ROOT로 같은 경로를 넘긴다 — 컨테이너를 지워도 파일이 남는다.
RUN mkdir -p /data/storage
ENV STORAGE_ROOT=/data/storage

EXPOSE 8000

# /health 는 인증 없이 열려 있고 외부 호출을 하지 않는다(routers/health.py).
# curl을 따로 깔지 않으려고 파이썬으로 친다.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
    CMD python -c "import urllib.request as u; u.urlopen('http://localhost:8000/health').read()" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
