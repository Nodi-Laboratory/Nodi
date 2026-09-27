"use client";

/**
 * 첫 진입 때 한 번 키 입력을 권한다 (공개판 C 분류, 2026-09-27).
 *
 * 조건: 서버 `.env`에 Upstage 키가 없고, 이 브라우저에도 없고, 전에 권한 적이
 * 없을 때. 닫으면 다시 안 띄운다 — 매번 뜨면 키 없이 둘러보려는 사람을 막는다.
 * 이후에는 입력창의 안내 줄과 설정 화면에서 연다.
 */

import { useEffect, useState } from "react";
import { useAiReadiness } from "@/lib/aiConfig";
import { loadApiKeys } from "@/lib/apiKeys";
import { ApiKeyDialog } from "./ApiKeyDialog";

const PROMPTED_KEY = "nodi.apiKeys.prompted";

function alreadyPrompted(): boolean {
  try {
    return window.localStorage.getItem(PROMPTED_KEY) === "1";
  } catch {
    return true; // 저장소를 못 쓰면 매번 뜨게 되니 아예 안 띄운다
  }
}

export function ApiKeyFirstRun() {
  const ai = useAiReadiness();
  const [phase, setPhase] = useState<"pending" | "open" | "done">("pending");

  // 설정 조회가 끝나는 렌더에서 한 번 판정한다(렌더 중 조정 — 이펙트 안의
  // setState를 피한다. React Compiler 규칙).
  if (phase === "pending" && ai.loaded) {
    const should =
      ai.needsUpstageInput && !loadApiKeys().upstage && !alreadyPrompted();
    setPhase(should ? "open" : "done");
  }

  useEffect(() => {
    if (phase !== "open") return;
    try {
      window.localStorage.setItem(PROMPTED_KEY, "1");
    } catch {
      /* alreadyPrompted가 이미 걸렀다 */
    }
  }, [phase]);

  return <ApiKeyDialog open={phase === "open"} onClose={() => setPhase("done")} />;
}
