import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 클라우드 VM은 외부 포트를 30099→8080 하나만 열어준다. 브라우저는 항상
  // 이 Next.js 서버(8080)에만 말하고, /api/* 요청만 내부 FastAPI(8000)로
  // 서버 사이드 프록시한다 — 백엔드 라우터 prefix(/home,/admin,/teacher)가
  // 프론트 페이지 경로와 겹치므로 공통 접두사 없이 직접 리라이트할 수 없다.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://localhost:8000/:path*" }];
  },
};

export default nextConfig;
