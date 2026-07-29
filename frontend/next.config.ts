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
      // prefix 없이 include한다). 외부 업타임 감시가 칠 수 있게 이것만 연다 —
      // 응답이 상태·서비스명·환경뿐이다.
      //
      // **`/health/config`는 일부러 빼 뒀다.** 한 번 `/health/:path*`로 열었다가
      // 되돌렸다: 비밀값은 없어도 `secret_is_default`·`jwt_algorithm`·내부
      // 경로·모델명이 인증 없이 나가 정찰 정보가 된다. 콘솔은 관리자 인증을
      // 거치는 `/api/admin/env`로 같은 내용을 받는다. 서버에서 볼 때는
      // `curl localhost:8000/health/config`.
      { source: "/health", destination: `${backend}/health` },
    ];
  },
};

export default nextConfig;
