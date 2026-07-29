"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * 화면에 보이는 목적지의 **라우트**를 미리 받아 둔다 (D117).
 *
 * `<Link>`는 Next가 알아서 프리페치하지만, 이 앱의 주요 진입은 버튼 +
 * `router.push`다(최근 대화, 학급 카드). 클릭한 뒤에야 RSC 페이로드와 청크를
 * 받기 시작하므로 그 왕복이 통째로 체감 지연이 된다.
 *
 * 실측 — 프로덕션 빌드, 홈 → 캔버스 클릭:
 *   첫 클릭 268ms · 두 번째부터 23~44ms   (로컬, 네트워크 왕복 없음)
 *   배포본은 RSC 왕복만 215~247ms가 더 붙는다(Cloudflare 터널 경유).
 *
 * hover 프리페치가 아니라 **마운트 시점**에 한다. 태블릿·터치에는 hover가
 * 없어서 정작 교실에서 쓰는 기기가 혜택을 못 본다. 대신 개수를 제한한다 —
 * 프리페치 하나가 서버 렌더 하나다.
 *
 * dev 서버에서는 Next가 프리페치를 하지 않는다(무시된다). 개선은 프로덕션
 * 빌드에서만 관측된다 — `npm run build && npm start`로 확인할 것.
 */
const MAX_PREFETCH = 6;

export function useRoutePrefetch(hrefs: readonly (string | null | undefined)[]) {
  const router = useRouter();
  // 배열 아이덴티티가 매 렌더 바뀌어도 실제 값이 같으면 다시 돌지 않게 한다.
  const key = hrefs.filter(Boolean).join("|");

  useEffect(() => {
    if (!key) return;
    const unique = [...new Set(key.split("|"))].slice(0, MAX_PREFETCH);
    for (const href of unique) {
      // 실패해도 조용히 넘어간다 — 프리페치는 최적화지 기능이 아니다.
      try {
        router.prefetch(href);
      } catch {
        /* 무시 */
      }
    }
  }, [key, router]);
}
