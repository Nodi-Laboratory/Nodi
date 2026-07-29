# Nodi 프론트엔드 (Next.js 16)
#
# 단일 스테이지다. standalone 출력을 쓰면 이미지가 훨씬 작아지지만
# next.config.ts에 `output` 설정을 넣어야 하고, 그 파일은 지금 팀원들이
# 함께 만지는 파일이라 변경을 최소로 뒀다. 크기가 문제가 되면 그때 바꾼다.
FROM node:22-alpine

WORKDIR /app

# 의존성 먼저 — 소스가 바뀌어도 이 레이어는 캐시된다.
# package-lock.json 그대로 설치한다(npm ci) — 로컬과 같은 버전이 들어간다.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* 는 **빌드 시점에 번들에 박힌다.** 런타임 환경변수로는 못 바꾼다.
# 기본값 `/api`는 브라우저가 이 Next 서버에만 말하고, /api/* 만 next.config.ts의
# rewrite가 내부 백엔드로 넘긴다는 뜻이다 — 외부에 포트를 하나만 열면 된다.
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

# BACKEND_ORIGIN도 **빌드 시점** 값이다. next.config.ts의 rewrites()는 빌드 때
# 평가돼 routes-manifest.json에 박히므로 런타임 환경변수로는 못 바꾼다(실측).
# 기본값은 compose 네트워크의 서비스명 — 다른 곳에 붙이려면 build arg로 준다.
ARG BACKEND_ORIGIN=http://backend:8000
ENV BACKEND_ORIGIN=$BACKEND_ORIGIN

RUN npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["npm", "start"]
