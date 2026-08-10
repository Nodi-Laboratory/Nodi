import os from "node:os";
import type { NextConfig } from "next";

/**
 * dev 서버를 **LAN 주소로 열 때** 허용할 출처 (2026-08-04).
 *
 * Next 16은 `/_next/*`(HMR 웹소켓·dev 자산)를 기본적으로 localhost에서만
 * 받는다. 다른 기기가 `http://10.x.x.x:3000`으로 들어오면 그 요청만 조용히
 * 막히는데, **증상은 "로그인이 안 된다"로 나타난다** — HTML은 그려지므로
 * 화면은 멀쩡해 보이고, 클라이언트 번들이 못 붙어 **하이드레이션이 안 되니**
 * 입력이 React state에 닿지 않아 버튼이 영영 비활성이다(실측: 같은 페이지가
 * localhost에서는 활성, LAN IP에서는 비활성).
 *
 * 그래서 **이 기계의 LAN IPv4를 자동으로 넣는다.** 손으로 적으면 DHCP로 주소가
 * 바뀔 때마다 같은 증상이 다시 나고, 그때는 원인을 처음부터 다시 찾게 된다.
 * 도메인이나 다른 주소가 필요하면 `DEV_ORIGINS=a.test,192.168.0.5`로 더한다.
 *
 * dev 전용 설정이라 프로덕션 빌드에는 영향이 없다.
 */
function devOrigins(): string[] {
  const origins = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const ni of entries ?? []) {
      if (ni.family === "IPv4" && !ni.internal) origins.add(ni.address);
    }
  }
  for (const extra of (process.env.DEV_ORIGINS ?? "").split(",")) {
    const value = extra.trim();
    if (value) origins.add(value);
  }
  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),

  /**
   * dev 표시기를 **끈다** (2026-08-10).
   *
   * Next의 개발 표시기는 화면 **왼쪽 아래**에 뜬다 — 우리 사이드바의 [도움말]
   * 버튼이 정확히 그 자리다. 그래서 로컬에서 도움말을 누르면 그 표시기가
   * 클릭을 먹고, e2e는 `<nextjs-portal> intercepts pointer events`로 멈춘다
   * (실측 2026-08-10).
   *
   * 컴파일 상태·오류 개수를 그 배지로 보던 것은 아쉽지만, **오류 0건은 이미
   * 스펙이 지킨다**(J98: 주요 흐름에서 콘솔 오류가 0건이다). 프로덕션에는
   * 애초에 없는 것이라 잃는 것도 dev 편의뿐이다.
   */
  devIndicators: false,

  experimental: {
    /**
     * 프록시가 버퍼링하는 요청 본문의 상한 (D184).
     *
     * ## 이게 없으면 교과서 업로드가 통째로 막힌다
     *
     * Next 16은 프록시를 지날 때 본문을 메모리에 버퍼링하고 **기본 10MB에서
     * 자른다.** 자르고 나서 요청을 실패시키지도 않는다 — 잘린 몸통을 그대로
     * 백엔드로 보내다 연결이 끊긴다. 서버 로그에 남은 그림(2026-08-06):
     *
     *     Request body exceeded 10MB for /api/files.
     *     Failed to proxy http://127.0.0.1:8000/api/files Error: socket hang up
     *
     * **백엔드 로그에는 POST가 한 줄도 없었다.** 교사 화면에서는 "업로드 실패"
     * 한 줄만 뜨고, 어디서 죽었는지 알 방법이 없다. `files` 테이블이 비어
     * 있는 것으로만 확인됐다.
     *
     * ## 왜 512MB인가
     *
     * 상한을 정하는 곳은 **백엔드 하나여야 한다**(D77 — 교사 자료·교과서
     * 500MB, `resolve_upload_max_bytes`의 clamp 천장이 512MB). 프록시가 더
     * 좁으면 백엔드의 한국어 사유("500MB까지 올릴 수 있습니다")가 학생·교사에게
     * 영영 닿지 않고 연결만 끊긴다. 그래서 여기는 **백엔드보다 넓게** 두고
     * 판정은 넘긴다.
     *
     * 메모리는 이 배포에서 문제가 아니다(서버 RAM 885GB, 요청당 적용).
     * 좁은 기계로 옮긴다면 이 값과 D77 노브를 함께 내려야 한다.
     *
     * ⚠️ 이걸 고쳐도 **Cloudflare 무료 플랜은 요청 본문을 100MB로 자른다.**
     * 지금 접속은 Cloudflare Tunnel을 지나므로 그보다 큰 교과서는 엣지에서
     * 413으로 막힌다 — 그건 코드로 못 넘고 플랜이나 경로를 바꿔야 한다.
     */
    proxyClientMaxBodySize: "512mb",
  },

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
