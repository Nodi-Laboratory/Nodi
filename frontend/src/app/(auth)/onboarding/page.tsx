"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useMyClasses } from "@/lib/hooks";

/**
 * 온보딩(학급코드).
 * "연결할 학급이 있습니까?" → 학급코드 입력 → join_class_by_code RPC.
 * 복수 학급 연결 가능. 잘못된 코드(P0002 / invalid_join_code)는 친절한 에러.
 * "학급 없이 시작" → /home (학급 없이도 진행 가능).
 */
export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: myClasses = [] } = useMyClasses();

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.rpc("join_class_by_code", {
      p_code: trimmed,
    });

    if (error) {
      // P0002 = invalid_join_code (잘못된/없는 코드)
      if (
        error.code === "P0002" ||
        error.message?.includes("invalid_join_code")
      ) {
        setError("유효하지 않은 학급 코드입니다. 다시 확인해 주세요.");
      } else {
        setError("학급 연결 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
      setLoading(false);
      return;
    }

    setCode("");
    await queryClient.invalidateQueries({ queryKey: ["my-classes"] });
    setLoading(false);
  };

  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 shadow-sm">
      <h1 className="text-xl font-bold text-fg">시작하기</h1>
      <p className="mt-2 text-sm text-fg-muted">연결할 학급이 있습니까?</p>

      <div className="mt-5">
        <label className="text-xs font-medium text-fg-muted" htmlFor="join-code">
          학급 코드 (선택)
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="join-code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoin();
            }}
            placeholder="예: ABC123"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleJoin}
            disabled={loading || !code.trim()}
            className="rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
          >
            연결
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>

      {/* 연결된 학급 목록 */}
      {myClasses.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {myClasses.map((m) => (
            <li
              key={m.class_id}
              className="flex items-center gap-2 rounded-lg border border-positive/40 bg-positive/5 px-3 py-2 text-sm text-fg"
            >
              <span className="h-2 w-2 rounded-full bg-positive" />
              {m.classes?.name ?? "연결된 학급"}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            router.push("/home");
            router.refresh();
          }}
          className="w-full rounded-lg border border-accent-border bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white"
        >
          {myClasses.length > 0 ? "완료하고 시작" : "학급 없이 시작"}
        </button>
      </div>
    </div>
  );
}
