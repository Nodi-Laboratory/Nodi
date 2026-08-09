/**
 * 펜 표시 실험실의 붙박이 캔버스 (D178).
 *
 * **아이템은 진짜 `CanvasItem`이다.** 실험실 전용 타입을 만들면 그 타입만
 * 맞고 실제 경로는 다른 상황이 된다 — `RagLabTab`이 채팅과 같은 검색 함수를
 * 태우는 것과 같은 이유다. 여기서 만든 것을 `ItemLayer`가 그대로 그리고
 * `captureInk`가 그대로 읽는다.
 *
 * 세 카드 중 **하나에만** 도판과 강의 클립이 딸린다(D163: 곁들이는 카드의
 * `parentItemId`를 받아 오른쪽 옆에 붙는다). 셋 다 붙이면 화면이 곁들이로
 * 덮여서 정작 "화살표가 어느 카드를 가리키나"를 시험할 수 없다.
 */

import type { CanvasItem } from "@/lib/canvas2/types";

const SESSION = "ink-lab";

/**
 * 자리를 **고정한다**(`pinned: true`).
 *
 * 배치 엔진에 맡기면 태그마다 열 하나(D123)라 세 카드가 월드에서 1,900px
 * 넘게 벌어진다. 실험실 칸에서는 카드 한 장만 보이고, **화살표로 다른 카드를
 * 가리키는 시험 자체를 할 수 없다.**
 *
 * 카메라를 나중에 맞추는 길도 있었는데 `ExcalidrawLayer`가 그걸 막는다 —
 * 마운트 직후의 명령형 카메라는 되돌아간다(그 파일 주석). 문서화된 길은
 * `initialCamera`이고, 그건 **좌표를 미리 알아야** 쓸 수 있다.
 *
 * `pinned: true`는 지어낸 상태가 아니다 — 학생이 카드를 끌어다 놓으면
 * 그렇게 된다(D122). 실제로 있을 수 있는 화면이다.
 */
const GAP_X = 620; // ITEM_W(560) + 60
const GAP_Y = 430;

/** 다섯 아이템이 차지하는 월드 상자 — `initialCamera`를 여기서 뽑는다. */
export const LAB_WORLD = { x: -80, y: -80, w: GAP_X * 2 + 560 + 160, h: GAP_Y + 420 };

function concept(
  id: string,
  tag: string,
  title: string,
  body: string,
  seq: number,
  x: number,
  y: number,
): CanvasItem {
  return {
    id,
    sessionId: SESSION,
    nodeId: null,
    parentItemId: null,
    kind: "concept",
    source: "ai",
    title,
    body,
    tag,
    x,
    y,
    pinned: true,
    seq,
    data: {},
  };
}

/**
 * 실험실 카드 세 장 + 곁들이 둘.
 *
 * `figureId`는 이 기계의 실제 도판 id를 받는다 — 없으면 `null`로 두고 그때는
 * 도판 아이템을 빼지 않고 **주소 없는 채로** 둔다. 그 상태(D167: 도판은 주소가
 * 없는 것이 정상이다)도 시험 대상이기 때문이다.
 */
export function labItems(figureId: string | null): CanvasItem[] {
  const geo = concept(
    "lab-card-1",
    "지구과학",
    "지질학",
    "지각은 여러 개의 **판**으로 나뉘어 있고, 이 판들이 맨틀 위를 천천히 움직입니다. " +
      "판과 판이 부딪히는 곳에서 습곡 산맥이 솟고, 벌어지는 곳에서는 새 지각이 만들어집니다. " +
      "지진과 화산은 대부분 이 경계에서 일어납니다.",
    0,
    0,
    0,
  );
  const astro = concept(
    "lab-card-2",
    "천문학",
    "천문학",
    "별은 수소를 태워 빛을 냅니다. 연료가 떨어지면 부풀어 적색거성이 되고, " +
      "질량이 크면 초신성으로 폭발하며 무거운 원소를 우주에 뿌립니다. " +
      "우리 몸의 탄소와 철은 그렇게 만들어진 것입니다.",
    1,
    GAP_X,
    0,
  );
  const bio = concept(
    "lab-card-3",
    "생명과학",
    "생명공학",
    "유전자 가위는 DNA의 특정 자리를 잘라 내는 도구입니다. " +
      "자른 자리를 세포가 스스로 메우면서 유전자의 기능이 꺼지거나 바뀝니다. " +
      "농작물 품종 개량과 유전 질환 치료 연구에 쓰입니다.",
    2,
    GAP_X * 2,
    0,
  );

  // 곁들이는 **지질학 카드에** 딸린다 (D163: parentItemId + ATTACH_KINDS).
  const figure: CanvasItem = {
    id: "lab-figure-1",
    sessionId: SESSION,
    nodeId: null,
    parentItemId: geo.id,
    kind: "figure",
    source: "ai",
    title: null,
    body: "",
    tag: geo.tag,
    x: 0,
    y: GAP_Y,
    pinned: true,
    seq: 3,
    data: {
      figure: {
        figureId: figureId ?? "lab-figure-missing",
        fileId: "lab",
        page: 128,
        caption: "판 경계에서 일어나는 지각 변동",
        url: "",
      },
    },
  };

  const clip: CanvasItem = {
    id: "lab-clip-1",
    sessionId: SESSION,
    nodeId: null,
    parentItemId: geo.id,
    kind: "clip",
    source: "ai",
    title: null,
    body: "",
    tag: geo.tag,
    x: GAP_X,
    y: GAP_Y,
    pinned: true,
    seq: 4,
    data: {
      clip: {
        clipId: "lab-clip",
        title: "판 구조론과 지각 변동",
        startSec: 0,
        timelineLabel: "00:00",
        pageUrl: "https://mid.ebs.co.kr/course/view?courseId=10021565",
        videoTitle: "EBS 중학 과학 · 지구의 변동",
      },
    },
  };

  return [geo, astro, bio, figure, clip];
}

