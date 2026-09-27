# Nodi 백엔드 이미지 (공개판 docker compose용)
#
# ⚠️ 배포 서버는 이 이미지를 쓰지 않는다(D116 — 컨테이너 불가 샌드박스,
# deploy/deploy.sh가 호스트에서 uv sync). 이건 `git clone → docker compose up`
# 한 번으로 앱 전체를 띄우는 공개판 경로 전용이다.
#
# 2단계로 나눈 이유: uv·빌드 캐시는 설치에만 필요하다. 런타임에는 완성된
# venv만 복사해 이미지를 줄이고, 빌드 도구가 실행 이미지에 남지 않게 한다.

# ---------------------------------------------------------------------------
# 1. builder — uv.lock 그대로 venv를 만든다
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

# 컨테이너 안에서 파이썬을 새로 받지 않고 이미지의 3.12를 쓴다.
# copy 모드: 캐시 마운트에서 하드링크를 걸면 런타임 단계로 복사할 때 깨진다.
ENV UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /src

# 의존성 층을 먼저 — 앱 코드만 바뀌면 이 층은 캐시로 넘어간다.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# 프로젝트 자체(app 패키지)를 설치한다. --frozen: lock과 어긋나면 실패시킨다
# — 배포 서버(deploy.sh)와 같은 규약이라 로컬·서버·컨테이너 의존성이 같다.
COPY app ./app
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# ---------------------------------------------------------------------------
# 2. runtime — venv + 앱 코드만
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 비루트로 돈다. 업로드 파일이 쌓이는 STORAGE_ROOT(/data/storage)는 named
# volume이라, 이미지 안에서 미리 만들고 소유권을 줘야 볼륨 첫 생성 시 그
# 소유권이 복사된다(빈 볼륨은 마운트 지점의 권한을 물려받는다).
RUN groupadd --system --gid 10001 nodi \
    && useradd --system --uid 10001 --gid nodi --home-dir /app --shell /usr/sbin/nologin nodi \
    && mkdir -p /data/storage \
    && chown -R nodi:nodi /data

WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
COPY --chown=nodi:nodi app ./app
COPY --chown=nodi:nodi docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 윈도우에서 클론하면 CRLF가 섞일 수 있다(.gitattributes가 막지만 이중 방어).
# CRLF 셔뱅은 "no such file or directory"로만 죽어 원인을 찾기 어렵다.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER nodi
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
