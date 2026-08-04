"use client";

/**
 * 캔버스 화면 동작 값 (D174).
 *
 * **절대 로딩 상태를 노출하지 않는다.** 값을 못 받았다고 캔버스가 안 뜨면
 * 안 되므로, 받기 전에는 예전과 같은 상수(fallback)로 돈다. 값이 도착하면
 * 그때부터 서버 값으로 바뀐다.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CLIENT_SETTINGS_FALLBACK,
  getClientSettings,
  type ClientSettings,
} from "@/lib/api/clientSettings";
import { configureLayout } from "./layout";

export function useClientSettings(): ClientSettings {
  const { data } = useQuery({
    queryKey: ["client-settings"],
    queryFn: getClientSettings,
    // 관리자가 바꾸면 새로고침에 반영된다. 화면 동작 값이라 매번 다시 읽을
    // 이유가 없다 — 채팅 경로에 군더더기 요청을 얹지 않는다.
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  /**
   * 배치 간격은 모듈 상수라 훅 반환값으로는 전달되지 않는다 — 받은 값을
   * layout에 밀어 넣는다(D174). 값이 같으면 아무 일도 일어나지 않는다.
   */
  useEffect(() => {
    if (!data) return;
    configureLayout({
      colGap: data.colGap,
      rowGap: data.rowGap,
      sibGap: data.sibGap,
    });
  }, [data]);

  return data ?? CLIENT_SETTINGS_FALLBACK;
}
