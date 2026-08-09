"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Grid2x2, Loader2, MessageSquarePlus } from "lucide-react";
import { ConceptMap } from "@/components/home/ConceptMap";
import { useProfile } from "@/lib/hooks";
import { useConceptMap, useHomeSummary } from "@/lib/queries";
import { useRoutePrefetch } from "@/lib/useRoutePrefetch";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { createSession } from "@/lib/api";
import type { ConceptNode } from "@/lib/api/conceptMap";

/** 비어 있는 집합 하나를 재사용한다 — 렌더마다 새로 만들면 지도 memo가 깨진다. */
const NO_HIDDEN: ReadonlySet<string> = new Set<string>();

/**
 * 개념이 없어 대화방으로 보내는 중 (D210 2-1).
 *
 * 갓 가입한 학생에게 처음 보이는 화면이 "여기는 비어 있습니다"인 것은 좋은
 * 첫인상이 아니다 — 할 일을 알려 주는 것보다 **할 수 있는 자리로 데려다
 * 주는 것**이 낫다(사용자 지시 2026-08-08).
 */
function GoingToCanvas() {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-fg-muted">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      대화방을 여는 중…
    </div>
  );
}

/**
 * 홈 — **개념 지도를 배경으로 깐 시작 화면** (사용자 지시 2026-08-09).
 *
 * ## 지도가 목적지에서 배경이 됐다
 *
 * D189의 홈은 지도를 **읽는** 화면이었다(제목·설명·오른쪽 대화 목록). 그런데
 * 홈에 온 학생이 하려는 일은 대개 "묻기"다 — 지도를 들여다보는 것은 그 다음
 * 이다. 그래서 지도는 베이지 덮개 아래로 물러나고, 그 위에 **인사 · 입력창 ·
 * 갈 곳 둘**만 남는다.
 *
 * **지도는 죽지 않았다.** 덮개는 `pointer-events: none`이라 확대·축소·끌기·
 * 개념 누르기가 그대로 동작한다 — 덮개로 가리면 배경이 그림이 되어 버리고,
 * 그러면 지도를 둘 이유가 없다.
 *
 * ## 오른쪽 대화 목록은 걷어냈다
 *
 * 폴더로 대화를 켜고 끄는 목록(D191)이 오른쪽에 있었다. 사용자 판단으로
 * 없앴다 — 배경이 된 지도에서 무엇을 숨길지 고르는 일은 값보다 자리를 더
 * 많이 차지한다.
 */
