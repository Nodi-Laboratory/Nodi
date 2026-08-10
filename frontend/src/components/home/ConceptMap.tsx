"use client";

/**
 * 개념 지도 (D189) — 지금까지 대화한 개념 전부를 한 장에.
 *
 * 캔버스의 지도(D151 Minimap)가 **세션 하나**를 보여 준다면 이쪽은 **전부**다.
 * 홈이 "언제 대화했는지"만 말하던 것을 "내가 무엇을 아는가"로 바꾼다.
 *
 * ## 왜 캔버스인가
 *
 * Minimap은 SVG다 — 노드 수십 개에는 그게 맞다(요소마다 이벤트·CSS가 붙는다).
 * 여기는 카드 1,200장에 선 수천 개라 DOM 요소가 그만큼 생기면 힘 배치가 매
 * 틱마다 그 전부를 건드린다. 캔버스는 한 장에 그린다.
 *
 * ## 자리는 의미가, 이름은 분류가 정한다
 *
 * 좌표는 서버가 주지 않는다(화면 크기마다 달라야 한다). 서버가 주는 것은
 * **비슷한 것끼리의 선**이고, 힘 배치가 그 선을 당겨 뭉치게 한다. 무리 이름은
 * 분류 태그를 쓴다 — 그래프에서 무리를 찾아내면 이름을 못 붙이는데, 학생에게
 * "무리 3"은 아무 뜻도 없다.
 *
 * ## 같은 지도여야 한다
 *
 * 시작 자리를 id에서 뽑는다(`seedPositions`). d3에 맡기면 배열 순서로 뿌려서
 * **카드 하나가 늘 때마다 지도 전체가 다시 배치된다** — 어제 왼쪽 위에 있던
 * 무리가 오늘 오른쪽에 있으면 그건 지도가 아니라 매번 새 그림이다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom as d3zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type Simulation,
} from "d3";
import { MapZoomControls } from "@/components/home/MapZoomControls";
import type { ConceptMapData, ConceptNode } from "@/lib/api/conceptMap";
import { pastelForTag } from "@/lib/ui/pastel";
import { useClientSettings } from "@/lib/canvas2/useClientSettings";
import {
  boundsOf,
  clusterLabels,
  degrees,
  pickSpacedLabels,
  seedPositions,
  tierFor,
  type PlacedNode,
} from "@/lib/home/conceptLayout";

/** 힘 배치가 쓰는 노드 — d3가 x/y/vx/vy를 여기에 직접 쓴다. */
interface SimNode extends PlacedNode {
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  /**
   * 배열에서의 자리 — **d3가 채운다**(`SimulationNodeDatum.index`).
   *
   * 이웃 표(`nbr`)를 만들 때 링크의 양 끝에서 읽는다. 선언이 없으면
   * `npm run build`가 죽는데 `tsc --noEmit`은 그냥 지나갈 수 있다 —
   * 증분 캐시(`tsconfig.tsbuildinfo`)가 이 파일을 다시 안 볼 때가 있어서다.
   * **빌드가 정본이다**(2026-08-10 배포 실패로 확인).
   */
  index?: number;
  /**
   * 프레임마다 다시 구할 이유가 없는 값들 (2026-08-10 최적화).
   *
   * 색은 태그 해시, 반지름은 연결 수에서 나온다 — **둘 다 안 변한다.**
   * 매 프레임 1,200번씩 해시를 돌리고 있었다.
   */
  _color?: string;
  _r?: number;
  /**
   * **제자리** — 예열이 끝난 순간의 좌표 (2026-08-10).
   *
   * 떠다니는 것은 이 자리 **주위의 진동**이지 새 배치가 아니다. 붙들어 두지
   * 않으면 링크가 계속 당겨 무리가 천천히 오그라든다(실측: 30초에 430 → 312).
   */
  ax?: number;
  ay?: number;
}

interface SimEdge {
  source: SimNode | string;
  target: SimNode | string;
  distance: number;
}

export interface ConceptMapProps {
  data: ConceptMapData;
  /** 노드를 눌렀다 — 그 대화의 그 카드로 간다. */
  onOpen: (node: ConceptNode) => void;
  /**
   * 지도에서 **숨긴** 대화 (D191).
   *
   * 힘 배치는 이 값을 안 본다 — 자리는 전체 노드로 한 번 정해지고, 여기서는
   * **그리기만** 거른다. 필터마다 다시 배치하면 체크 하나에 지도 전체가
   * 헤엄치는데, 그건 D189가 명시적으로 버린 성질이다("어제 왼쪽 위에 있던
   * 무리가 오늘 오른쪽에 있으면 지도가 아니라 매번 새 그림이다").
   */
  hiddenSessions: ReadonlySet<string>;
  /**
   * **온전한 지도 보기** — 덮개도 글자도 없이 지도만 (사용자 지시 2026-08-10).
   *
   * 켜지면 떠다니던 노드가 **서서히 멈춘다**. 뚝 멈추면 그 순간이 고장으로
   * 읽히고, 글자가 사라지는 것과 리듬이 맞아야 한 동작으로 보인다.
   */
  quiet?: boolean;
}

/** 시작 자리를 뿌릴 원판의 반지름. 화면과 무관한 월드 단위다. */
const SEED_RADIUS = 900;

/** 선을 그리는 최소 배율. 축소 상태에서 선까지 그리면 회색 판이 된다. */
const EDGE_MIN_ZOOM = 0.35;

/**
 * 떠다니는 세기 (사용자 지시 2026-08-10: "적당히 움직여야 해").
 *
 * 매 틱 노드마다 이만큼의 속도를 더한다. 흔들리는 **폭**은 이 값과
 * `ANCHOR_STRENGTH`의 비로 정해진다 — 여기만 올리면 더 크게 흔들린다.
 *
 * ⚠️ 한 번 1.05까지 올렸다가 **"너무 과하다"**는 지적을 받고 되돌렸다
 * (사용자 지시 2026-08-10). 배경으로 깔린 지도가 눈에 띄게 움직이면 그건
 * 배경이 아니라 방해다 — 있는 줄 알겠는 정도가 맞다. 실측(250ms 사이 변한
 * 픽셀): 0.3 → 4.5% · 1.05 → 9.6%.
 *
 * ⚠️ **방향은 난수가 아니라 연결이 정한다** (사용자 지시 2026-08-10:
 * "무작위로 움직이는 것보다 중력이나 장력 때문에 움직이는 것처럼"). 예전에는
 * 노드마다 제 각도를 갖고 그 각도가 천천히 돌았는데 — 흐름처럼은 보여도
 * 결국 **저마다 딴 데로 헤엄치는** 그림이라, 옆 노드와 아무 상관이 없었다.
 *
 * 지금은 이웃 쪽으로 당겼다 밀었다 한다(`drift`). 이웃이 곧 이 노드를 붙들고
 * 있는 선이므로, 화면에는 **선이 팽팽해졌다 느슨해지는 것**으로 보인다.
 * 이웃이 없는 노드는 가운데가 당긴다 — 그쪽은 중력이다.
 */
const DRIFT_FORCE = 0.3;
//   ↑ 아래 셋과 `FIT_BOOST`는 **기본값**이다. 관리자가 콘솔에서 바꾸면
//     (`home_drift_*`·`home_fit_boost`) 그 값이 이긴다 — 서버가 못 내려줄
//     때만 여기 값으로 돈다(D174와 같은 규약: 값이 없다고 화면이 멈추지 않는다).

