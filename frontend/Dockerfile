# Nodi 프론트엔드 이미지 (공개판 docker compose용)
#
# ⚠️ 배포 서버는 이 이미지를 쓰지 않는다(D116 — deploy/deploy.sh가 호스트에서
# `npm ci && next build` 후 `next start`). 공개판 `docker compose up` 전용이다.
#
# 3단계: deps(npm ci) → builder(next build, standalone) → runtime(node server.js).
# runtime에는 standalone이 추려 준 node_modules만 들어가 node_modules 전체를
# 싣지 않는다.

# ---------------------------------------------------------------------------
# 1. deps — lock 그대로 설치 (package*.json만 바뀌지 않으면 캐시)
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. builder — next build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# ⚠️ 이 둘은 **빌드 시점에 박힌다** — 런타임 환경변수로는 안 바뀐다.
#   NEXT_PUBLIC_API_BASE_URL  클라이언트 번들에 인라인된다. `/api`(같은 출처)여야
#                             httpOnly 인증 쿠키가 붙는다.
#   BACKEND_ORIGIN            next.config.ts의 rewrites()가 routes-manifest에 굳힌다.
#                             compose 네트워크 안의 백엔드 서비스 이름이다.
ARG NEXT_PUBLIC_API_BASE_URL=/api
ARG BACKEND_ORIGIN=http://backend:8000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    BACKEND_ORIGIN=$BACKEND_ORIGIN \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# 3. runtime — standalone server.js
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ARG BACKEND_ORIGIN=http://backend:8000
# BACKEND_ORIGIN은 런타임에도 필요하다 — 채팅 SSE 프록시
# (src/app/api/chat/stream/route.ts)가 요청마다 process.env에서 읽는다.
# HOSTNAME=0.0.0.0: standalone server.js는 기본으로 컨테이너 호스트명에만
# 바인드해 포트 매핑으로 들어온 요청을 못 받는다.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    BACKEND_ORIGIN=$BACKEND_ORIGIN \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# standalone은 public/·.next/static을 담지 않는다(CDN에 따로 올리라는 전제).
# 우리는 같은 서버가 서빙하므로 직접 옆에 복사한다 — 빠뜨리면 CSS·JS가 404다.
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
