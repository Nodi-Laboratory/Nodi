/**
 * 채팅 SSE 프록시 (D116).
 *
 * `next.config.ts`의 `rewrites()`로 넘기면 **스트림이 버퍼링된다.** 토큰이
 * 하나씩 흘러야 개념 카드가 손글씨처럼 그려지는데, 응답이 다 끝난 뒤 한꺼번에
 * 떨어져 화면이 멈춘 것처럼 보인다.
 *
 * 실측(같은 질문, 토큰 도착 시각의 확산):
 *   백엔드 직접 :8000    0.54s  ← 정상 스트리밍
 *   rewrites 경유 :3000  0.00s  ← 전부 동시 도착
 *
 * 로컬 개발에서는 브라우저가 `NEXT_PUBLIC_API_BASE_URL`로 백엔드에 직접 붙어
 * 드러나지 않았다. 배포는 같은 출처(`/api`)라 rewrites를 타면서 나타났다.
 *
 * 이 파일이 있으면 `/api/chat/stream`은 rewrites보다 먼저 잡힌다(기본
 * rewrites는 `afterFiles`라 파일 시스템 라우트가 우선). 나머지 `/api/*`는
 * 그대로 rewrites가 처리한다 — 스트리밍이 아닌 요청은 문제가 없다.
 */
import { type NextRequest } from "next/server";

const BACKEND = process.env.BACKEND_ORIGIN ?? "http://localhost:8000";

// 스트림은 캐시 대상이 아니다. 정적 최적화가 끼어들면 안 된다.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "application/json",
  };
  // 인증은 백엔드가 한다. 토큰을 그대로 넘기기만 하면 된다.
  const auth = request.headers.get("authorization");
  if (auth) headers.authorization = auth;
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  const upstream = await fetch(`${BACKEND}/api/chat/stream`, {
    method: "POST",
    headers,
    body: request.body,
    // Node의 fetch는 요청 본문을 스트림으로 보낼 때 duplex를 요구한다.
    // @ts-expect-error duplex는 아직 TS lib에 없다
    duplex: "half",
    cache: "no-store",
  });

  // 업스트림 본문을 **그대로** 흘려보낸다. 여기서 읽어 모으면 원래 문제로
  // 되돌아간다.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      // no-transform: 중간 프록시(Cloudflare 포함)가 압축·변환하며 버퍼링하지
      // 않게 한다. x-accel-buffering은 nginx 계열에 대한 같은 취지의 신호다.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
