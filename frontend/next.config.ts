import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 클라우드 VM은 외부 포트를 하나만 열어준다. 브라우저는 항상 이 Next.js
  // 서버에만 말하고, /api/* 요청만 내부 FastAPI(8000)로 서버 사이드 프록시한다.
  //
  // D105: 접두사를 **벗기지 않는다.** 백엔드가 /api를 직접 갖게 되면서
  // 경로가 양쪽에서 같아졌다 — 예전에는 여기서 /api를 떼고 넘겨서
  // 로컬(:8000 직접)과 배포(/api 경유)의 경로가 갈라져 있었다.
  //
  // D115: 백엔드 주소를 환경변수로 뺀다. 컨테이너 안에서는 localhost가
  // **프론트 컨테이너 자신**이라 백엔드에 닿지 못한다 — 이미지를 빌드할 때
  // BACKEND_ORIGIN=http://backend:8000 을 넣는다. 안 넣으면 기존과 같다.
  //
  // ⚠️ rewrites()는 **빌드 시점에 평가돼 routes-manifest.json에 박힌다.**
  // 런타임 환경변수로는 안 바뀐다 — 실측으로 확인했다(컨테이너에 런타임으로만
  // 넣었더니 그대로 localhost:8000으로 나가 ECONNREFUSED). 그래서
  // frontend/Dockerfile이 이 값을 build ARG로 받는다.
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
};

export default nextConfig;
