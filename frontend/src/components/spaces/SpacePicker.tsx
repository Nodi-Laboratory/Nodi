"use client";

/**
 * 세션 선택 화면 (사용자 지시 2026-08-09).
 *
 * 사이드바에 학급이 하나씩 동그라미로 쌓이던 방식을 걷어내고, **여기 한
 * 화면에서 고른다.** 학급이 늘수록 동그라미는 서로 구분이 안 됐다 — 이름
 * 첫 글자 하나로는 "3학년 1반"과 "3학년 2반"이 같아 보인다.
 *
 * ## 카드는 **가로가 긴** 직사각형이다
 *
 * 처음에는 사진 칸을 4:3으로 두고 세로로 길게 만들었는데, 사용자가 말한
 * 직사각형은 **가로가 긴 쪽**이었다. 그래서 사진(또는 폴더)이 위, 이름이
 * 아래인 납작한 상자로 간다.
 *
 * ## 사진이 없으면 **폴더**다
 *
 * 이름 첫 글자를 원 안에 넣던 것을 걷어냈다(사용자 지시). 글자는 "무엇이
 * 들었는지"를 말하지 않는다 — 폴더 그림은 말한다.
 *
 * ## 카드를 누르면 **들어가지 않고 펼친다**
 *
 * 예전에는 곧장 그 공간의 가장 최근 방으로 들어갔다. 학생이 하려는 일은
 * 대개 "어제 하던 그 대화"를 잇는 것이라, 최근 방에 떨어뜨려 놓으면 들어가서
 * 지난 대화 서랍을 여는 걸음이 늘 따라붙었다. 이제 카드는 **그 공간의 방
 * 목록**을 팝업으로 편다(`RoomsDialog`).
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { classAvatarUrl, getSpacesOverview, type SpaceOverview } from "@/lib/api/spaces";
import { getRecentRooms, getSpaceRooms, type RoomRow } from "@/lib/api/rooms";
import { deleteSession, joinClass, patchSession } from "@/lib/api";
import { PAGE_BG, PERSONAL_CARD_BG } from "@/lib/ui/surface";
import { useAuthedImage } from "@/lib/ui/useAuthedImage";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { ConceptChips } from "./ConceptChips";
import { RoomList } from "./RoomList";
import { RoomsDialog } from "./RoomsDialog";

/**
 * 한 카드에 넣을 분류 수 상한. 넘치면 `…`로 접는다.
 *
 * **한 줄을 넘기지 않는다** — 칩이 두 줄이 되면 카드가 세로로 길어져
 * "가로가 긴 직사각형"(사용자 지시)이 아니게 된다.
 */
const CHIP_CAP = 3;

/** 학급 코드 칸 수. 이미지의 `___ - ___` 모양을 그대로 따른다. */
const CODE_LEN = 6;

/**
 * 폴더 그림.
 *
 * 아이콘 라이브러리의 윤곽선 폴더 대신 **채운 폴더**를 그린다 — 이미지의
 * 그것이 채운 형태이고, 윤곽선은 이 크기에서 가늘어 카드가 비어 보인다.
 */
function FolderMark({ size = 88 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 100 80" aria-hidden focusable="false">
      {/* 뒤판 — 탭이 붙은 몸통 */}
      <path
        d="M4 14a6 6 0 0 1 6-6h26l8 9h40a6 6 0 0 1 6 6v49a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z"
        fill="var(--accent-deep)"
        opacity="0.55"
      />
      {/* 앞판 — 살짝 밝게 겹쳐 두께를 만든다 */}
      <path
        d="M4 30a6 6 0 0 1 6-6h80a6 6 0 0 1 6 6v42a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z"
        fill="var(--accent)"
      />
    </svg>
  );
}

