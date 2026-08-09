"use client";

/**
 * 토큰이 필요한 그림을 `<img>`에 띄운다 (2026-08-10 전면 점검에서 찾은 결함).
 *
 * ## ⚠️ `<img src>`는 Authorization을 못 싣는다
 *
 * 학급 프로필 사진(D217)이 이 함정에 걸려 있었다. 창구는 `Bearer` 토큰을
 * 요구하는데 화면은 주소를 그대로 `<img src>`에 넣었다 — 브라우저가 헤더 없이
 * 받으러 가니 서버는 **401**을 준다. 실측 2026-08-10: 교사 콘솔의 학급 상세를
 * 열 때마다 401이 하나씩 났고, 사진은 한 번도 안 떴다.
 *
 * 눈에 안 띈 이유는 **폴백이 그럴싸했기** 때문이다: 사진이 없는 학급은 폴더
 * 그림을 보여 주게 돼 있어서, 사진을 올린 학급도 그냥 폴더로 보였다. 올리기는
 * 되고 보이기만 안 되는 종류라 "안 올라갔나 보다"로 읽힌다.
 *
 * D178이 도판에서 같은 벽을 만나 이미 답을 냈다 — **바이트를 직접 받아 온다.**
 * 여기서는 그 방법을 작은 훅으로 묶는다.
 *
 * ## 주소는 반드시 거둔다
 *
 * `URL.createObjectURL`이 만든 주소는 문서가 살아 있는 동안 메모리를 잡는다.
 * 목록을 오가며 학급 카드가 수십 번 다시 그려지는 화면이라, 안 거두면 그만큼
 * 쌓인다.
 */

import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/api/_core";

/**
 * @param url 없으면 아무것도 안 받는다(사진이 없는 학급).
 * @returns 그릴 수 있는 blob 주소. 받는 중이거나 실패면 null.
 */
export function useAuthedImage(url: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // ⚠️ 이펙트 본문에서 setState를 부르지 않는다(React Compiler 규칙). 주소가
    // 없으면 받을 것도 없으니, 이전 주소를 거두는 정리만 하고 나간다 —
    // 화면에 무엇을 그릴지는 `url`을 함께 본 아래 파생값이 정한다.
    if (!url) return;
    let dead = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const res = await fetch(url, { headers: await authHeaders() });
        if (!res.ok) return; // 404(사진 없음)·403(남의 학급)은 조용히 — 폴백이 있다
        const blob = await res.blob();
        if (dead) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        // 네트워크가 안 되면 그림이 없는 것과 같다. 화면은 폴더로 간다.
      }
    })();

    return () => {
      dead = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  /**
   * 주소가 없어지면(사진 없는 학급으로 바뀌면) **곧바로** 안 그린다 — 이전
   * blob 주소가 잠깐 남아 엉뚱한 학급의 사진이 스치는 것을 막는다.
   */
  return url ? src : null;
}