export default function HomePage() {
  const { data: profile } = useProfile();
  const { data: summary } = useHomeSummary();
  const { data: map, isLoading, isError } = useConceptMap();
  const router = useRouter();
  const setPendingFocusItem = useWorkspaceStore((s) => s.setPendingFocusItem);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  const [question, setQuestion] = useState("");
  const [starting, setStarting] = useState(false);

  /**
   * **보여 줄 개념이 없으면 홈을 건너뛴다** (D210 2-1, 사용자 지시).
   *
   * 판정 기준이 "세션 없음"이 아니라 **"개념 카드 0개"**인 것이 요점이다.
   * 인사만 하고 나간 학생은 세션은 있지만 지도에 올릴 것이 없어 똑같이 빈
   * 화면을 본다 — 세션 유무로 가르면 그 경우를 놓친다.
   *
   * `replace`여야 한다. `push`면 뒤로 가기가 다시 이 빈 홈으로 데려오고,
   * 거기서 또 튕겨 나가 뒤로 가기가 먹지 않는 것처럼 보인다.
   */
  const 개념없음 = !isLoading && !isError && (!map || map.nodes.length === 0);
  useEffect(() => {
    if (개념없음) router.replace("/space/personal");
  }, [개념없음, router]);

  const displayName = profile?.display_name ?? profile?.email ?? null;
  const spaceIds = (summary?.spaces ?? []).map((s) =>
    s.space_kind === "personal" ? "/space/personal" : `/space/${s.space_ref}`,
  );
  useRoutePrefetch(["/space/personal", "/sessions", ...spaceIds]);

  /**
   * 개념을 누르면 **그 대화의 그 카드**로 간다.
   *
   * 도착해서 바로 초점을 맞출 수는 없다 — 목적지 세션은 아직 안 채워져 있고
   * 수화는 비동기다(D147). "가서 이 카드를 보여 달라"를 스토어에 남기면
   * 캔버스가 그 카드를 실제로 갖게 됐을 때 소비한다. 교차 링크(D171)가 다른
   * 세션으로 건너뛸 때 쓰는 길과 **같은 길**이다.
   */
  const openConcept = (node: ConceptNode) => {
    const session = map?.sessions.find((s) => s.id === node.session_id);
    if (!session) return;
    const spaceId =
      session.space_kind === "class" && session.space_ref
        ? session.space_ref
        : "personal";
    setPendingFocusItem(node.id);
    setActiveSpace(spaceId);
    setActiveSession(session.id, spaceId);
    router.push(`/space/${spaceId}`);
  };

  /**
   * 새 대화방을 열고 간다. 질문이 있으면 **그 질문을 들려 보낸다**.
   *
   * 지금은 언제나 **개인 세션**이다(사용자 지시 "일단은"). 홈에서는 어느
   * 학급에서 물을지 고른 적이 없으므로, 물어볼 곳을 임의로 정하는 것보다
   * 학생 자신의 공간에 두는 편이 안전하다 — 학급 자료가 딸려 가는 일도 없다.
   *
   * 방을 여기서 **미리 만든다.** 캔버스에 맡기면 "질문은 있는데 저장할 방이
   * 아직 없는" 순간이 생기고, 그 사이에 학생이 뭔가 하면 갈 곳이 없다
   * (`useSessionBinding` 머리말의 그 문제다). 빈 방이 쌓이지도 않는다 —
   * 만들기 창구가 이미 있는 빈 방을 돌려준다(D202).
   */
  const startChat = async (seed: string | null) => {
    if (starting) return;
    setStarting(true);
    try {
      const s = await createSession({ space_kind: "personal" });
      setActiveSpace("personal");
      setActiveSession(s.id, "personal");
      // `seed`는 선택 필드다 — 질문 없이 들어가면 아예 안 싣는다.
      setPendingSession({
        sessionId: s.id,
        spaceId: "personal",
        ...(seed ? { seed } : {}),
      });
      router.push("/space/personal");
    } catch {
      // 방을 못 만들었으면 그냥 대화방으로 보낸다 — 거기서 다시 시도한다.
      setStarting(false);
      router.push("/space/personal");
    }
  };

  return (
    /* 여백을 넉넉히 준다(사용자 지시 2026-08-09) — 상자가 화면 가장자리에
       붙어 있으면 캔버스가 페이지 전체로 번져 보인다. */
    <div className="flex h-full flex-col px-10 py-8">
      {/**
       * 지도 박스 (D191의 그 상자다, 사용자 지시 2026-08-09로 되돌렸다).
       *
       * **남은 높이를 다 쓴다** — 상한을 걸면 아래에 빈 자리가 크게 남아
       * 상자가 화면 위쪽에 떠 있는 꼴이 된다. 테두리 3px은 "지도는 여기까지"를
       * 말한다. 배경이 된 지금도 경계는 있어야 한다 — 없으면 지도가 페이지
       * 전체로 번져 어디까지가 누를 수 있는 자리인지 흐려진다.
       */}
      <section className="relative mx-auto min-h-0 w-full max-w-[1800px] flex-1 overflow-hidden rounded-xl border-[3px] border-accent-border/70 bg-bg-elevated shadow-sm">
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            개념을 모으는 중…
          </div>
        ) : isError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-sm text-fg">지도를 불러오지 못했습니다</p>
            <p className="text-xs text-fg-muted">
              잠시 뒤 다시 열어 보세요. 대화 기록은 그대로 있습니다.
            </p>
          </div>
        ) : 개념없음 || !map ? (
          /* 판정이 끝나기 전에는 아무 안내도 그리지 않는다 — 빈 지도가 잠깐
           스쳤다 사라지면 깜빡임으로 보인다. */
          <GoingToCanvas />
        ) : (
          <>
            {/* 배경 — 지도. 확대·축소·끌기·누르기가 그대로 동작한다. */}
            <div className="absolute inset-0">
              <ConceptMap
                data={map}
                onOpen={openConcept}
                hiddenSessions={NO_HIDDEN}
              />
            </div>

            {/**
             * 덮개 — **옅은 베이지** (사용자 지시 2026-08-09).
             *
             * 처음에 앱 배경색(연두)을 0.82로 덮었더니 지도가 거의 안 보였다
             * ("너무 불투명해"). 이 덮개가 하는 일은 지도를 **지우는 것이 아니라
             * 한 겹 뒤로 물리는 것**이다 — 점의 무리는 그대로 읽히고 위의 글만
             * 또렷해야 한다.
             *
             * 색이 연두가 아니라 베이지인 이유: 연두를 겹치면 초록 계열 점들과
             * 섞여 무리 구분이 뭉개진다. 따뜻한 중립색이 그 위에서 모든 파스텔을
             * 고르게 눌러 준다.
             *
             * `pointer-events`가 없어야 지도가 살아 있다 — 덮개가 포인터를 먹으면
             * 배경은 그림이 되고, 그러면 지도를 둘 이유가 사라진다.
             */}
            <div
              aria-hidden
              data-map-veil
              className="pointer-events-none absolute inset-0"
              style={{ background: "#f3ecdc", opacity: 0.55 }}
            />

            {/**
             * 위에 뜨는 것 — 인사 · 입력 · 갈 곳 둘.
             *
             * 자리는 상자 **위쪽**이다. 정가운데에 두면 지도의 가장 붐비는 곳과
             * 겹친다(점은 가운데로 뭉친다).
             */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center px-6 pt-[8%]">
              <div className="pointer-events-auto flex w-full max-w-2xl flex-col items-center gap-6">
                {/* 페이지 제목이 h1이므로 여기는 h2다 — 문서 구조가 뒤집히면
                  낭독기가 이 화면의 주제를 인사말로 읽는다. */}
                <h2 className="text-center text-[26px] font-semibold leading-snug text-fg">
                  {displayName
                    ? `${displayName}님, 안녕하세요.`
                    : "안녕하세요."}
                  <br />
                  무엇을 배우고 싶으신가요?
                </h2>

                <form
                  className="flex w-full items-center gap-2 rounded-full border border-accent-border bg-bg-elevated px-5 py-3 shadow-sm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const q = question.trim();
                    if (!q) return;
                    void startChat(q);
                  }}
                >
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder="궁금한 내용을 입력하세요..."
                    aria-label="질문 입력"
                    disabled={starting}
                    className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-muted"
                  />
                  <button
                    type="submit"
                    aria-label="보내기"
                    disabled={!question.trim() || starting}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-deep text-accent-fg transition-opacity disabled:opacity-40"
                  >
                    {starting ? (
                      <Loader2 size={16} className="animate-spin" aria-hidden />
                    ) : (
                      <ArrowUp size={17} />
                    )}
                  </button>
                </form>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => void startChat(null)}
                    className="flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-opacity disabled:opacity-50"
                  >
                    <MessageSquarePlus size={16} />
                    새로운 대화 하기
                  </button>
                  {/* 사용자 지시: '과거 대화 보기'가 아니라 **내 세션 보기**다 —
                    가는 곳도 지난 대화 목록이 아니라 세션 선택 화면(D217)이다. */}
                  <button
                    type="button"
                    onClick={() => router.push("/sessions")}
                    className="flex items-center gap-2 rounded-full border border-accent-border bg-bg-elevated px-4 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-accent-soft/50"
                  >
                    <Grid2x2 size={16} />내 세션 보기
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