function SpaceCard({ space, onOpen }: { space: SpaceOverview; onOpen: () => void }) {
  const isPersonal = space.space_kind === "personal";
  /**
   * ⚠️ **사진은 받아 와서 그린다.** 주소를 `<img src>`에 그대로 넣으면
   * 브라우저가 Authorization 없이 받으러 가고, 창구는 401을 준다 — 실측
   * 2026-08-10: 사진을 올린 학급도 폴더 그림으로만 보였다(폴백이 그럴싸해서
   * 아무도 못 알아챘다). D178이 도판에서 만난 벽과 같은 벽이다.
   */
  const avatar = useAuthedImage(
    !isPersonal && space.has_avatar
      ? classAvatarUrl(space.space_ref, space.avatar_version)
      : null,
  );

  return (
    <button
      type="button"
      onClick={onOpen}
      // 테스트가 잡는 손잡이. 최근 목록의 줄도 같은 이름을 갖고 있어(그 방이
      // 어느 공간의 것인지 말한다) 글자만으로는 카드와 줄을 못 가른다.
      data-space-card={`${space.space_kind}:${space.space_ref}`}
      /**
       * **가로가 긴 직사각형**이다 (사용자 지시 2026-08-09).
       *
       * 높이를 못 박지 않으면 격자가 행마다 가장 높은 카드에 맞춰 늘려서
       * 정사각형이 된다(실측: 224×224). 넘치는 것은 잘라 낸다 — 분류 칩은
       * 어차피 `…`로 줄이는 것이라, 한 줄이 안 들어가면 그게 그 카드의 답이다.
       *
       * 크기는 사용자 지시로 한 단계 키웠다(176 → 208, 폭 220 → 280).
       */
      className="group flex h-[208px] flex-col items-center gap-2 overflow-hidden rounded-2xl border border-accent-border/50 px-5 py-5 text-center transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
      // 개인 세션만 **아주 연한 연두**다(사용자 지시) — 언제나 첫 칸인 자리를
      // 색으로도 갈라 둔다.
      style={{ background: isPersonal ? PERSONAL_CARD_BG : "var(--bg-elevated)" }}
    >
      <div className="flex h-[76px] w-full shrink-0 items-center justify-center overflow-hidden">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt="" className="h-[76px] w-[76px] rounded-xl object-cover" />
        ) : (
          // 아직 받는 중이거나 사진이 없다 — 둘 다 폴더로 간다.
          <FolderMark size={86} />
        )}
      </div>

      <div className="w-full truncate text-[17px] font-semibold text-fg">
        {isPersonal ? "개인 세션" : space.name}
      </div>

      {/* 자료·강의는 **한 줄**이다(사용자 지시). 개인 세션에는 없으므로
          대화방 수를 대신 보여 준다 — 빈 줄을 두면 카드가 무너져 보인다. */}
      <div className="text-[13px] text-fg-muted">
        {isPersonal
          ? `대화방 ${space.sessions}개`
          : `자료 ${space.materials}개 · 강의 ${space.lectures}개`}
      </div>

      <div className="flex w-full justify-center">
        <ConceptChips concepts={space.concepts} cap={CHIP_CAP} size={12} />
      </div>
    </button>
  );
}