/**
 * 한 번 밀고 당기는 데 걸리는 위상 진행(라디안/틱).
 *
 * 0.006이면 60fps에서 한 호흡이 약 17초다. 크면 호흡이 빨라져 다시 떨림으로
 * 보이고, 작으면 멈춘 것과 구별이 안 된다. **폭이 아니라 속도**를 정하는
 * 값이라, "천천히"는 여기를 내려서 얻는다.
 */
const DRIFT_BREATH = 0.006;

/**
 * 제자리로 당기는 세기 (2026-08-10).
 *
 * 진동 폭은 `DRIFT_FORCE`와 이 값의 **비**로 정해진다 — 미는 힘이 세지면
 * 폭이 커지고, 당기는 힘이 세지면 좁아진다. 그래서 "더 움직이게"는 앞의 값을
 * 올리는 것으로 끝나고, 무리가 흘러가지 않는 것은 이 값이 보장한다.
 *
 * ⚠️ d3의 `forceX/Y`는 세기에 **alpha를 곱한다**(여기서는 0.02). 그래서 이
 * 값은 커 보여도 실제로는 그 1/50이다 — 1보다 큰 값이 이상해 보인다면 그
 * 곱셈을 잊은 것이다.
 */
const ANCHOR_STRENGTH = 0.8;

/**
 * 떠다니는 동안 유지하는 시뮬레이션 온도.
 *
 * d3는 alpha가 이 값 아래로 안 내려가면 계속 돈다. 0.02는 밀어내기(collide)가
 * 살아 있을 만큼은 되고 배치가 무너지지 않을 만큼은 낮다 — 이게 "밀어내는
 * 느낌"의 정체다: 떠다니다 이웃에 닿으면 서로 비킨다.
 */
const DRIFT_ALPHA = 0.02;

/**
 * 멈추라는 신호를 받고 실제로 서기까지 걸리는 시간(ms).
 *
 * ⚠️ **틱 수가 아니라 시간이다.** 틱마다 일정 비율로 줄였더니 노드가 많은
 * 지도에서 틱이 느려 **9초가 지나도 안 멈췄다**(실측 2026-08-10, 개념 1,200개).
 * 같은 코드가 작은 지도에서는 2초에 섰다 — 화면의 리듬이 데이터 크기에 따라
 * 달라지면 그건 규칙이 아니다.
 *
 * 값은 덮개가 사라지는 시간(0.7초)보다 길다: 글자가 먼저 걷히고 노드가
 * 뒤따라 잦아드는 순서라야 한 동작으로 읽힌다(사용자 지시: "흐림이 사라짐과
 * 동시에 천천히 멈춰야 함").
 */
const DRIFT_STOP_MS = 1800;

/** 다시 떠다니기 시작할 때 붙는 시간(ms). 멈출 때보다 짧아야 답답하지 않다. */
const DRIFT_START_MS = 900;

/**
 * 자동 맞춤 뒤 한 번 더 당기는 배율 (사용자 지시 2026-08-10: "더 확대해서").
 *
 * 전체가 들어오게만 맞추면 무리가 화면 가운데 작은 얼룩으로 앉는다. 조금
 * 넘쳐도 **읽히는 크기**가 낫다 — 넘친 만큼은 끌어서 볼 수 있다.
 *
 * ⚠️ 1보다 크다는 것은 **가장자리가 잘린다**는 뜻이다. 1.28에서 한 번 더
 * 올렸다(사용자 지시 2026-08-10, 두 번째 요청). 무리는 가운데가 붐비고
 * 가장자리가 성기므로, 잘리는 것은 대개 외딴 노드 몇이고 **읽히는 크기**를
 * 얻는 대가로는 싸다 — 넘친 만큼은 끌어서 보면 된다.
 */
const FIT_BOOST = 1.62;

/**
 * **테두리 빛** — 점보다 조금 큰 원을 아주 옅게 두 겹 깐다.
 *
 * ⚠️ 예전에는 캔버스 `shadowBlur`를 썼다. 그림자는 **도형마다 블러 패스**가
 * 돌아서, 점 1,200개짜리 지도에서 프레임이 66ms(15fps)가 됐다 — 프로파일에서
 * 네이티브 페인트가 70.8%였다(실측 2026-08-10). 원 두 겹은 색깔별로 묶어
 * 한 번에 칠할 수 있어 **채우기 호출이 노드 수와 무관**해진다.
 *
 * 지금은 **점 하나를 통째로 미리 구워 둔다**(`sprite`). 색 × 반지름 조합이
 * 수십 개뿐이라 한 번 그려 놓고 프레임마다 `drawImage`로 복사만 하면 된다 —
 * 그러면 빛을 진짜 방사형 그라데이션으로 줄 수 있다. 한 번만 그리는 그림에는
 * 비싼 붓을 써도 된다.
 */
const GLOW_SCALE = 2.2;
const GLOW_ALPHA = 0.3;

/** 간선 농도를 몇 단으로 끊을까. 단마다 한 번씩만 긋는다. */
const EDGE_TIERS = 5;

const TAU = Math.PI * 2;

/** 툴팁 크기. 화면 밖으로 나가지 않게 접는 계산이 이 값을 쓴다. */
const TIP_W = 260;
const TIP_H = 110;

/**
 * 캔버스 글꼴.
 *
 * ⚠️ **`var(--font-ui)`를 쓰면 안 된다.** 캔버스의 `ctx.font`는 CSS 변수를
 * 모른다 — 문자열이 통째로 무효가 되어 **지정이 무시되고** 기본값(10px
 * sans-serif)이 남는다. 그 10px는 월드 단위라 확대하면 같이 커진다: 6배에서
 * 60px짜리 글자가 화면을 덮었다(실측 2026-08-06). 조용히 틀리는 종류다 —
 * 예외도 경고도 없고 글자는 그려지므로, 확대해 보기 전에는 멀쩡해 보인다.
 */
const CANVAS_FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;

/** 제목에 쓰는 최대 글자 수. 길면 옆 개념을 덮는다. */
const LABEL_MAX_CHARS = 18;

/** 제목 한 줄 높이(화면 px) — 겹침 판정의 세로 크기다. */
const LABEL_LINE = 14;

/**
 * 테마 토큰(헥스)에 알파를 입힌다 (D203).
 *
 * canvas 2D의 `ctx`는 CSS 변수를 못 읽으므로 `getComputedStyle`로 헥스를
 * 받아 오는데, 반투명하게 그으려면 rgba가 필요하다.
 *
 * 헥스가 아니면(`color-mix()` 같은 값으로 바뀌면) **알파를 포기하고 원래
 * 값을 그대로 돌려준다** — 선이 안 그려지는 것보다 불투명하게 그려지는
 * 쪽이 낫다. 여기서 던지면 지도 전체가 빈 화면이 된다.
 */
/**
 * 색 문자열은 **한 번만 만든다** (2026-08-10 최적화).
 *
 * 정규식 + parseInt + 템플릿이라 싸지 않은데, 프레임마다 간선 수만큼(수천 번)
 * 불리고 있었다. 결과는 색과 투명도만으로 정해지므로 그대로 쟁여 둔다.
 */
const alphaCache = new Map<string, string>();

function withAlpha(color: string, alpha: number): string {
  const key = `${color}|${alpha}`;
  const hit = alphaCache.get(key);
  if (hit !== undefined) return hit;
  const out = computeAlpha(color, alpha);
  // 색은 토큰 몇 개, 투명도는 단계가 유한하다 — 그래도 상한을 둔다.
  if (alphaCache.size < 512) alphaCache.set(key, out);
  return out;
}

function computeAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export function ConceptMap({ data, onOpen, hiddenSessions, quiet = false }: ConceptMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  /**
   * 위쪽 몇 px이 UI에 덮여 있나 (사용자 지시 2026-08-09).
   *
   * 홈이 `[data-map-overlay]`를 씌운다. **자리를 그때그때 잰다** — 프롭으로
   * 받으면 홈의 문구가 한 줄 늘 때마다 숫자를 손으로 옮겨야 하고, 그 숫자는
   * 반드시 어긋난다. ref에 담는 이유는 이 값이 렌더가 아니라 **d3 이펙트
   * 안에서** 쓰이기 때문이다.
   */
  const uiTopRef = useRef(0);
  /**
   * 움직임 값은 **관리자가 정한다** (사용자 지시 2026-08-10).
   *
   * ref에 담는 이유는 이 값들이 렌더가 아니라 **d3 이펙트 안에서** 쓰이기
   * 때문이다. state로 읽으면 값이 바뀔 때마다 시뮬레이션을 새로 짜게 되는데,
   * 그러면 배치가 처음부터 다시 잡혀 지도가 통째로 헤엄친다.
   */
  const settings = useClientSettings();
  const tuneRef = useRef({
    force: DRIFT_FORCE,
    breath: DRIFT_BREATH,
    anchor: ANCHOR_STRENGTH,
    boost: FIT_BOOST,
  });

  useEffect(() => {
    tuneRef.current = {
      force: settings.homeDriftForce,
      breath: settings.homeDriftBreath,
      anchor: settings.homeDriftAnchor,
      boost: settings.homeFitBoost,
    };
    // 제자리 스프링은 **이미 걸려 있는 힘**이라 세기를 직접 고쳐 준다 —
    // 다음 틱부터 새 값으로 당긴다(시뮬레이션을 다시 짜지 않는다).
    const sim = simRef.current;
    const fx = sim?.force("x") as { strength?: (v: number) => unknown } | undefined;
    const fy = sim?.force("y") as { strength?: (v: number) => unknown } | undefined;
    fx?.strength?.(settings.homeDriftAnchor);
    fy?.strength?.(settings.homeDriftAnchor);
  }, [settings]);

  /** 화면 변환. React state로 두면 팬/줌마다 전체가 다시 돈다(D124와 같은 이유). */
  const viewRef = useRef({ k: 0.5, x: 0, y: 0 });
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const hoverRef = useRef<SimNode | null>(null);
  const drawRef = useRef<() => void>(() => {});
  /**
   * 숨김 집합을 **ref로도** 들고 있는다 (D191).
   *
   * 프롭을 그리기 이펙트의 deps에 넣으면 체크 하나에 힘 배치가 통째로 다시
   * 선다 — 1,200노드가 매 클릭마다 재배치된다. 값은 ref로 흘리고 다시
   * 그리기만 부른다.
   */
  const hiddenRef = useRef<ReadonlySet<string>>(hiddenSessions);
  /**
   * 지금 떠다니는 세기(0~1). **ref다** — 매 틱 바뀌는 값이라 state로 두면
   * 프레임마다 React가 돈다(D124와 같은 이유).
   */
  const driftRef = useRef(1);
  /** 목표 세기. `quiet`가 켜지면 0으로 두고, **시간에 따라** 다가간다. */
  const driftTargetRef = useRef(1);
  /** 지금 결이 시작된 시각과 그때의 세기 — 진행도를 시간으로 잰다. */
  const driftFromRef = useRef({ at: 0, value: 1 });
  /** 시뮬레이션 온도를 다시 올릴 손잡이 — 조용히 있다가 깨어날 때 쓴다. */
  const wakeRef = useRef<(() => void) | null>(null);
  /**
   * 지금 온전한 지도 보기인가 — **맞춤 계산이 이 값을 본다.**
   *
   * ⚠️ 프롭을 그대로 쓰면 안 된다. 자동 맞춤(배치가 식었을 때·타이머)은 d3
   * 이펙트 안의 클로저에서 불리는데 그 클로저는 마운트 시점의 값을 들고 있다 —
   * 실측 2026-08-10: 모드를 켜서 상자 전체로 맞춘 **직후** 뒤늦은 자동 맞춤이
   * 옛 자리로 되돌려 놓아, 버튼을 눌러도 지도가 그대로인 것처럼 보였다.
   */
  const quietRef = useRef(quiet);

  /** 확대 버튼이 쓰는 손잡이. 이펙트 안에서만 만들 수 있어 ref로 꺼내 둔다. */
  const zoomApiRef = useRef<{
    zoomBy: (f: number) => void;
    fit: () => void;
    refit: (ignoreUi: boolean) => void;
  } | null>(null);

  /** hover한 개념 — 이것만 React가 안다(툴팁 하나 그리는 값이다). */
  const [hover, setHover] = useState<{ node: ConceptNode; sx: number; sy: number } | null>(
    null,
  );

  const sessionById = useMemo(
    () => new Map(data.sessions.map((s) => [s.id, s])),
    [data.sessions],
  );

  /**
   * 지금 보이는 개념 수.
   *
   * `session_id`가 없는 카드는 어느 대화에도 안 딸리므로 `""`로 조회되고,
   * 숨김 집합에 그런 키가 없어 **언제나 보인다** — 끌 수단이 없는 것을 꺼진
   * 것처럼 세면 "전부 숨겼습니다"가 거짓말이 된다.
   */
  /**
   * 배치가 아직 식는 중인가 (D211 1).
   *
   * d3 힘 시뮬레이션은 200틱 남짓 돌면서 매 틱 다시 그린다 — 학생이 보는 것은
   * 노드가 꿈틀대며 자리를 찾는 장면이고, 그게 "렉"으로 읽힌다(사용자 보고
   * 2026-08-08). 계산을 멈추지 않고 **가리기만** 한다: 멈췄다 한 번에 보여
   * 주면 그동안 계산이 안 돌아 오히려 더 오래 걸린다.
   */
  const [settling, setSettling] = useState(true);

  const visibleCount = useMemo(
    () =>
      data.nodes.reduce(
        (n, x) => (hiddenSessions.has(x.session_id ?? "") ? n : n + 1),
        0,
      ),
    [data.nodes, hiddenSessions],
  );

  // 숨김이 바뀌면 배치는 그대로 두고 **다시 그리기만** 한다.
  useEffect(() => {
    hiddenRef.current = hiddenSessions;
    drawRef.current();
  }, [hiddenSessions]);

  /**
   * 조용히 / 다시 떠다니기 (사용자 지시 2026-08-10).
   *
   * **목표만 바꾼다.** 여기서 시뮬레이션을 세우면 뚝 멈추고, 그 순간이
   * 고장으로 읽힌다 — 실제로 서는 것은 틱마다 조금씩이다(`DRIFT_EASE`).
   */
  useEffect(() => {
    quietRef.current = quiet;
    driftTargetRef.current = quiet ? 0 : 1;
    driftFromRef.current = { at: Date.now(), value: driftRef.current };
    if (!quiet) wakeRef.current?.();
    // 글자가 비켜난 만큼 지도가 자리를 넓힌다(그리고 돌아올 때 되돌린다).
    zoomApiRef.current?.refit(quiet);
  }, [quiet]);

  /**
   * 힘 배치 + 그리기.
   *
   * 데이터가 바뀔 때만 다시 세운다. 안에서 React state를 건드리지 않는다 —
   * 틱마다 setState하면 1,200개가 매 프레임 다시 렌더된다.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const deg = degrees(data.nodes, data.edges);
    const nodes: SimNode[] = seedPositions(data.nodes, SEED_RADIUS).map((n) => ({
      ...n,
      degree: deg.get(n.id) ?? 0,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: SimEdge[] = data.edges
      .filter((e) => byId.has(e.a) && byId.has(e.b))
      .map((e) => ({ source: e.a, target: e.b, distance: e.distance }));
    nodesRef.current = nodes;
    edgesRef.current = edges;

    // 색은 테마 토큰에서 읽는다 — 캔버스는 CSS 변수를 직접 못 쓴다.
    const css = getComputedStyle(document.documentElement);
    const tone = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback;
    const inkColor = tone("--fg", "#1e2418");
    const mutedColor = tone("--fg-muted", "#5f6656");
    const paperColor = tone("--bg-elevated", "#ffffff");
    /**
     * 선 색 (D203).
     *
     * `--c-live`(AI 초록)를 먼저 본다 — 캔버스와 같은 뜻의 선이기 때문이다.
     * 다만 그 토큰은 `.canvas2` 안에서만 정의되고 이 지도는 홈 화면이라,
     * 실제로는 **디자이너의 중간 톤 `--accent-mid`로 떨어진다.**
     *
     * 뒤를 `--accent-deep`(버튼용 어두운 초록)으로 뒀다가 화면에서 보고
     * 바꿨다 — 선은 알파 0.06~0.28로 옅게 긋는 것이라 어두운 값을 쓰면
     * 캔버스 괘선보다 칙칙한 카키로 깔린다. 여기는 글자를 얹는 자리가
     * 아니므로 밝은 쪽을 쓸 수 있다.
     *
     * **어느 쪽이든 브랜드 토큰이라 다음에 색을 바꿔도 여기가 따라온다** —
     * 예전에는 이 자리에 `rgba(160,101,3,…)`가 박혀 있어 토큰을 아무리
     * 고쳐도 조용히 오커로 남았고, 지도를 열어 봐야만 드러났다.
     */
    const linkColor = tone("--c-live", tone("--accent-mid", "#9ec92e"));

    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = wrap.getBoundingClientRect();
      width = r.width;
      height = r.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    /**
     * 점의 **화면상** 크기. 선이 많은 개념이 크다 — 여러 대화에 걸친 개념이
     * 지도의 이정표가 된다.
     *
     * 힘 배치(충돌 반경)는 월드 단위를 원하고 그리기는 화면 단위를 원한다.
     * 둘을 같은 값으로 쓰면 **확대할수록 점이 부풀어** 화면이 색 덩어리가 된다
     * (실측 2026-08-06). 지도의 점은 확대해도 같은 크기다 — 도시 점이 커지지
     * 않는 것과 같다.
     */
    function nodeScreenRadius(n: SimNode): number {
      return 3 + Math.min(7, Math.sqrt(n.degree) * 1.7);
    }

    /**
     * 이 개념이 지금 보이나 (D191).
     *
     * ⚠️ **거르는 곳이 다섯이고 하나라도 빠지면 조용히 틀린다** — 선·점·
     * 제목·무리 이름·히트 판정. 제목을 안 거르면 없는 점 위에 이름만 뜨고,
     * 히트 판정을 안 거르면 **안 보이는 점이 눌려** 엉뚱한 대화로 간다.
     */
    function isVisible(n: SimNode): boolean {
      return !hiddenRef.current.has(n.session_id ?? "");
    }

    /**
     * **점 하나를 미리 구워 둔다** (2026-08-10 최적화).
     *
     * 색은 파스텔 일곱, 반지름은 3~10px 정수 — 조합이 수십 개뿐이다. 한 번
     * 그려 두면 프레임마다 하는 일이 `drawImage` 복사뿐이라, 점 1,200개의
     * 채우기·그라데이션이 통째로 사라진다.
     *
     * 화면 px로 굽는다. 점 크기는 배율과 무관하므로(`nodeScreenRadius`를 k로
     * 나눠 그리던 것이 곧 화면 고정 크기라는 뜻이다) 확대해도 다시 구울 일이
     * 없고, 변환을 되돌린 화면 좌표에 얹으므로 흐려지지도 않는다.
     */
    const sprites = new Map<string, HTMLCanvasElement>();
    const dpr = window.devicePixelRatio || 1;
    function sprite(color: string, r: number): HTMLCanvasElement {
      const key = `${color}|${r}`;
      const hit = sprites.get(key);
      if (hit) return hit;
      const half = Math.ceil(r * GLOW_SCALE);
      const c = document.createElement("canvas");
      c.width = c.height = Math.ceil(half * 2 * dpr);
      const g = c.getContext("2d")!;
      g.scale(dpr, dpr);
      // 빛 — 가운데는 옅게, 바깥으로 가며 사라진다. 한 번만 그리므로 비싸도 된다.
      const grad = g.createRadialGradient(half, half, r * 0.7, half, half, r * GLOW_SCALE);
      grad.addColorStop(0, withAlpha(color, GLOW_ALPHA));
      grad.addColorStop(1, withAlpha(color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(half, half, r * GLOW_SCALE, 0, TAU);
      g.fill();
      // 점
      g.fillStyle = color;
      g.beginPath();
      g.arc(half, half, r, 0, TAU);
      g.fill();
      sprites.set(key, c);
      return c;
    }

    /**
     * 그리기용 재사용 버퍼 — **프레임마다 새로 만들지 않는다.**
     *
     * 1,200개짜리 배열을 초당 60번 새로 만들면 그것만으로 GC가 돈다
     * (프로파일에서 1.2%였다). 비우고 다시 채운다.
     */
    const edgeTiers: SimNode[][] = Array.from({ length: EDGE_TIERS }, () => []);

    function draw() {
      const { k, x: tx, y: ty } = viewRef.current;
      const tier = tierFor(k);
      ctx!.save();
      ctx!.setTransform(
        window.devicePixelRatio || 1,
        0,
        0,
        window.devicePixelRatio || 1,
        0,
        0,
      );
      ctx!.clearRect(0, 0, width, height);
      ctx!.translate(tx, ty);
      ctx!.scale(k, k);

      // --- 선 -----------------------------------------------------------
      /**
       * **농도를 몇 단으로 끊어 단마다 한 번씩 긋는다** (2026-08-10 최적화).
       *
       * 예전에는 간선마다 `strokeStyle`을 새로 만들고 `stroke()`를 따로 불렀다 —
       * 색 문자열이 프레임마다 간선 수만큼 생기고 그리기 호출도 그만큼이다.
       * 사람 눈에 연속 농도와 5단은 구분되지 않는다.
       */
      if (k >= EDGE_MIN_ZOOM) {
        ctx!.lineWidth = 1 / k;
        for (const arr of edgeTiers) arr.length = 0;
        for (const e of edgesRef.current) {
          const s = e.source as SimNode;
          const t = e.target as SimNode;
          // 양 끝이 다 보일 때만 — 한쪽만 보이면 허공으로 뻗는 선이 된다.
          if (!s || !t || !isVisible(s) || !isVisible(t)) continue;
          // 가까운 쌍일수록 진하게. 먼 쌍까지 같은 농도로 그으면 구조가 묻힌다.
          const strength = Math.max(0, 1 - e.distance / 0.7);
          const tier = Math.min(
            EDGE_TIERS - 1,
            Math.floor(strength * EDGE_TIERS),
          );
          edgeTiers[tier].push(s, t);
        }
        for (let i = 0; i < EDGE_TIERS; i++) {
          const pts = edgeTiers[i];
          if (!pts.length) continue;
          ctx!.strokeStyle = withAlpha(
            linkColor,
            0.06 + ((i + 0.5) / EDGE_TIERS) * 0.22,
          );
          ctx!.beginPath();
          for (let j = 0; j < pts.length; j += 2) {
            ctx!.moveTo(pts[j].x, pts[j].y);
            ctx!.lineTo(pts[j + 1].x, pts[j + 1].y);
          }
          ctx!.stroke();
        }
      }

      // --- 노드 ---------------------------------------------------------
      /**
       * **미리 구운 점을 복사한다** (2026-08-10 최적화).
       *
       * 예전에는 점마다 `beginPath`·`arc`·`fill`을 돌리고 그 위에 그림자
       * 블러까지 켰다 — 점 1,200개짜리 지도에서 프레임이 66ms(15fps)였고
       * 프로파일의 70.8%가 네이티브 페인트였다.
       *
       * **화면 밖은 아예 안 그린다.** 확대해 놓으면 무리의 상당수가 상자
       * 밖인데, 그것까지 그리는 것은 통째로 버리는 일이다.
       */
      const hovered = hoverRef.current;
      ctx!.restore();
      ctx!.save();
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalAlpha = tier === "clusters" ? 0.75 : 1;
      for (const n of nodesRef.current) {
        if (!isVisible(n)) continue;
        const sx = n.x * k + tx;
        const sy = n.y * k + ty;
        const r = (n._r ??= nodeScreenRadius(n));
        const half = Math.ceil(r * GLOW_SCALE);
        if (sx + half < 0 || sx - half > width || sy + half < 0 || sy - half > height) {
          continue;
        }
        ctx!.drawImage(
          sprite((n._color ??= pastelForTag(n.tag)), r),
          sx - half,
          sy - half,
          half * 2,
          half * 2,
        );
      }
      ctx!.globalAlpha = 1;
      // 짚은 점 하나만 테두리 — 하나뿐이라 미리 구울 것이 없다.
      if (hovered && isVisible(hovered)) {
        const r = (hovered._r ??= nodeScreenRadius(hovered));
        ctx!.beginPath();
        ctx!.arc(hovered.x * k + tx, hovered.y * k + ty, r, 0, TAU);
        ctx!.lineWidth = 2;
        ctx!.strokeStyle = inkColor;
        ctx!.stroke();
      }
      // 글자는 다시 월드 좌표에서 그린다.
      ctx!.restore();
      ctx!.save();
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.translate(tx, ty);
      ctx!.scale(k, k);

      // --- 글자 ---------------------------------------------------------
      if (tier === "titles") {
        ctx!.font = `${12 / k}px ${CANVAS_FONT}`;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "top";
        ctx!.lineWidth = 3 / k;
        ctx!.strokeStyle = paperColor;
        ctx!.fillStyle = inkColor;
        /**
         * **겹치는 제목은 그리지 않는다.**
         *
         * 전부 그리면 글자가 서로를 덮어 한 글자도 못 읽는다(실측: 확대 화면이
         * 검은 글자 벽이 됐다). 화면을 격자로 나눠 칸마다 하나만 쓴다 — 어느
         * 것을 살릴지는 선이 많은 순서다(이정표가 되는 개념이 이름을 갖는다).
         */
        const named = nodesRef.current.filter(
          (n) => isVisible(n) && (n.title || n.preview),
        );
        // 선이 많은 개념이 먼저 자리를 잡는다 — 이정표가 이름을 갖는다.
        named.sort((a, b) => b.degree - a.degree);
        for (const n of pickSpacedLabels(named, (v) => {
          // 폭은 **재서** 쓴다. 어림치로 두면 긴 이름이 옆 것을 덮는다.
          const t = (v.title || v.preview).slice(0, LABEL_MAX_CHARS);
          return {
            x: v.x * k + tx,
            y: v.y * k + ty,
            w: ctx!.measureText(t).width * k,
            h: LABEL_LINE,
          };
        })) {
          const label = (n.title || n.preview).slice(0, LABEL_MAX_CHARS);
          const y = n.y + nodeScreenRadius(n) / k + 3 / k;
          ctx!.strokeText(label, n.x, y);
          ctx!.fillText(label, n.x, y);
        }
      } else {
        // 무리 이름 — 축소했을 때 지도가 무엇에 대한 것인지 말해 준다.
        // 무리 이름도 겹치면 못 읽는다 — 실측: 중심에 넷이 쌓여 뭉개졌다.
        // `clusterLabels`가 큰 무리부터 주므로 큰 것이 자리를 잡는다.
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        const clusterSize = (count: number) =>
          Math.min(30, 12 + Math.sqrt(count) * 2.4);
        const labels = pickSpacedLabels(
          clusterLabels(nodesRef.current.filter(isVisible)),
          (c) => {
            ctx!.font = `600 ${clusterSize(c.count)}px ${CANVAS_FONT}`;
            return {
              x: c.x * k + tx,
              y: c.y * k + ty,
              w: ctx!.measureText(c.tag).width,
              h: clusterSize(c.count),
            };
          },
        );
        for (const c of labels) {
          const size = clusterSize(c.count) / k;
          ctx!.font = `600 ${size}px ${CANVAS_FONT}`;
          // 글자 뒤를 종이색으로 한 번 그어 점 위에서도 읽히게 한다.
          ctx!.lineWidth = 4 / k;
          ctx!.strokeStyle = paperColor;
          ctx!.strokeText(c.tag, c.x, c.y);
          ctx!.fillStyle = tier === "clusters" ? inkColor : mutedColor;
          ctx!.fillText(c.tag, c.x, c.y);
        }
      }
      ctx!.restore();
    }
    drawRef.current = draw;

    // --- 힘 배치 ---------------------------------------------------------
    //
    // 선이 짧을수록(거리가 가까울수록) 더 세게 당긴다 — 그래야 "비슷한 것끼리
    // 뭉친다"가 화면에 나온다. 밀어내기가 없으면 한 점으로 모이고, 충돌이
    // 없으면 점이 겹쳐 개수를 못 읽는다.
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance((e) => 24 + e.distance * 190)
          .strength((e) => Math.max(0.05, 1 - e.distance)),
      )
      .force("charge", forceManyBody<SimNode>().strength(-26).distanceMax(600))
      // 충돌 반경은 **월드 단위**다 — 배율과 무관해야 한다. 배율을 섞으면
      // 확대할 때마다 배치가 다시 흔들린다(자리는 확대와 상관없는 값이다).
      .force("collide", forceCollide<SimNode>().radius((n) => nodeScreenRadius(n) + 2))
      // 아주 약하게 가운데로 — 없으면 연결 없는 카드가 무한히 흘러간다.
      .force("x", forceX(0).strength(0.012))
      .force("y", forceY(0).strength(0.012))
      .alphaDecay(0.035);
    simRef.current = sim;

    /**
     * **자리를 먼저 잡고 나서 보여 준다** (2026-08-10 전면 점검).
     *
     * 지금까지는 시뮬레이션이 스스로 돌면서 매 틱 다시 그렸고, 그동안 화면은
     * "지도를 그리는 중…"이었다 — 실측: 캔버스가 뜨고 **2.6초 더**(개념
     * 1,200개). 창구 응답은 다 합쳐 200ms였으니 그 시간은 전부 배치 계산이다.
     *
     * 그런데 그 계산 결과는 **끝나야만 쓸모가 있다.** 중간 상태를 그리는 것은
     * 학생에게 보여 줄 것이 아니라 덮개로 가리는 것이었다 — 그릴 이유가 없다.
     * `sim.tick(n)`은 tick 이벤트를 안 쏘므로 **계산만** 한다.
     *
     * 한 프레임에 다 돌리지 않고 조각으로 나눈다: 1,200개 × 260틱을 한 번에
     * 돌면 그동안 브라우저가 멈춰 스크롤도 안 된다. 조각마다 프레임을 내주면
     * 화면은 살아 있고, 총 시간은 어차피 계산량이 정한다.
     */
    sim.stop();
    /** 미리 돌릴 틱 수. d3의 기본 수명(alphaDecay 0.035)이 대략 이만큼이다. */
    const WARM_TICKS = 260;
    /** 한 프레임에 돌릴 틱 수 — 프레임이 너무 길어지지 않을 만큼만. */
    const WARM_CHUNK = 20;
    let warmed = 0;
    let warmRaf = 0;
    const warmUp = () => {
      const n = Math.min(WARM_CHUNK, WARM_TICKS - warmed);
      sim.tick(n);
      warmed += n;
      if (warmed < WARM_TICKS && sim.alpha() > sim.alphaMin()) {
        warmRaf = requestAnimationFrame(warmUp);
        return;
      }
      /**
       * **자리를 못 박고, 구조를 만들던 힘은 내려놓는다** (2026-08-10 최적화).
       *
       * 배치를 만드는 일은 예열에서 끝났다. 그 뒤로 `forceManyBody`·`forceLink`가
       * 하는 일은 "이미 잡힌 자리를 유지하는 것"인데, 그 값을 매 틱 사분트리를
       * 새로 쌓아 가며 치르고 있었다 — 프로파일에서 전하력 하나가 프레임의
       * 30%였다(개념 1,200개).
       *
       * 유지가 목적이라면 **제자리를 기억해 두고 거기로 당기는 것**이 훨씬 싸고
       * (노드당 뺄셈 두 번) 훨씬 정확하다. 힘의 균형으로 자리를 되찾으려 하면
       * 반드시 흘러간다 — 실측 2026-08-10: 전하력만 싸게 바꿨더니 무리가
       * 30초에 430 → 312로 오그라들었다. 균형이 아니라 **기억**이어야 한다.
       *
       * `collide`는 남긴다. 떠다니다 이웃에 닿으면 서로 비키는 것이 사용자가
       * 말한 "밀어내는 느낌"이고, 그건 제자리 스프링으로는 안 나온다.
       */
      for (const n of nodes) {
        n.ax = n.x;
        n.ay = n.y;
      }
      sim
        .force("charge", null)
        .force("link", null)
        .force("x", forceX<SimNode>().x((n) => n.ax ?? 0).strength(tuneRef.current.anchor))
        .force("y", forceY<SimNode>().y((n) => n.ay ?? 0).strength(tuneRef.current.anchor));

      // 자리가 잡혔다 — 이제부터가 학생이 볼 화면이다.
      sim.on("tick", () => {
        drift();
        draw();
      });
      fitToContent();
      draw();
      // 다 식은 시뮬레이션은 스스로 안 깨어난다 — 표류를 시작한다.
      if (driftTargetRef.current > 0) sim.alphaTarget(DRIFT_ALPHA).restart();
    };
    warmRaf = requestAnimationFrame(warmUp);

    /**
     * 떠다니기 (사용자 지시 2026-08-10).
     *
     * 노드마다 **각도**를 하나 갖고 그것이 천천히 돈다. 매 틱 난수를 새로
     * 뽑으면 방향이 프레임마다 뒤집혀 **떨림**으로 보인다 — 각도가 도는
     * 방식이라야 흐름이 된다. 각도의 시작값과 도는 방향은 노드마다 다르게
     * (id 해시로) 뿌려 무리 전체가 한쪽으로 몰려가지 않게 한다.
     *
     * 밀어내는 느낌은 따로 만들지 않는다 — 이미 `collide`가 있고, 온도를
     * 조금 남겨 두면 떠다니다 이웃에 닿을 때 서로 비킨다.
     */
    const phase = new Float64Array(nodes.length);
    const spin = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      // id에서 뽑는다 — 새로고침해도 같은 노드가 같은 결로 움직인다.
      let h = 2166136261;
      const id = nodes[i].id;
      for (let c = 0; c < id.length; c++) {
        h ^= id.charCodeAt(c);
        h = Math.imul(h, 16777619);
      }
      const u = ((h >>> 0) % 10000) / 10000;
      phase[i] = u * Math.PI * 2;
      spin[i] = (u < 0.5 ? 1 : -1) * (0.6 + u);
    }

    /**
     * 이웃 목록 — **장력의 방향**이 여기서 나온다.
     *
     * 한 번만 만든다. 노드는 움직여도 누가 누구와 이어졌는지는 안 바뀐다.
     * `forceLink`가 초기화하면서 `source`/`target`을 노드 객체로 바꿔 놓으므로
     * 그 뒤에 읽어야 한다.
     */
    const nbr: number[][] = nodes.map(() => []);
    for (const e of edges) {
      const a = (e.source as unknown as SimNode).index;
      const b = (e.target as unknown as SimNode).index;
      if (a === undefined || b === undefined) continue;
      nbr[a].push(b);
      nbr[b].push(a);
    }

    function drift() {
      // 목표로 다가간다 — 켜고 끌 때 둘 다 결이 있어야 한다. 진행도는
      // **시간**으로 잰다(틱 수로 재면 지도 크기마다 리듬이 달라진다).
      const target = driftTargetRef.current;
      const { at, value } = driftFromRef.current;
      const span = target === 0 ? DRIFT_STOP_MS : DRIFT_START_MS;
      const t = at ? Math.min(1, (Date.now() - at) / span) : 1;
      // ease-in-out — 뚝 끊기지도, 끝에서 질질 끌지도 않는다.
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      driftRef.current = value + (target - value) * e;
      const amp = driftRef.current * tuneRef.current.force;
      if (amp < 0.002) {
        if (target !== 0) return;
        /**
         * 다 식었다 — **여기서 확실히 세운다.**
         *
         * 온도만 놓아 주면(`alphaTarget(0)`) d3가 스스로 식긴 하는데, 그
         * 식는 속도가 **틱 수**에 걸려 있어 노드가 많은 지도에서는 몇 초를
         * 더 꿈틀댄다(실측 2026-08-10: 같은 코드가 어떤 실행에서는 서고
         * 어떤 실행에서는 안 섰다). 남은 속도까지 0으로 두고 타이머를
         * 멈춘다 — 멈춤은 눈에 보이는 약속이라 경합에 맡길 수 없다.
         */
        for (const n of nodesRef.current) {
          n.vx = 0;
          n.vy = 0;
        }
        sim.alphaTarget(0);
        sim.alpha(0);
        sim.stop();
        draw();
        return;
      }
      const ns = nodesRef.current;
      for (let i = 0; i < ns.length; i++) {
        phase[i] += tuneRef.current.breath * spin[i];
        const n = ns[i];
        /**
         * **당기는 쪽은 이웃이다.**
         *
         * 이웃들의 한가운데를 향한 방향에 사인파를 실어, 그쪽으로 당겼다
         * 반대로 밀었다 한다 — 그 방향이 곧 이 노드를 붙들고 있는 선들의
         * 방향이라, 화면에는 선이 팽팽해졌다 느슨해지는 것으로 보인다.
         * 이웃이 없으면 가운데(0,0)가 당긴다: 그쪽은 중력이다.
         *
         * 이웃마다 위상이 조금씩 어긋나 있어(`spin`) 무리 전체가 한 번에
         * 부풀었다 꺼지지 않는다 — 그러면 호흡이 아니라 확대·축소로 읽힌다.
         */
        const ks = nbr[i];
        let tx = 0;
        let ty = 0;
        if (ks.length) {
          for (const j of ks) {
            tx += ns[j].x ?? 0;
            ty += ns[j].y ?? 0;
          }
          tx /= ks.length;
          ty /= ks.length;
        }
        const dx = tx - (n.x ?? 0);
        const dy = ty - (n.y ?? 0);
        const d = Math.hypot(dx, dy) || 1;
        const push = Math.sin(phase[i]) * amp;
        n.vx = (n.vx ?? 0) + (dx / d) * push;
        n.vy = (n.vy ?? 0) + (dy / d) * push;
      }
    }

    /**
     * 다시 떠다니게 — 식은 시뮬레이션은 스스로 깨지 않는다.
     *
     * ⚠️ **`restart()`만으로는 못 깨운다.** 멈출 때 `alpha(0)`으로 완전히
     * 식혀 두는데, d3의 틱은 `alpha += (target - alpha) * alphaDecay` 뒤
     * `alpha < alphaMin`이면 스스로 선다 — 0에서 목표 0.02로 올라가는 첫
     * 걸음이 0.0007이라 **그 자리에서 다시 죽는다**(실측 2026-08-10: 지도만
     * 보기에서 돌아와도 노드가 안 움직였다). 목표보다 높은 온도를 손으로
     * 넣어 준다.
     */
    wakeRef.current = () => {
      sim.alpha(Math.max(sim.alpha(), DRIFT_ALPHA * 4)).alphaTarget(DRIFT_ALPHA).restart();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    // --- 팬/줌 -----------------------------------------------------------
    //
    // ## 지도 위에서는 결과가 하나다 (D191)
    //
    // 예전에는 **같은 손동작이 커서 위치에 따라 두 결과**를 냈다 — 캔버스 안이면
    // 지도가, 헤더나 여백이면 브라우저가 확대됐다. 학생이 실제로 겪은 것은
    // "확대했더니 웹 화면이 커졌고, 되돌리려니 지도가 줄어든" 것이다
    // (사용자 보고 2026-08-06).
    //
    // 캔버스 위의 휠은 **ctrl 여부와 무관하게** 지도가 먹고 브라우저로 안
    // 넘긴다. d3가 대개 막아 주지만 핀치(ctrl+wheel)는 브라우저·OS 조합에
    // 따라 새고, 그 한 경우가 위 증상이다. d3보다 **먼저** 걸어 두어야
    // d3의 필터가 거절하는 경우까지 덮는다(우리는 preventDefault만 하고
    // 전파를 안 끊으므로 d3의 확대는 그대로 돈다).
    const blockPageZoom = (e: WheelEvent) => e.preventDefault();
    canvas.addEventListener("wheel", blockPageZoom, { passive: false });

    const sel = select<HTMLCanvasElement, unknown>(canvas);
    const zoomer = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.12, 6])
      // 기본값과 같지만 **명시한다** — 이 화면이 "ctrl+휠도 지도"라는 필터에
      // 기대고 있다는 사실이 코드에 남아야 다음 사람이 안 뒤집는다.
      .filter((e: Event) => !(e as MouseEvent).button)
      .on("zoom", (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        viewRef.current = { k: ev.transform.k, x: ev.transform.x, y: ev.transform.y };
        draw();
      });
    sel.call(zoomer);

    /**
     * 배치가 끝나면 **전체가 들어오게** 맞춘다.
     *
     * 처음 배율을 상수로 두면 카드 수에 따라 지도가 화면 가운데 얼룩이거나
     * 화면 밖으로 넘친다(실측 2026-08-06: 개념 76개에서 1,200개용 배율을 쓰니
     * 한가운데 작은 점 무리였다). 지도는 펼쳐진 채로 시작해야 지도다.
     *
     * 저절로는 **한 번만** 맞춘다 — 학생이 옮겨 놓은 화면을 배치가 식을 때마다
     * 되돌리면 지도를 볼 수가 없다. 버튼(`force`)은 그 빗장을 넘는다.
     *
     * **보이는 개념만** 담는다 (D191). 대화를 끄면 그 자리에 구멍이 남는데,
     * 재배치 없이 그 구멍을 푸는 방법이 이것이다 — 남은 것에 맞춰 당기면
     * 구멍은 화면 밖으로 밀린다.
     */
    let fitted = false;
    /**
     * @param force  이미 맞췄어도 다시 맞춘다(버튼·모드 전환).
     * @param ignoreUi  덮개를 없는 것으로 치고 **상자 전체**에 맞춘다.
     *   온전한 지도 보기(사용자 지시 2026-08-10)에서 쓴다 — 글자가 사라졌는데
     *   지도가 그 자리를 계속 비워 두면 위쪽 절반이 통째로 빈 종이가 된다.
     */
    const fitToContent = (force = false, ignoreUi = quietRef.current) => {
      if ((fitted && !force) || !width || !height) return;
      // 덮개는 지도 위에 절대 배치로 얹혀 있다 — 그 아래 변이 곧 우리 천장이다.
      const wrapBox = wrapRef.current?.getBoundingClientRect();
      const uiBox = document
        .querySelector("[data-map-overlay]")
        ?.getBoundingClientRect();
      uiTopRef.current = wrapBox && uiBox ? Math.max(0, uiBox.bottom - wrapBox.top) : 0;
      const shown = nodesRef.current.filter(isVisible);
      // 전부 껐으면 안내 문구가 덮으므로 배율은 아무래도 좋다 — 그래도
      // 전체로 맞춰 두어야 다시 켰을 때 엉뚱한 자리에 있지 않다.
      const b = boundsOf(shown.length ? shown : nodesRef.current);
      if (!b) return;
      fitted = true;
      // 자리가 잡힌 그 순간이 곧 보여 줄 때다 — 따로 재지 않는다.
      setSettling(false);
      const pad = 48;
      /**
       * **덮인 자리는 빼고 잰다** (사용자 지시 2026-08-09).
       *
       * 홈에서는 이 지도 위에 인사말·입력창·버튼이 얹힌다. 화면 전체로 맞추면
       * 노드 무리의 한가운데가 정확히 그 글자들 뒤에 깔린다 — 지도가 보이라고
       * 배경으로 둔 것인데 가장 붐비는 곳이 가려지는 셈이다.
       *
       * 그래서 **덮인 아래쪽만**을 화면으로 치고 거기에 맞춘다. 남는 높이가
       * 너무 얇으면(작은 화면) 맞추기가 무의미해지므로 하한을 둔다.
       */
      const top = ignoreUi ? 0 : Math.min(uiTopRef.current, height * 0.6);
      /**
       * 아래 띠는 **여백을 아낀다**(pad의 절반).
       *
       * 위쪽을 UI에 내주고 나면 남는 높이가 화면의 절반도 안 된다. 거기에
       * 좌우와 같은 여백까지 물리면 무리가 손톱만 해져서, "한눈에 보이게"
       * 하려던 것이 도리어 안 보이게 된다(실측 2026-08-09: 810 화면에서
       * 쓸 수 있는 높이가 290px).
       */
      const usableH = Math.max(120, height - top - (ignoreUi ? pad * 2 : pad));
      /**
       * 온전한 지도 보기에서는 **넘치지 않게** 맞춘다(boost 없음).
       *
       * 평소의 1.28배는 "글자 아래 좁은 띠에서도 읽히게"라는 사정에서 나온
       * 값이다. 상자를 다 쓰는 자리에서 같은 배율을 또 물리면 이번엔 진짜로
       * 가장자리가 잘린다 — 온전히 보자고 켠 모드에서 그건 앞뒤가 안 맞는다.
       */
      const k = Math.min(
        6,
        Math.max(0.12, Math.min((width - pad * 2) / b.w, usableH / b.h)) *
          (ignoreUi ? 1 : tuneRef.current.boost),
      );
      /**
       * **넘치는 쪽은 위로 보낸다** (사용자 지시 2026-08-10: "더 확대").
       *
       * 띠 한가운데에 두면 확대분이 위아래로 **똑같이** 넘친다. 그런데 두
       * 방향의 값이 다르다 — 위로 넘친 것은 인사말 뒤에 숨지만(애초에 그
       * 자리를 UI에 내준 것이다), 아래로 넘친 것은 **상자에 잘린다.**
       * 실측 2026-08-10: 무리 아래쪽이 상자 바닥에서 잘려 나갔다.
       *
       * 무리가 띠보다 크면 아래 변을 상자 바닥에 붙이고, 작으면 예전대로 띠
       * 한가운데에 둔다(작은 무리를 바닥에 붙이면 글자와 붙어 답답하다).
       */
      const 무리높이 = b.h * k;
      const 띠가운데 = top + (height - top) / 2;
      const 바닥맞춤 = height - pad * 0.5 - 무리높이 / 2;
      const cy = ignoreUi ? height / 2 : Math.min(띠가운데, 바닥맞춤);
      const t = zoomIdentity
        .translate(width / 2, cy)
        .scale(k)
        .translate(-(b.x + b.w / 2), -(b.y + b.h / 2));
      /**
       * 모드를 오갈 때는 **미끄러지듯** 옮긴다(사용자 지시의 "서서히"에는
       * 카메라도 든다). 첫 맞춤은 튀지 않게 그냥 놓는다 — 학생이 보기 전의
       * 움직임에 시간을 들일 이유가 없다.
       */
      if (force) sel.transition().duration(620).call(zoomer.transform, t);
      else sel.call(zoomer.transform, t);
    };
    /**
     * 예열이 어떤 이유로든 안 끝났을 때의 뒷문 — 학생을 덮개 아래 가둬 두지
     * 않는다. 예열이 정상적으로 끝났으면 `fitted`가 이미 참이라 아무 일도
     * 안 한다.
     */
    const fitTimer = window.setTimeout(() => fitToContent(), 3000);

    // 확대 버튼이 쓸 손잡이. `zoomer`·`sel`은 이 이펙트 밖에서 못 만든다.
    zoomApiRef.current = {
      zoomBy: (f) => sel.call(zoomer.scaleBy, f),
      fit: () => fitToContent(true),
      refit: (ignoreUi: boolean) => fitToContent(true, ignoreUi),
    };

    resize();

    return () => {
      window.clearTimeout(fitTimer);
      cancelAnimationFrame(warmRaf);
      sim.stop();
      ro.disconnect();
      sel.on(".zoom", null);
      canvas.removeEventListener("wheel", blockPageZoom);
      zoomApiRef.current = null;
      simRef.current = null;
    };
  }, [data]);

  /** 화면 좌표 → 가장 가까운 노드. 1,200개 선형 훑기는 마우스 이동당 마이크로초다. */
  const nodeAt = useCallback((sx: number, sy: number): SimNode | null => {
    const { k, x, y } = viewRef.current;
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    // 잡히는 반경은 화면 기준으로 일정해야 한다 — 축소했을 때도 누를 수 있게.
    const reach = 10 / k;
    let best: SimNode | null = null;
    let bestD = reach * reach;
    for (const n of nodesRef.current) {
      // 숨긴 대화의 개념은 안 잡힌다 (D191) — 안 거르면 **안 보이는 점이
      // 눌려** 학생이 끄기로 한 대화로 끌려간다.
      if (hiddenRef.current.has(n.session_id ?? "")) continue;
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }, []);

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const hit = nodeAt(sx, sy);
      if (hit === hoverRef.current) return; // 같은 노드면 아무것도 안 한다
      hoverRef.current = hit;
      drawRef.current();
      // 툴팁 자리는 **여기서** 정한다. 렌더 중에 ref를 읽으면 React Compiler가
      // 막고(맞는 지적이다 — 그 값은 렌더의 입력이 아니다), 무엇보다 이 시점에
      // 이미 사각형을 갖고 있어서 다시 잴 이유가 없다.
      setHover(
        hit
          ? {
              node: hit,
              sx: Math.min(sx + 14, r.width - TIP_W),
              sy: Math.min(sy + 14, r.height - TIP_H),
            }
          : null,
      );
    },
    [nodeAt],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      const hit = nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (hit) onOpen(hit);
    },
    [nodeAt, onOpen],
  );

  const handleLeave = useCallback(() => {
    hoverRef.current = null;
    drawRef.current();
    setHover(null);
  }, []);

  const zoomIn = useCallback(() => zoomApiRef.current?.zoomBy(1.6), []);
  const zoomOut = useCallback(() => zoomApiRef.current?.zoomBy(1 / 1.6), []);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full overflow-hidden"
      /* 캔버스는 픽셀로 못 센다 — e2e가 필터를 확인하는 신호다(D176 `data-strokes`). */
      data-visible-nodes={visibleCount}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        /* `touch-none`: 트랙패드·터치 핀치가 페이지 확대로 새지 않게 한다. */
        className="h-full w-full touch-none cursor-grab active:cursor-grabbing"
      />

      <MapZoomControls onZoomIn={zoomIn} onZoomOut={zoomOut} />

      {/**
       * 식는 동안 덮는다 (D211 1).
       *
       * 노드가 흔들리는 것을 보여 주는 것보다 잠깐 가리는 편이 낫다 — 흔들림은
       * 학생 눈에 고장으로 읽힌다. 배율 맞추기가 끝나는 순간에 걷힌다.
       */}
      {settling && (
        <div
          data-map-settling
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-bg-elevated/85"
        >
          <span className="text-sm font-medium text-fg">지도를 그리는 중…</span>
          <span className="text-xs text-fg-muted">개념들이 자리를 잡고 있어요</span>
        </div>
      )}

      {/*
        전부 껐을 때 빈 캔버스로 두지 않는다 — 빈 화면은 고장과 구분되지
        않는다(`EmptyMap`과 같은 태도). 무엇을 하면 돌아오는지 말해 준다.
      */}
      {visibleCount === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg-elevated/80 px-4 text-center">
          <p className="text-sm font-medium text-fg">지도에 띄운 대화가 없습니다</p>
          <p className="text-xs text-fg-muted">왼쪽 목록에서 볼 대화를 켜세요.</p>
        </div>
      )}

      {/*
        hover한 개념이 방금 숨겨졌을 수 있다 — 마우스가 멈춰 있으면 다음
        mousemove가 안 와서 툴팁만 남는다. 렌더 중에 걸러 낸다(이펙트로 지우면
        한 프레임 어긋나고 React Compiler 규칙에도 걸린다).
      */}
      {hover && !hiddenSessions.has(hover.node.session_id ?? "") && (
        <div
          className="pointer-events-none absolute z-10 rounded-lg border border-accent-border/50 bg-bg-elevated px-3 py-2 shadow-lg"
          // 자리는 핸들러가 이미 화면 안으로 접어서 넣어 준다.
          style={{ left: hover.sx, top: hover.sy, width: TIP_W }}
        >
          {hover.node.tag && (
            <span className="text-[11px] font-medium text-accent-deep">
              {hover.node.tag}
            </span>
          )}
          <p className="text-sm font-medium text-fg">
            {hover.node.title || "제목 없는 개념"}
          </p>
          {hover.node.preview && (
            <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">
              {hover.node.preview}
            </p>
          )}
          <p className="mt-1 text-[11px] text-fg-muted/80">
            {sessionById.get(hover.node.session_id ?? "")?.title?.trim() ||
              "제목 없는 대화"}
            {" · 눌러서 이동"}
          </p>
        </div>
      )}
    </div>
  );
}
