import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 클라우드 VM은 외부 포트를 하나만 열어준다. 브라우저는 항상 이 Next.js
  // 서버에만 말하고, /api/* 요청만 내부 FastAPI(8000)로 서버 사이드 프록시한다.
  //
  // D105: 접두사를 **벗기지 않는다.** 백엔드가 /api를 직접 갖게 되면서
  // 경로가 양쪽에서 같아졌다 — 예전에는 여기서 /api를 떼고 넘겨서
  // 로컬(:8000 직접)과 배포(/api 경유)의 경로가 갈라져 있었다.
  //
  // 백엔드 주소는 BACKEND_ORIGIN으로 덮어쓸 수 있다. 안 넣으면 기존과 같다
  // — 배포 서버도 백엔드가 같은 호스트의 127.0.0.1:8000이라 기본값이 맞다.
  // 포트를 바꾸거나 백엔드를 다른 호스트로 뺄 때만 지정한다.
  //
  // ⚠️ rewrites()는 **빌드 시점에 평가돼 routes-manifest.json에 박힌다.**
  // 런타임 환경변수로는 안 바뀐다(실측). 값을 바꾸려면 넣은 채로
  // `npm run build`를 다시 돌려야 한다 — 재시작만으로는 반영되지 않는다.
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
      // D116: `/health`는 **`/api` 밖**이다(인프라 liveness 계약, main.py가
      // prefix 없이 include한다). 운영 콘솔의 "환경" 카드가 이걸 부르는데,
      // 같은 출처로 배포하면 API_BASE가 `/api`라 root가 빈 문자열이 되고
      // `/health/config`가 Next로 떨어져 404였다. 로컬에서는 API_BASE가
      // `http://localhost:8000/api`라 백엔드로 직행해 드러나지 않았다.
      //
      // 비밀값은 담기지 않는다 — 존재 여부(bool)와 비밀이 아닌 URL·모델명뿐이고
      // 외부 호출도 하지 않는다(routers/health.py).
      { source: "/health/:path*", destination: `${backend}/health/:path*` },
      { source: "/health", destination: `${backend}/health` },
    ];
  },
};

export default nextConfig;