export function SpacePicker() {
  const router = useRouter();
  const qc = useQueryClient();
  const [code, setCode] = useState<string[]>(Array(CODE_LEN).fill(""));
  const [msg, setMsg] = useState<string | null>(null);
  /** 팝업으로 펼친 공간. null이면 안 펼쳤다. */
  const [picked, setPicked] = useState<SpaceOverview | null>(null);
  /** 방을 고치다 생긴 말 — 팝업 안에 뜬다. */
  const [roomMsg, setRoomMsg] = useState<string | null>(null);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["spaces", "overview"],
    queryFn: getSpacesOverview,
    staleTime: 60_000,
  });

  const roomsKey = ["spaces", "rooms", picked?.space_kind, picked?.space_ref];
  const { data: rooms, isLoading: roomsLoading } = useQuery({
    queryKey: roomsKey,
    queryFn: () => getSpaceRooms(picked!.space_kind, picked!.space_ref),
    enabled: picked != null,
    staleTime: 30_000,
  });

  const { data: recent } = useQuery({
    queryKey: ["spaces", "recent"],
    queryFn: getRecentRooms,
    staleTime: 30_000,
  });

  const join = useMutation({
    mutationFn: (c: string) => joinClass(c),
    onSuccess: async () => {
      setCode(Array(CODE_LEN).fill(""));
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
  const joined = code.join("").trim();

  /** 라우트에서 쓰는 공간 id — 개인은 'personal', 학급은 uuid다. */
  const routeId = (r: { space_kind: string; space_ref: string }) =>
    r.space_kind === "personal" ? "personal" : r.space_ref;

  /**
   * 방으로 들어간다.
   *
   * ⚠️ **공간도 함께 적는다.** `activeSessionId`만 두면 학급 공간에서 개인
   * 세션이 열린다(D148) — 스토어가 둘을 대조해 어긋나면 없는 것으로 친다.
   */
  const openRoom = (room: RoomRow) => {
    const spaceId = routeId(room);
    setActiveSpace(spaceId);
    setActiveSession(room.id, spaceId);
    router.push(`/space/${spaceId}`);
  };

  /**
   * 방 목록을 다시 읽는다. 셋을 함께 — 이름·개수가 세 화면에 흩어져 있다.
   */
  const refreshRooms = async () => {
    await qc.invalidateQueries({ queryKey: ["spaces", "rooms"] });
    await qc.invalidateQueries({ queryKey: ["spaces", "recent"] });
    await qc.invalidateQueries({ queryKey: ["spaces", "overview"] });
    /**
     * ⚠️ **캔버스 쪽 목록도 함께 턴다.**
     *
     * 방 이름은 세 곳에 나온다: 여기 팝업 · 캔버스 상단 바 · 지난 대화 서랍.
     * 뒤의 둘은 `["sessions", …]` 캐시를 보는데, 그것을 안 털면 이름을 바꾸고
     * 그 방에 들어갔을 때 **옛 이름이 그대로** 있다(캐시가 살아 있는 동안).
     * 학생 눈에는 "바꿨는데 안 바뀌었다"이고, 다시 눌러 보게 만든다.
     */
    await qc.invalidateQueries({ queryKey: ["sessions"] });
  };

  /**
   * ⚠️ **실패를 삼키지 않는다.**
   *
   * 이름 변경·삭제는 주인만 된다(RLS). 화면은 이제 남의 방에 ⋮를 안 붙이지만,
   * 그 사이에 다른 곳에서 지워졌거나 서버가 안 될 수 있다 — 그때 아무 말도
   * 없으면 학생은 **눌렀는데 안 됐다는 것조차** 모른다.
   */
  const renameRoom = async (room: RoomRow, title: string) => {
    try {
      await patchSession(room.id, title);
      await refreshRooms();
    } catch {
      setRoomMsg("이름을 바꾸지 못했어요. 잠시 뒤 다시 해 주세요.");
    }
  };

  const removeRoom = async (room: RoomRow) => {
    // 지우는 것은 되돌릴 수 없다 — 방 안의 카드가 함께 사라진다.
    if (!window.confirm(`"${room.title.trim() || "제목 없는 대화"}" 대화방을 삭제할까요?`))
      return;
    try {
      await deleteSession(room.id);
      await refreshRooms();
    } catch {
      setRoomMsg("대화방을 지우지 못했어요. 내가 만든 방만 지울 수 있어요.");
    }
  };

  /**
   * 칸 하나에 글자 하나. 채우면 다음 칸으로, 지우면 앞 칸으로 간다 —
   * 여섯 칸을 손으로 옮겨 다니게 하면 입력이 일이 된다.
   */
  const setAt = (i: number, v: string) => {
    const ch = v.replace(/\s/g, "").slice(-1).toUpperCase();
    setCode((prev) => {
      const next = [...prev];
      next[i] = ch;
      return next;
    });
    if (ch) {
      const el = document.querySelector<HTMLInputElement>(`[data-code-cell="${i + 1}"]`);
      el?.focus();
    }
  };

  return (
    /**
     * 바닥은 **홈·설정·도움말과 같은 색**이다(`lib/ui/surface.ts`). 화면을
     * 통째로 덮어야 하므로 스크롤 컨테이너가 아니라 **바깥에** 칠한다.
     */
    <div className="min-h-full w-full" style={{ background: PAGE_BG }}>
      {/* 레이아웃이 이미 `<main>`이다 — 여기서 또 쓰면 랜드마크가 둘이 된다. */}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-12 py-10">
        <header>
          <h1 className="text-[30px] font-bold text-fg">내 세션</h1>
          <p className="mt-1 text-[15px] text-fg-muted">
            속한 학급을 확인하고 관리할 수 있어요.
          </p>
        </header>

        {/* 학급 코드로 들어가기 — 이미지의 그 상자다. */}
        <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-accent-border/40 bg-accent-soft/25 px-7 py-6">
          <div className="mr-auto">
            <div className="text-[17px] font-semibold text-fg">내 학급 추가하기</div>
            <p className="mt-0.5 text-[14px] text-fg-muted">
              선생님께 받은 PIN 번호를 입력해주세요.
            </p>
          </div>

          <form
            /**
             * ⚠️ **줄이 넘치면 접힌다.** 칸 여섯 + 하이픈 + [추가하기]는 400px
             * 남짓이라 폰(390px)에서는 뒤쪽 두 칸과 버튼이 **잘려 나갔다**
             * (실측 2026-08-10) — 학급 코드를 아예 넣을 수 없었다.
             */
            className="flex flex-wrap items-center justify-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!joined || join.isPending) return;
              setMsg(null);
              join.mutate(joined);
            }}
          >
            {Array.from({ length: CODE_LEN }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  data-code-cell={i}
                  value={code[i]}
                  onChange={(e) => setAt(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" && !code[i] && i > 0) {
                      document
                        .querySelector<HTMLInputElement>(`[data-code-cell="${i - 1}"]`)
                        ?.focus();
                    }
                  }}
                  inputMode="text"
                  maxLength={1}
                  aria-label={`학급 코드 ${i + 1}번째 자리`}
                  // 좁은 화면에서는 칸도 조금 줄인다 — 여섯이 한 줄에 들어가야
                  // "코드 여섯 자리"라는 모양이 유지된다.
                  className="h-13 w-12 rounded-xl border border-accent-border/60 bg-bg-elevated py-3 text-center text-xl font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent-deep max-[520px]:h-11 max-[520px]:w-9 max-[520px]:text-base"
                />
                {/* 이미지의 가운데 하이픈 — 여섯 자리를 셋씩 끊어 읽게 한다. */}
                {i === 2 && <span className="px-1 text-fg-muted">–</span>}
              </div>
            ))}
            <button
              type="submit"
              disabled={!joined || join.isPending}
              className="ml-2 rounded-full bg-accent-deep px-6 py-3 text-[15px] font-semibold text-accent-fg transition-opacity disabled:opacity-40"
            >
              {join.isPending ? "넣는 중…" : "추가하기"}
            </button>
          </form>
        </section>
        {msg && <p className="text-[14px] text-fg-muted">{msg}</p>}

        <section className="flex flex-col gap-4">
          <h2 className="text-[17px] font-semibold text-fg">나의 세션 목록</h2>

          {isLoading && <p className="text-sm text-fg-muted">불러오는 중이에요…</p>}
          {isError && (
            <p className="text-sm text-fg-muted">목록을 못 불러왔어요. 새로고침해 주세요.</p>
          )}

          {/**
           * 가로가 긴 상자를 여러 열로. `minmax(280px, 1fr)`이라 좁아지면 열
           * 수만 준다 — 상자마다 다른 크기를 두면 목록이 들쭉날쭉해진다.
           */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-5">
            {spaces.map((s) => (
              <SpaceCard
                key={`${s.space_kind}:${s.space_ref}`}
                space={s}
                onOpen={() => setPicked(s)}
              />
            ))}
          </div>
        </section>

        {/**
         * 최근 대화 — **공간을 안 고르고 바로 잇는 길** (사용자 지시).
         *
         * 위 목록이 "어디로 갈까"라면 여기는 "하던 것 잇기"다. ⋮는 없다 —
         * 여러 공간의 방이 섞여 있어 지우고 나면 어디 것을 지웠는지 되짚을
         * 자리가 없다.
         */}
        <section className="flex flex-col gap-3">
          <h2 className="text-[17px] font-semibold text-fg">최근 대화</h2>
          <div className="rounded-2xl border border-accent-border/40 bg-bg-elevated px-3 py-2">
            <RoomList
              rooms={recent ?? []}
              onOpen={openRoom}
              showSpace
              empty="아직 대화가 없어요. 위에서 세션을 골라 시작해 보세요."
            />
          </div>
        </section>
      </div>

      {picked && (
        <RoomsDialog
          title={picked.space_kind === "personal" ? "개인 세션" : picked.name}
          rooms={rooms ?? []}
          loading={roomsLoading}
          onOpen={openRoom}
          onRename={renameRoom}
          onDelete={removeRoom}
          message={roomMsg}
          onClose={() => {
            setRoomMsg(null);
            setPicked(null);
          }}
        />
      )}
    </div>
  );
}
