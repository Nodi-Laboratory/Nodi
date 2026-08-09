"use client";

/**
 * 세션 선택 화면 (사용자 지시 2026-08-09).
 *
 * 사이드바에 학급이 하나씩 동그라미로 쌓이던 방식을 걷어내고, **여기 한
 * 화면에서 고른다.** 학급이 늘수록 동그라미는 서로 구분이 안 됐다 — 이름
 * 첫 글자 하나로는 "3학년 1반"과 "3학년 2반"이 같아 보인다.
 *
 * 카드 한 장이 답하는 것은 셋이다:
 *   · 어느 학급인가 — 선생님이 정한 사진
 *   · 뭘 가지고 있나 — 자료·강의 수 한 줄
 *   · 무슨 얘기를 했나 — 많이 이야기한 순 분류
 *
 * **개인 세션이 언제나 첫 칸**이다. 학급이 없어도 들어갈 곳이 하나는 있어야
 * 하고, 그 자리가 매번 바뀌면 손이 기억하지 못한다.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, User } from "lucide-react";
import { classAvatarUrl, getSpacesOverview, type SpaceOverview } from "@/lib/api/spaces";
import { joinClass } from "@/lib/api";
import { useProfile } from "@/lib/hooks";

/** 한 카드에 넣을 분류 수 상한. 넘치면 `…`로 접는다. */
const CHIP_CAP = 6;

function initials(name: string | null | undefined, fallback: string): string {
  const t = (name ?? "").trim();
  return t ? t.slice(0, 1) : fallback;
}

/**
 * 카드 하나.
 *
 * 상자는 **정사각형에서 시작해 좁아지면 눕는다**(사용자 지시) — 격자
 * `minmax`가 열 수를 정하고 사진 칸만 비율을 지킨다. 화면 크기마다 다른
 * 컴포넌트를 두지 않는 이유는, 갈라 두면 둘 중 하나가 반드시 뒤처지기
 * 때문이다.
 */
function SpaceCard({
  space,
  displayName,
  onOpen,
}: {
  space: SpaceOverview;
  displayName: string | null;
  onOpen: () => void;
}) {
  const isPersonal = space.space_kind === "personal";
  const chips = space.concepts.slice(0, CHIP_CAP);
  const more = space.concepts.length - chips.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-2xl border border-accent-border/60 bg-bg-elevated text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
    >
      {/* 사진 칸 — 비율을 지켜야 카드마다 높이가 들쭉날쭉하지 않다. */}
      <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-accent-soft/50">
        {isPersonal ? (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-deep text-2xl font-semibold text-accent-fg">
            {displayName ? initials(displayName, "나") : <User size={26} />}
          </span>
        ) : space.has_avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={classAvatarUrl(space.space_ref)}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-2xl font-semibold text-accent-fg">
            {initials(space.name, "반")}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="truncate text-[15px] font-semibold text-fg">
          {isPersonal ? "개인 세션" : space.name}
        </div>

        {/* 자료·강의는 **한 줄**이다(사용자 지시). 개인 세션에는 없으므로
            대화방 수를 대신 보여 준다 — 빈 줄을 두면 카드가 무너져 보인다. */}
        <div className="text-[12px] text-fg-muted">
          {isPersonal
            ? `대화방 ${space.sessions}개`
            : `자료 ${space.materials}개 · 강의 ${space.lectures}개`}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {chips.length === 0 ? (
            <span className="text-[12px] text-fg-muted">아직 나눈 이야기가 없어요</span>
          ) : (
            <>
              {chips.map((c) => (
                <span
                  key={c}
                  className="max-w-full truncate rounded-full border border-accent-border/60 bg-accent-soft/40 px-2 py-0.5 text-[11px] text-fg-muted"
                >
                  {c}
                </span>
              ))}
              {more > 0 && (
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] text-fg-muted"
                  title={space.concepts.slice(CHIP_CAP).join(", ")}
                >
                  …
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </button>
  );
}

export function SpacePicker() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: profile } = useProfile();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["spaces", "overview"],
    queryFn: getSpacesOverview,
    staleTime: 60_000,
  });

  const join = useMutation({
    mutationFn: (c: string) => joinClass(c),
    onSuccess: async () => {
      setCode("");
      setMsg("학급에 들어갔어요.");
      await qc.invalidateQueries({ queryKey: ["spaces", "overview"] });
      await qc.invalidateQueries({ queryKey: ["my-classes"] });
    },
    // 코드가 틀린 것과 서버가 안 되는 것은 학생에게 다른 말이어야 한다.
    onError: (e: unknown) =>
      setMsg(
        (e as { status?: number })?.status === 404
          ? "그런 학급 코드가 없어요. 선생님께 다시 확인해 주세요."
          : "지금은 들어갈 수 없어요. 잠시 뒤 다시 해 주세요.",
      ),
  });

  const spaces = useMemo(() => data ?? [], [data]);
  const title = profile?.display_name ? `${profile.display_name}님의 세션` : "내 세션";

  const open = (s: SpaceOverview) =>
    router.push(s.space_kind === "personal" ? "/space/personal" : `/space/${s.space_ref}`);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold text-fg">
        {title}
      </h1>

      {/* 학급 코드로 들어가기 — 제목 아래 **가운데**(사용자 지시). */}
      <form
        className="mx-auto flex w-full max-w-sm items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const c = code.trim();
          if (!c || join.isPending) return;
          setMsg(null);
          join.mutate(c);
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="학급 코드"
          aria-label="학급 코드"
          className="min-w-0 flex-1 rounded-lg border border-accent-border bg-bg-elevated px-3 py-2 text-sm text-fg"
        />
        <button
          type="submit"
          aria-label="학급 추가"
          title="학급 추가"
          disabled={!code.trim() || join.isPending}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-deep text-accent-fg transition-opacity disabled:opacity-40"
        >
          <Plus size={18} />
        </button>
      </form>
      {msg && (
        <p className="text-center text-[13px] text-fg-muted">
          {msg}
        </p>
      )}

      {isLoading && (
        <p className="text-center text-sm text-fg-muted">
          불러오는 중이에요…
        </p>
      )}
      {isError && (
        <p className="text-center text-sm text-fg-muted">
          목록을 못 불러왔어요. 새로고침해 주세요.
        </p>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        {spaces.map((s) => (
          <SpaceCard
            key={`${s.space_kind}:${s.space_ref}`}
            space={s}
            displayName={profile?.display_name ?? null}
            onOpen={() => open(s)}
          />
        ))}
      </div>
    </main>
  );
}
