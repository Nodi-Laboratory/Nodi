"use client";

/**
 * 클립 카드에 붙일 썸네일 하나 (D190).
 *
 * ## 왜 `<img src>`가 아닌가
 *
 * 인증이 `Authorization: Bearer` 전용이라(`auth/deps.py`) `<img>`는 못 붙는다 —
 * 태그가 헤더를 실을 방법이 없다. 도판이 겪은 그 함정이라(D178) 처음부터
 * `fetch`로 바이트를 받아 object URL로 쓴다.
 *
 * ## 왜 이펙트가 없나
 *
 * 처음에는 `useEffect` + `setState`로 썼는데 React Compiler가 막는다(이펙트 안
 * 동기 setState). 억제하지 않고 구조로 푼다 — 받아 오는 일 자체를 질의로 두면
 * 이펙트가 필요 없고, **같은 그림을 여러 카드가 쓸 때 요청도 한 번**이 된다
 * (react-query가 키로 합쳐 준다). 썸네일은 몇 장뿐이라 클립 여럿이 같은 그림을
 * 고른다.
 */

import { useQuery } from "@tanstack/react-query";
import { clipThumbnailUrl, listClipThumbnails } from "@/lib/api";
import { authHeaders } from "@/lib/api/_core";
import { pickThumbId } from "./clipThumb";

async function loadThumb(id: string): Promise<string | null> {
  try {
    const res = await fetch(clipThumbnailUrl(id), { headers: await authHeaders() });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    // 그림이 없다고 카드를 못 그릴 이유는 없다 — 자리를 비워 둔다.
    return null;
  }
}

/**
 * 이 클립이 쓸 썸네일의 object URL. 아직 없거나 올라온 그림이 없으면 null.
 *
 * object URL은 **회수하지 않는다.** 같은 그림을 다른 카드가 쓰고 있는데 놓아
 * 버리면 그쪽이 깨진다. 썸네일은 관리자가 올린 몇 장뿐이라 새는 양이 유한하고,
 * 그 대신 캔버스를 오가도 다시 안 받는다.
 */
export function useClipThumb(clipId: string | undefined): string | null {
  const { data: thumbs } = useQuery({
    queryKey: ["clip-thumbnails"],
    queryFn: listClipThumbnails,
    // 관리자가 그림을 올리는 일은 드물다 — 캔버스를 열 때마다 물을 이유가 없다.
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
  });

  const picked = clipId
    ? pickThumbId(
        clipId,
        (thumbs ?? []).map((t) => t.id),
      )
    : null;

  const { data: url } = useQuery({
    queryKey: ["clip-thumbnail-blob", picked],
    queryFn: () => loadThumb(picked!),
    enabled: !!picked,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return url ?? null;
}
