"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Expand, Grid2x2, Loader2, MessageSquarePlus, Minimize2 } from "lucide-react";
import { ConceptMap } from "@/components/home/ConceptMap";
import { useProfile } from "@/lib/hooks";
import { useConceptMap, useHomeSummary } from "@/lib/queries";
import { useRoutePrefetch } from "@/lib/useRoutePrefetch";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { createSession } from "@/lib/api";
import type { ConceptNode } from "@/lib/api/conceptMap";
import { VeilShader } from "@/components/home/VeilShader";
import { PAGE_BG } from "@/lib/ui/surface";

/** 비어 있는 집합 하나를 재사용한다 — 렌더마다 새로 만들면 지도 memo가 깨진다. */
const NO_HIDDEN: ReadonlySet<string> = new Set<string>();


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
   * **온전한 지도 보기** (사용자 지시 2026-08-10).
   *
   * 켜면 글자·입력창·버튼이 서서히 흐려져 사라지고 덮개도 걷힌다 — 남는 것은
   * 지도뿐이다. 지도가 배경이 되면서(D218) 정작 그 지도를 **제대로 볼 방법**이
   * 없어졌던 것을 여기서 되돌린다.
   *
   * 사라진 것들은 자리를 비켜 주기만 한다(`opacity` + `pointer-events`) —
   * DOM에서 빼면 다시 켤 때 입력창이 처음부터 다시 그려져 쓰던 글이 날아간다.
   */
  const [mapOnly, setMapOnly] = useState(false);

  /**
   * ⚠️ **개념이 없어도 홈에 머문다** (사용자 지시 2026-08-11 — D210 2-1 폐기).
   *
   * 예전에는 개념 카드가 0개면 `/space/personal`로 튕겨 냈다. 그때는 홈에
   * **지도밖에** 없어서 빈 홈이 곧 빈 화면이었기 때문이다.
   *
   * 지금 홈에는 인사말과 **질문 입력창**이 있다. 노드가 하나도 없어도 학생이
   * 여기서 바로 물어볼 수 있으므로 튕겨 낼 이유가 사라졌다 — 오히려 처음
   * 들어온 학생이 홈을 한 번도 못 보고 캔버스로 끌려가던 쪽이 문제였다.
   */

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
    /**
     * **상자를 걷어냈다** (사용자 지시 2026-08-11).
     *
     * 여백 40px + 테두리 3px + 폭 상한 1800px으로 지도를 상자에 가둬 뒀었다.
     * 그때는 "지도는 여기까지"를 말해 줄 경계가 필요하다는 판단이었는데,
     * 사용자 판단은 **그 경계가 화면만 좁힌다**는 것이다 — 안에 있던 것
     * (지도·그라디언트 막·인사말·입력창)은 그대로 두고 자리만 넓힌다.
     *
     * ⚠️ `PAGE_BG`는 남긴다. 지도를 못 그리는 순간(불러오는 중·실패)에
     * 이것마저 없으면 화면이 통째로 하얘진다.
     */
    <div className="flex h-full flex-col" style={{ background: PAGE_BG }}>
      <section className="relative min-h-0 w-full flex-1 overflow-hidden">
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
        ) : !map ? (
          /* 지도 모양이 아직 없을 때만 비워 둔다. **노드가 0개인 것은 정상**
             이므로 그대로 그린다 — 빈 지도 위에 인사말과 입력창이 뜬다. */
          <div className="h-full w-full" aria-hidden />
        ) : (
          <>
            {/**
             * **온전한 지도 보기** 단추 — 상자 오른쪽 위 (사용자 지시 2026-08-10).
             *
             * 지도 위에 떠 있는 유일한 크롬이라 최대한 조용해야 한다. 켜져
             * 있을 때만 색이 붙어, 지금 어느 상태인지가 그 색으로 읽힌다.
             */}
            <button
              type="button"
              data-map-only
              aria-pressed={mapOnly}
              onClick={() => setMapOnly((v) => !v)}
              title={mapOnly ? "돌아가기" : "지도만 보기"}
              aria-label={mapOnly ? "돌아가기" : "지도만 보기"}
              /* 상자가 없어져 화면 모서리에 붙는다 — 3px 테두리가 만들던
                 여백이 사라졌으므로 그만큼 안쪽으로 들여 놓는다. */
              /* 윤곽선 없이 그림자로만(사용자 지시 2026-08-11). */
              className="absolute right-5 top-5 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-bg-elevated/90 text-fg-muted backdrop-blur transition-colors hover:text-fg"
              style={{
                boxShadow: "var(--shadow-float)",
                ...(mapOnly ? { background: "var(--accent)", color: "var(--accent-fg)" } : {}),
              }}
            >
              {mapOnly ? <Minimize2 size={16} /> : <Expand size={16} />}
            </button>

            {/* 배경 — 지도. 확대·축소·끌기·누르기가 그대로 동작한다. */}
            <div className="absolute inset-0">
              <ConceptMap
                data={map}
                onOpen={openConcept}
                hiddenSessions={NO_HIDDEN}
                // 온전히 볼 때는 떠다니던 노드가 **서서히** 선다.
                quiet={mapOnly}
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
              className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-700"
              /**
               * **흐르는 라임 그라디언트** (디자이너 요청 2026-08-11).
               *
               * 평평한 베이지 스포트라이트였다. 참조 시안
               * (soqhomore/nodi-web-test)의 색·움직임·요소를 그대로 옮겨 왔다.
               *
               * ⚠️ **바뀐 것은 막의 그림뿐이다.** 투명도(0.66)도, 지도만 볼 때
               * 사라지는 것도, 포인터를 통과시키는 것도 그대로다 — 이 막이
               * 하는 일은 지도를 지우는 것이 아니라 한 겹 뒤로 물려 위의 글을
               * 또렷하게 하는 것이고, 그 역할은 안 바뀌었다.
               *
               * ## 투명도는 0.38이다
               *
               * 처음에 0.66으로 얹었더니 **뒤의 노드가 너무 안 보였다.** 같은
               * 화면을 투명도별로 찍어 지도 띠의 밝기 편차(노드가 보이는 정도)와
               * 초록−파랑(라임이 남은 정도)을 재서 0.38을 골랐다.
               *
               * **2026-08-11에 두 가지가 함께 바뀌어 다시 쟀다** — 셰이더
               * 팔레트를 형광으로 올렸고(사용자 지시), 상자를 걷어내 지도가
               * 화면 전체를 쓰게 됐다. 막 없을 때의 대비가 26.7 → **23.1**로
               * 달라졌으므로 옛 표의 비율은 더 이상 안 맞는다.
               *
               *   투명도   노드 대비(막 없을 때 23.1 = 100%)   라임끼
               *   0.30            69%                          54
               *   0.38            65%                          65
               *   0.46            58%                          76
               *
               * ⚠️ **형광으로 올렸는데 대비는 안 나빠졌다.** 옛 팔레트의 0.38이
               * 64% · 라임끼 47이었는데 새 팔레트의 0.38은 65% · 라임끼 65다 —
               * 채도를 올린 만큼 **같은 투명도에서 색만 세졌다.** 그래서 투명도를
               * 낮출 이유가 없었다(낮추면 0.30에서 라임끼가 54로 되레 준다).
               *
               * 라임끼는 0.46을 넘어도 계속 오르지만 노드가 58%까지 묻힌다 —
               * 이 막이 하는 일은 지도를 지우는 것이 아니라 **한 겹 뒤로 물리는
               * 것**이므로 그 아래에서 멈춘다.
               */
              style={{ opacity: mapOnly ? 0 : 0.38 }}
            >
              <VeilShader />
            </div>

            {/**
             * 위에 뜨는 것 — 인사 · 입력 · 갈 곳 둘.
             *
             * 자리는 상자 **위쪽**이다. 정가운데에 두면 지도의 가장 붐비는 곳과
             * 겹친다(점은 가운데로 뭉친다).
             */}
            <div
              data-map-overlay
              className="pointer-events-none absolute inset-0 flex flex-col items-center px-6 pt-[8%] transition-opacity duration-700"
              // 사라진 뒤에도 자리에 남아 있으면 보이지 않는 것이 클릭을 먹는다.
              style={{ opacity: mapOnly ? 0 : 1, visibility: mapOnly ? "hidden" : "visible" }}
              aria-hidden={mapOnly}
            >
              <div className="pointer-events-auto flex w-full max-w-3xl flex-col items-center gap-8">
                {/* 페이지 제목이 h1이므로 여기는 h2다 — 문서 구조가 뒤집히면
                  낭독기가 이 화면의 주제를 인사말로 읽는다. */}
                <h2 className="font-brand text-center text-[34px] font-medium leading-snug text-fg">
                  {displayName
                    ? `${displayName}님, 안녕하세요.`
                    : "안녕하세요."}
                  <br />
                  무엇을 배우고 싶으신가요?
                </h2>

                <form
                  /* 윤곽선을 걷어낸다(사용자 지시 2026-08-11) — 흰 알약에
                     그림자만. 캔버스 입력창과 같은 규칙이다. */
                  className="flex w-full items-center gap-3 rounded-full bg-bg-elevated px-7 py-4"
                  style={{ boxShadow: "var(--shadow-float)" }}
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
                    className="min-w-0 flex-1 bg-transparent text-[18px] text-fg outline-none placeholder:text-fg-muted"
                  />
                  <button
                    type="submit"
                    aria-label="보내기"
                    disabled={!question.trim() || starting}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-deep text-accent-fg transition-opacity disabled:opacity-40"
                  >
                    {starting ? (
                      <Loader2 size={19} className="animate-spin" aria-hidden />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </button>
                </form>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={starting}
                    onClick={() => void startChat(null)}
                    className="flex items-center gap-2 rounded-full bg-accent px-6 py-3.5 text-[17px] font-medium text-accent-fg transition-opacity disabled:opacity-50"
                  >
                    <MessageSquarePlus size={19} />
                    새로운 대화 하기
                  </button>
                  {/* 사용자 지시: '과거 대화 보기'가 아니라 **내 세션 보기**다 —
                    가는 곳도 지난 대화 목록이 아니라 세션 선택 화면(D217)이다. */}
                  <button
                    type="button"
                    onClick={() => router.push("/sessions")}
                    className="flex items-center gap-2 rounded-full bg-bg-elevated px-6 py-3.5 text-[17px] font-medium text-fg transition-colors hover:bg-accent-soft/50"
                    style={{ boxShadow: "var(--shadow-float)" }}
                  >
                    <Grid2x2 size={19} />내 세션 보기
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
