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
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { classAvatarUrl, getSpacesOverview, type SpaceOverview } from "@/lib/api/spaces";
import { getRecentRooms, getSpaceRooms, type RoomRow } from "@/lib/api/rooms";
import { createSession, deleteSession, patchSession, leaveClass} from "@/lib/api";
import { PAGE_BG, PERSONAL_CARD_BG } from "@/lib/ui/surface";
import { useAuthedImage } from "@/lib/ui/useAuthedImage";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useProfile } from "@/lib/hooks";
import { ConceptChips } from "./ConceptChips";
import { RoomsDialog } from "./RoomsDialog";
import { RecentChatsDialog } from "./RecentChatsDialog";
import { JoinClassDialog } from "./JoinClassDialog";

/**
 * 한 카드에 넣을 분류 수 상한. 넘치면 `…`로 접는다.
 *
 * **한 줄을 넘기지 않는다** — 칩이 두 줄이 되면 카드가 세로로 길어져
 * "가로가 긴 직사각형"(사용자 지시)이 아니게 된다.
 */
const CHIP_CAP = 3;


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
      /* 윤곽선을 걷어내고 그림자로 띄운다(사용자 지시 2026-08-11) — 바닥이
         회색이 되면서 흰 카드가 선 없이도 떠 보인다. */
      className="group flex h-[208px] flex-col items-center gap-2 overflow-hidden rounded-2xl px-5 py-5 text-center transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-deep"
      // 개인 세션만 **아주 연한 연두**다(사용자 지시) — 언제나 첫 칸인 자리를
      // 색으로도 갈라 둔다.
      style={{
        background: isPersonal ? PERSONAL_CARD_BG : "var(--bg-elevated)",
        boxShadow: "var(--shadow-float)",
      }}
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

      <div className="font-brand w-full truncate text-[17px] font-medium text-fg">
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
  /** 팝업으로 펼친 공간. null이면 안 펼쳤다. */
  const [picked, setPicked] = useState<SpaceOverview | null>(null);
  /** 방을 고치다 생긴 말 — 팝업 안에 뜬다. */
  const [roomMsg, setRoomMsg] = useState<string | null>(null);
  /** 새 방을 만드는 중인가. 두 번 눌러 방이 둘 생기지 않게 한다. */
  const [creating, setCreating] = useState(false);
  const { data: profile } = useProfile();
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

  /** 팝업 둘 — 최근 대화 · 학급 추가. 주소를 안 바꾸므로 상태로 든다. */
  const [recentOpen, setRecentOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const {
    data: recent,
    isLoading: recentLoading,
    isError: recentError,
    refetch: refetchRecent,
  } = useQuery({
    queryKey: ["spaces", "recent"],
    queryFn: getRecentRooms,
    staleTime: 30_000,
  });


  const profileName = profile?.display_name?.trim() || null;
  const spaces = useMemo(() => data ?? [], [data]);

  /** 라우트에서 쓰는 공간 id — 개인은 'personal', 학급은 uuid다. */
  const routeId = (r: { space_kind: string; space_ref: string }) =>
    r.space_kind === "personal" ? "personal" : r.space_ref;

  /**
   * 방으로 들어간다.
   *
   * ⚠️ **공간도 함께 적는다.** `activeSessionId`만 두면 학급 공간에서 개인
   * 세션이 열린다(D148) — 스토어가 둘을 대조해 어긋나면 없는 것으로 친다.
   */
  /**
   * 지금 펼친 공간에 방을 새로 만들고 **그 방으로 들어간다**.
   *
   * ⚠️ D202가 걸려 있다 — 그 공간의 가장 최근 방이 비어 있으면 서버가 새로
   * 만들지 않고 **그 행을 돌려준다.** 그래서 여기서 "새 방이 생겼다"를
   * 단정하지 않고, 돌려받은 방으로 그냥 들어간다(빈 방이 둘 쌓이지 않는다).
   */

  /**
   * 이 학급에서 나간다 (사용자 지시 2026-08-12).
   *
   * **지워지는 것은 멤버십 한 행뿐**이다 — 대화·카드는 그대로 남는다(창구
   * 주석 참조). 그래서 성공하면 목록만 다시 받으면 된다.
   *
   * ⚠️ 목록을 무르기 **전에** 팝업을 닫는다. 안 닫으면 방금 나간 학급의 방
   * 목록을 계속 띄운 채 그 학급이 카드에서 사라지는, 앞뒤가 안 맞는 화면이
   * 한 박자 보인다.
   */
  const [leaving, setLeaving] = useState(false);
  const leaveThisClass = async () => {
    if (!picked || picked.space_kind !== "class" || leaving) return;
    setLeaving(true);
    try {
      await leaveClass(picked.space_ref);
      setPicked(null);
      setRoomMsg(null);
      await qc.invalidateQueries({ queryKey: ["spaces", "overview"] });
      await qc.invalidateQueries({ queryKey: ["my-classes"] });
    } catch (e) {
      const st = (e as { status?: number })?.status;
      setRoomMsg(
        st === 409
          ? "이 학급을 만든 선생님은 나갈 수 없습니다."
          : "지금은 나갈 수 없어요. 잠시 뒤 다시 해 주세요.",
      );
    } finally {
      setLeaving(false);
    }
  };

  const newRoom = async () => {
    if (!picked || creating) return;
    setCreating(true);
    setRoomMsg(null);
    try {
      const made = await createSession({
        space_kind: picked.space_kind,
        space_ref: picked.space_kind === "personal" ? null : picked.space_ref,
      });
      await qc.invalidateQueries({ queryKey: ["spaces", "rooms"] });
      await qc.invalidateQueries({ queryKey: ["spaces", "recent"] });
      openRoom({
        id: made.id,
        title: made.title ?? "",
        updated_at: made.updated_at ?? null,
        space_kind: picked.space_kind,
        space_ref: picked.space_ref,
        space_name: picked.space_kind === "personal" ? null : picked.name,
        concepts: [],
        is_mine: true,
      });
    } catch {
      setRoomMsg("지금은 새 대화를 못 만들었어요. 잠시 뒤 다시 해 주세요.");
    } finally {
      setCreating(false);
    }
  };

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


  return (
    /**
     * 바닥은 **홈·설정·도움말과 같은 색**이다(`lib/ui/surface.ts`). 화면을
     * 통째로 덮어야 하므로 스크롤 컨테이너가 아니라 **바깥에** 칠한다.
     */
    <div className="min-h-full w-full" style={{ background: PAGE_BG }}>
      {/* 레이아웃이 이미 `<main>`이다 — 여기서 또 쓰면 랜드마크가 둘이 된다. */}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-7 px-12 py-10">
        {/**
         * **`내 세션` 대제목을 걷어냈다** (요구사항 3-1).
         *
         * 사이드바에 이미 `세션`이 켜져 있어 같은 말을 두 번 하고 있었고,
         * 그 한 줄이 카드 목록을 아래로 밀었다. 안내 문구만 남긴다.
         */}
        <header className="flex items-start justify-between gap-4">
          <p className="font-brand text-[24px] font-medium leading-snug text-fg">
            속한 학급을 확인하고
            <br />
            관리할 수 있어요.
          </p>

          {/**
           * 최근 대화는 **눌러야 나온다**(요구사항 4-1). N은 실제 데이터다 —
           * 숫자가 붙어 있는데 실제와 다르면 그 버튼을 못 믿게 된다.
           */}
          <button
            type="button"
            onClick={() => setRecentOpen(true)}
            className="flex shrink-0 items-center gap-2 rounded-full px-5 py-3 text-[15px] font-semibold text-fg transition-colors"
            style={{
              background: "#ffffff",
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-float)",
            }}
          >
            최근 대화
            <span style={{ color: "var(--accent-mid)" }}>{recent?.length ?? 0}</span>
          </button>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="font-brand text-[15px] font-medium text-fg">
            {profileName ? `${profileName}님의 세션 목록` : "나의 세션 목록"}
          </h2>

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

            {/**
             * **학급 추가하기 카드** (요구사항 3-4).
             *
             * 상시 노출되던 6칸 PIN 상자를 걷어낸 자리다. 그 상자는 학급을
             * 넣을 때만 쓰는데 화면 맨 위에서 늘 자리를 차지했다 — 목록을
             * 보러 온 사람에게는 매번 넘겨야 하는 줄이었다.
             *
             * 점선 테두리는 "여기에 더 넣을 수 있다"는 뜻이다. 채워진 카드와
             * 같은 실선이면 이미 있는 학급처럼 보인다.
             */}
            <button
              type="button"
              onClick={() => setJoinOpen(true)}
              data-add-class
              className="flex min-h-[150px] flex-col items-center justify-center gap-1.5 rounded-2xl transition-colors hover:bg-accent-soft/25"
              style={{
                background: "#ffffff",
                border: "1.5px dashed var(--accent-border)",
              }}
            >
              <Plus size={26} style={{ color: "var(--accent-mid)" }} aria-hidden />
              <span
                className="text-[15px] font-semibold"
                style={{ color: "var(--accent-deep)" }}
              >
                학급 추가하기
              </span>
              <span className="text-[13px] text-fg-muted">
                PIN 번호로 학급을 추가해요.
              </span>
            </button>
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
          onNewRoom={() => void newRoom()}
          creating={creating}
          {...(picked.space_kind === "class"
            ? { onLeave: () => void leaveThisClass(), leaving }
            : {})}
          onClose={() => {
            setRoomMsg(null);
            setPicked(null);
          }}
        />
      )}

      {/**
       * 최근 대화 — 우상단 버튼으로만 연다(요구사항 4-1). 데이터는 이 화면이
       * 이미 갖고 있으므로 팝업은 **그리기만** 한다.
       */}
      <RecentChatsDialog
        open={recentOpen}
        onClose={() => setRecentOpen(false)}
        rooms={recent ?? []}
        loading={recentLoading}
        error={recentError}
        onRetry={() => void refetchRecent()}
        onOpenRoom={(r) => {
          setRecentOpen(false);
          openRoom(r);
        }}
        /* "전체 대화 보기" — 방 목록을 여는 것이 곧 전체 보기다. */
        onSeeAll={() => {
          setRecentOpen(false);
          setPicked(spaces[0] ?? null);
        }}
      />

      <JoinClassDialog open={joinOpen} onClose={() => setJoinOpen(false)} />
    </div>
  );
}
