import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 클라우드 VM은 외부 포트를 하나만 열어준다. 브라우저는 항상 이 Next.js
  // 서버에만 말하고, /api/* 요청만 내부 FastAPI(8000)로 서버 사이드 프록시한다.
  //
  // D105: 접두사를 **벗기지 않는다.** 백엔드가 /api를 직접 갖게 되면서
  // 경로가 양쪽에서 같아졌다 — 예전에는 여기서 /api를 떼고 넘겨서
  // 로컬(:8000 직접)과 배포(/api 경유)의 경로가 갈라져 있었다.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://localhost:8000/api/:path*" }];
  },
};

export default nextConfig;
