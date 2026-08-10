"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, completeOnboarding, joinClass, saveOnboardingAnswers } from "@/lib/api";
import { useMyClasses, useProfile } from "@/lib/hooks";
import {
  EMPTY_ANSWERS,
  ProfileSurvey,
  type SurveyAnswers,
} from "@/components/onboarding/ProfileSurvey";

/**
 * 온보딩 — 최초 가입 1회만(D18).
 *
 * 두 마당이다(D222, 사용자 지시 2026-08-11):
 *
 *   1. **설문** — 이름·학년·학습 단계·목표. 형식상 받아 두는 값이라 아무것도
 *      안 적어도 넘어간다.
 *   2. **학급 코드** — 원래 있던 것. join_class_by_code RPC.
 *
 * 시작 시 complete-onboarding 호출(이후 로그인엔 안 뜸).
 *
 * ⚠️ 문을 하나 더 만들지 않았다. `profiles.onboarded` 하나가 이 화면 전체를
 * 가리므로, 설문만 마치고 나간 사람은 다음 로그인에 **설문부터** 다시 본다 —
 * 답은 이미 저장돼 있어 잃는 것이 없고, 문이 둘이면 "설문은 했는데 학급은
 * 안 한 사람"이라는 상태를 새로 관리해야 한다.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: myClasses = [] } = useMyClasses();
  const { data: profile } = useProfile();

  /** 설문을 마쳤나. 마치기 전에는 학급 코드 마당을 안 보여 준다. */
  const [surveyDone, setSurveyDone] = useState(false);
  const [answers, setAnswers] = useState<SurveyAnswers>(EMPTY_ANSWERS);
  const [savingSurvey, setSavingSurvey] = useState(false);

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 이미 온보딩 완료한 사용자가 직접 들어오면 홈으로
  useEffect(() => {
    if (profile?.onboarded) router.replace("/home");
  }, [profile?.onboarded, router]);

  const handleJoin = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setError(null);
    setLoading(true);

    try {
      await joinClass(trimmed);
    } catch (err) {
      // 서버가 잘못된 코드를 404로 준다(join_class_by_code의 P0002 변환).
      setError(
        err instanceof ApiError && err.status === 404
          ? "유효하지 않은 학급 코드입니다. 다시 확인해 주세요."
          : "학급 연결 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
      );
      setLoading(false);
      return;
    }

    setCode("");
    await queryClient.invalidateQueries({ queryKey: ["my-classes"] });
    setLoading(false);
  };

  /**
   * 설문을 저장하고 다음 마당으로.
   *
   * **저장 실패가 온보딩을 막지 않는다.** 이 값을 읽는 기능이 없으므로 여기서
   * 멈춰 세우면 잃는 것만 있다 — 다만 조용히 넘기지는 않는다(콘솔에 남긴다).
   */
  const finishSurvey = async () => {
    setSavingSurvey(true);
    try {
      await saveOnboardingAnswers(answers);
    } catch (err) {
      console.warn("[온보딩] 설문을 저장하지 못했다 — 그대로 진행한다", err);
    }
    setSavingSurvey(false);
    setSurveyDone(true);
  };

  if (!surveyDone) {
    return (
      <div className="flex w-full justify-center py-4">
        <ProfileSurvey
          answers={answers}
          onChange={setAnswers}
          onDone={() => void finishSurvey()}
          busy={savingSurvey}
        />
      </div>
    );
  }

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
            /* 코드는 언제나 대문자다(D170). 서버도 정규화하지만 화면이 먼저
               알려 주는 편이 낫다. */
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoin();
            }}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="예: ABC123"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleJoin}
            disabled={loading || !code.trim()}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:opacity-60"
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
          disabled={starting}
          onClick={async () => {
            setStarting(true);
            try {
              await completeOnboarding();
            } catch {
              /* 실패해도 진입은 진행(다음 로그인에 재시도 가능) */
            }
            await queryClient.invalidateQueries({ queryKey: ["profile"] });
            router.push("/home");
            router.refresh();
          }}
          className="w-full rounded-lg bg-accent-deep px-4 py-2.5 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:opacity-60"
        >
          {starting
            ? "시작하는 중…"
            : myClasses.length > 0
              ? "완료하고 시작"
              : "학급 없이 시작"}
        </button>
      </div>
    </div>
  );
}

