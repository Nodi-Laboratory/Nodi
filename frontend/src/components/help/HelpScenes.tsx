"use client";

/**
 * 도움말의 **그림들** (사용자 지시 2026-08-10).
 *
 * ## 왜 진짜 화면을 안 쓰나
 *
 * "실제 캔버스를 미니로 띄우자"를 먼저 재 봤다. 그러려면 Excalidraw 브리지와
 * 세션·데이터가 딸려 오고, 도움말을 여는 데 대화방을 하나 만들어야 한다.
 * 게다가 **학생 계정마다 화면이 다르다** — 카드가 없는 학생에게는 빈 캔버스가
 * 뜨고, 그건 설명이 아니라 혼란이다.
 *
 * 그래서 **제품과 같은 모양의 작은 무대**를 따로 짓는다. 색·괘선·모서리·글꼴
 * 규칙은 실제 화면 그대로다(오커=AI · 틸=학생 · 파스텔 점 · 종이색 카드).
 * 누구에게나 같은 것이 보이고, 즉시 뜨고, 데이터가 없어도 된다.
 *
 * ## 움직임이 설명의 절반이다
 *
 * "카드를 끌어 이으세요"를 글로 읽는 것과 선이 이어지는 것을 보는 것은 다르다.
 * 장면마다 **한 동작만** 반복한다 — 여러 개를 한꺼번에 보여 주면 어느 것을
 * 봐야 하는지 알 수 없다.
 *
 * 애니메이션은 카드가 **보일 때만** 돈다(부모가 활성 카드만 마운트한다) —
 * 여섯 장면이 동시에 도는 것은 낭비이고, 넘길 때마다 처음부터 보여야 한다.
 */

import type { ReactNode } from "react";

/** 장면 하나의 무대 크기. 뷰박스라 실제 픽셀과 무관하다. */
const W = 420;
const H = 200;

/** 제품의 색 — 여기서만 쓰는 사본이다(캔버스 토큰 `--c-*`는 `.canvas2` 밖에서 안 산다). */
const C = {
  paper: "#ffffff",
  ink: "#26301f",
  soft: "#6b7363",
  faint: "#9aa291",
  rule: "#e3e6dc",
  ai: "#c88a2e", // 오커 — AI가 쓴 것
  hand: "#2f8f83", // 틸 — 학생이 쓴 것
  accent: "#c3dd6a",
  accentDeep: "#5f7a1e",
  wash: "#f7f9f0",
} as const;

/** 파스텔 — `lib/ui/pastel.ts`와 같은 벌이다. */
const DOTS = ["#a8c8e8", "#b8b0e0", "#d0a8d8", "#e8b8b0", "#e0cba0", "#a8d0c0"];

function Stage({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-full w-full"
      role="img"
      aria-hidden
      focusable="false"
    >
      <rect x="0" y="0" width={W} height={H} rx="12" fill={C.wash} />
      {children}
    </svg>
  );
}

/** 개념 카드 한 장 — 왼쪽 괘선의 색이 곧 출처다(D120). */
function Card({
  x,
  y,
  w = 150,
  title,
  lines = 3,
  by = "ai",
  className,
}: {
  x: number;
  y: number;
  w?: number;
  title: string;
  lines?: number;
  by?: "ai" | "hand";
  className?: string;
}) {
  const h = 26 + lines * 9;
  return (
    <g className={className}>
      <rect x={x} y={y} width={w} height={h} rx="7" fill={C.paper} stroke={C.rule} />
      <rect x={x + 4} y={y + 6} width="2.5" height={h - 12} rx="1.2" fill={by === "ai" ? C.ai : C.hand} />
      <text x={x + 13} y={y + 17} fontSize="10" fontWeight="700" fill={C.ink}>
        {title}
      </text>
      {Array.from({ length: lines }, (_, i) => (
        <rect
          key={i}
          x={x + 13}
          y={y + 24 + i * 9}
          width={(w - 26) * (i === lines - 1 ? 0.55 : 0.92)}
          height="3.5"
          rx="1.75"
          fill={C.rule}
        />
      ))}
    </g>
  );
}

/* ── 1. 물어보기 ───────────────────────────────────────────────────────── */
function AskScene() {
  return (
    <Stage>
      {/* 답 카드 — 물음 뒤에 나타난다 */}
      <g className="nh-answer">
        <Card x={135} y={22} w={160} title="빛의 굴절" lines={3} />
      </g>
      {/* 입력창 */}
      <g>
        <rect x={60} y={140} width={300} height={34} rx="17" fill={C.paper} stroke={C.rule} />
        <text x={80} y={161} fontSize="11" fill={C.soft} className="nh-typing">
          빛이 왜 휘어져?
        </text>
        <circle cx={342} cy={157} r="12" fill={C.accent} />
        <path d="M342 152 l0 10 M338 156 l4 -4 4 4" stroke={C.accentDeep} strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
      <text x={210} y={193} fontSize="9" fill={C.faint} textAnchor="middle">
        Enter를 누르면 답이 캔버스에 놓입니다
      </text>
    </Stage>
  );
}

/* ── 2. 카드 잇기 ──────────────────────────────────────────────────────── */
function LinkScene() {
  return (
    <Stage>
      <Card x={30} y={30} w={140} title="빛의 굴절" lines={2} />
      <g className="nh-drag">
        <Card x={240} y={104} w={140} title="렌즈" lines={2} by="hand" />
      </g>
      {/* 이어지는 선 */}
      <path
        className="nh-link"
        d="M100 78 C 100 110, 240 96, 300 104"
        stroke={C.ai}
        strokeWidth="2"
        fill="none"
        strokeDasharray="220"
      />
      <circle className="nh-port" cx={100} cy={78} r="4" fill={C.paper} stroke={C.ai} strokeWidth="2" />
      <text x={210} y={188} fontSize="9" fill={C.faint} textAnchor="middle">
        카드 아래 점에서 끌어다 다른 카드에 놓으면 이어집니다
      </text>
    </Stage>
  );
}

/* ── 3. 손으로 써서 묻기 ───────────────────────────────────────────────── */
function InkScene() {
  return (
    <Stage>
      <Card x={210} y={26} w={150} title="지진파" lines={3} />
      {/* 손으로 그은 화살표 + 글씨 */}
      <path
        className="nh-stroke1"
        d="M70 108 C 120 96, 150 78, 205 62"
        stroke={C.hand}
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeDasharray="170"
      />
      <path
        className="nh-stroke2"
        d="M205 62 l-14 1 M205 62 l-7 9"
        stroke={C.hand}
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        strokeDasharray="24"
      />
      <text className="nh-stroke3" x={44} y={126} fontSize="13" fill={C.hand} fontStyle="italic">
        이거 더 설명해줘
      </text>
      {/* 입력창 — 인식되면 글자가 여기로 */}
      <g>
        <rect x={60} y={148} width={300} height={30} rx="15" fill={C.paper} stroke={C.rule} />
        {/* 자판 ↔ 펜 토글 */}
        <rect x={26} y={148} width={30} height={30} rx="15" fill={C.paper} stroke={C.rule} />
        <path d="M35 160 h12 M35 165 h12" stroke={C.faint} strokeWidth="1.6" strokeLinecap="round" />
        <circle className="nh-pen-dot" cx={41} cy={163} r="13" fill="none" stroke={C.hand} strokeWidth="2" />
        <text className="nh-recognized" x={78} y={167} fontSize="11" fill={C.ink}>
          이거 더 설명해줘
        </text>
      </g>
      <text x={210} y={193} fontSize="9" fill={C.faint} textAnchor="middle">
        펜으로 표시하고 쓰면 글자로 바뀌어 입력창에 들어옵니다
      </text>
    </Stage>
  );
}

/* ── 4. 도구 고르기 ────────────────────────────────────────────────────── */
function ToolScene() {
  const tools = ["선택·이동", "카드 수정", "펜", "도형", "색", "지우개"];
  return (
    <Stage>
      {/* 도구 막대 */}
      <rect x={318} y={22} width={40} height={156} rx="12" fill={C.paper} stroke={C.rule} />
      {tools.map((t, i) => (
        <g key={t}>
          <rect
            className={i === 3 ? "nh-tool-on" : undefined}
            x={324}
            y={30 + i * 25}
            width={28}
            height={22}
            rx="6"
            fill={i === 3 ? C.accent : "transparent"}
          />
          <text x={338} y={45 + i * 25} fontSize="8" fill={C.soft} textAnchor="middle">
            {["↖", "✦", "✎", "▢", "◍", "◇"][i]}
          </text>
        </g>
      ))}
      {/* 펼친 묶음 */}
      <g className="nh-flyout">
        <rect x={216} y={92} width={94} height={30} rx="9" fill={C.paper} stroke={C.rule} />
        {["▢", "△", "☆", "◯", "↗", "—"].map((g, i) => (
          <text key={g} x={228 + i * 15} y={112} fontSize="10" fill={C.ink} textAnchor="middle">
            {g}
          </text>
        ))}
      </g>
      <text x={150} y={60} fontSize="11" fontWeight="700" fill={C.ink}>
        묶인 도구는 눌러서 펼칩니다
      </text>
      <text x={150} y={78} fontSize="9.5" fill={C.soft}>
        펜 · 도형 · 색이 한 단추 뒤에 있어요
      </text>
      <text x={150} y={146} fontSize="9.5" fill={C.soft}>
        선택·이동: 그냥 끌면 화면 이동,
      </text>
      <text x={150} y={160} fontSize="9.5" fill={C.soft}>
        0.7초 누르고 끌면 여러 개 선택
      </text>
    </Stage>
  );
}

/* ── 5. 지도 ───────────────────────────────────────────────────────────── */
function MapScene() {
  // 자리는 못 박는다 — 난수를 쓰면 도움말이 열 때마다 다른 그림이 된다.
  const pts = [
    [120, 70, 0], [140, 96, 0], [104, 100, 1], [160, 74, 2], [96, 66, 1],
    [132, 122, 3], [172, 108, 2], [86, 124, 4], [150, 52, 5], [110, 46, 0],
    [200, 88, 3], [206, 122, 4], [186, 140, 5], [70, 92, 2], [176, 60, 1],
  ] as const;
  return (
    <Stage>
      {pts.map(([x, y, c], i) => (
        <circle
          key={i}
          className="nh-float"
          style={{ animationDelay: `${(i % 5) * 0.4}s` }}
          cx={x}
          cy={y}
          r={i % 4 === 0 ? 6 : 4}
          fill={DOTS[c]}
          opacity="0.9"
        />
      ))}
      <text x={132} y={94} fontSize="12" fontWeight="700" fill={C.ink} textAnchor="middle">
        빛의 성질
      </text>
      {/* 누르면 그 대화로 */}
      <circle className="nh-ping" cx={200} cy={88} r="10" fill="none" stroke={C.accentDeep} strokeWidth="2" />
      <g className="nh-jump">
        <rect x={244} y={54} width={140} height={64} rx="8" fill={C.paper} stroke={C.rule} />
        <rect x={248} y={60} width="2.5" height="52" rx="1.2" fill={C.ai} />
        <text x={258} y={74} fontSize="10" fontWeight="700" fill={C.ink}>
          빛의 굴절
        </text>
        {[0, 1, 2].map((i) => (
          <rect key={i} x={258} y={82 + i * 9} width={i === 2 ? 60 : 110} height="3.5" rx="1.75" fill={C.rule} />
        ))}
      </g>
      <text x={210} y={186} fontSize="9" fill={C.faint} textAnchor="middle">
        개념을 누르면 그 대화의 그 카드로 갑니다
      </text>
    </Stage>
  );
}

/* ── 6. 세션과 대화방 ──────────────────────────────────────────────────── */
function SessionScene() {
  return (
    <Stage>
      {/* 공간 카드 둘 */}
      <g className="nh-tap">
        <rect x={26} y={34} width={106} height={74} rx="10" fill="#f2f7e6" stroke={C.rule} />
        <path d="M56 56 h20 l5 6 h20 v22 a4 4 0 0 1 -4 4 h-41 a4 4 0 0 1 -4 -4 v-24 a4 4 0 0 1 4 -4z" fill={C.accent} />
        <text x={79} y={98} fontSize="9.5" fontWeight="700" fill={C.ink} textAnchor="middle">
          개인 세션
        </text>
      </g>
      <g opacity="0.55">
        <rect x={26} y={116} width={106} height={56} rx="10" fill={C.paper} stroke={C.rule} />
        <text x={79} y={148} fontSize="9.5" fontWeight="700" fill={C.ink} textAnchor="middle">
          3학년 1반
        </text>
      </g>
      {/* 펼쳐지는 대화방 목록 */}
      <g className="nh-popup">
        <rect x={152} y={30} width={238} height={142} rx="10" fill={C.paper} stroke={C.rule} />
        <text x={166} y={48} fontSize="10" fontWeight="700" fill={C.ink}>
          개인 세션
        </text>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <rect x={162} y={58 + i * 27} width={218} height={22} rx="6" fill={i === 0 ? C.wash : "transparent"} />
            <text x={172} y={73 + i * 27} fontSize="9" fill={C.ink}>
              {["빛 이야기", "지진파 정리", "세포 호흡", "제목 없는 대화"][i]}
            </text>
            <rect x={262} y={64 + i * 27} width={44} height={11} rx="5.5" fill={DOTS[i]} opacity="0.45" />
            <text x={284} y={72.5 + i * 27} fontSize="7" fill={C.ink} textAnchor="middle">
              {["빛", "지구과학", "생명", "—"][i]}
            </text>
            <text x={366} y={73 + i * 27} fontSize="10" fill={C.faint}>
              ⋮
            </text>
          </g>
        ))}
      </g>
      <text x={210} y={190} fontSize="9" fill={C.faint} textAnchor="middle">
        카드를 누르면 그 안의 대화방이 펼쳐집니다
      </text>
    </Stage>
  );
}

export interface HelpScene {
  key: string;
  title: string;
  lines: string[];
  Scene: () => ReactNode;
}

/**
 * 순서가 곧 배우는 차례다 — **묻기**부터다. 학생이 처음 하는 일이 그것이고,
 * 나머지는 그 뒤에 필요해진다.
 */
export const HELP_SCENES: HelpScene[] = [
  {
    key: "ask",
    title: "물어보면 답이 카드로 놓입니다",
    lines: [
      "아래 입력창에 궁금한 것을 적고 Enter를 누르세요.",
      "답은 개념 카드가 되어 캔버스 위에 놓이고, 비슷한 주제끼리 같은 줄에 쌓입니다.",
    ],
    Scene: AskScene,
  },
  {
    key: "link",
    title: "카드는 옮기고, 잇고, 고칠 수 있습니다",
    lines: [
      "카드를 끌어 옮기면 그 자리가 저장됩니다.",
      "카드 위·아래의 점에서 끌어 다른 카드에 놓으면 두 카드가 이어집니다 — 이어진 카드에 물으면 그 흐름을 이어서 답합니다.",
    ],
    Scene: LinkScene,
  },
  {
    key: "ink",
    title: "손으로 써서 물어볼 수 있습니다",
    lines: [
      "입력창 왼쪽의 펜을 고르면 캔버스가 통째로 종이가 됩니다.",
      "카드를 동그라미 치거나 화살표로 가리키고 질문을 쓰면, 글씨는 글자로 바뀌고 표시는 “무엇을 가리켰는지”로 함께 전해집니다.",
    ],
    Scene: InkScene,
  },
  {
    key: "tools",
    title: "도구는 여섯 줄로 접혀 있습니다",
    lines: [
      "펜(연필·형광펜·글씨)·도형(네모·세모·별·원·화살표·선)·색은 한 단추 뒤에 있습니다.",
      "선택·이동은 하나입니다 — 그냥 끌면 화면이 움직이고, 0.7초 누르고 끌면 여러 개를 한 번에 고릅니다.",
    ],
    Scene: ToolScene,
  },
  {
    key: "map",
    title: "지도로 지난 개념을 찾아갑니다",
    lines: [
      "홈의 지도에는 지금까지 이야기한 개념이 전부 모여 있습니다. 가까운 것끼리 뭉쳐 있어요.",
      "개념을 누르면 그 대화의 그 카드로 곧장 갑니다. 오른쪽 위 단추를 누르면 지도만 크게 볼 수 있습니다.",
    ],
    Scene: MapScene,
  },
  {
    key: "sessions",
    title: "세션과 대화방",
    lines: [
      "왼쪽 [세션]에서 개인 세션과 학급을 고릅니다.",
      "카드를 누르면 그 안의 대화방 목록이 펼쳐지고, 이름 옆 색 칩이 그 방에서 무슨 이야기를 했는지 알려 줍니다.",
    ],
    Scene: SessionScene,
  },
];

/**
 * 장면들의 움직임.
 *
 * 한곳에 모아 둔다 — 장면마다 `<style>`을 흩어 두면 같은 이름의 keyframes가
 * 겹쳐 서로를 덮는다. 이름은 전부 `nh-`로 시작해 앱의 다른 CSS와 안 부딪친다.
 */
export function HelpSceneStyles() {
  return (
    <style>{`
/**
 * ⚠️ **끝난 모습이 오래 보여야 한다.**
 *
 * 처음에는 절반쯤에서야 물건이 나타나게 짰다. 그랬더니 넘길 때마다 **빈 무대**를
 * 먼저 보게 되어, 그림이 설명을 돕는 게 아니라 기다리게 만들었다(실측
 * 2026-08-10: 카드를 넘긴 직후 화면의 3분의 2가 비어 있었다). 시작은 짧게,
 * 완성된 상태로 대부분의 시간을 보낸다.
 */
@keyframes nh-type { 0%,4% { clip-path: inset(0 100% 0 0); } 26%,100% { clip-path: inset(0 0 0 0); } }
@keyframes nh-pop { 0%,14% { opacity: 0; transform: translateY(6px) scale(.96); } 30%,100% { opacity: 1; transform: none; } }
@keyframes nh-drag { 0%,6% { transform: translate(0,0); } 34%,100% { transform: translate(-34px,-16px); } }
@keyframes nh-draw { 0%,6% { stroke-dashoffset: 240; } 34%,100% { stroke-dashoffset: 0; } }
@keyframes nh-draw2 { 0%,32% { stroke-dashoffset: 30; } 44%,100% { stroke-dashoffset: 0; } }
@keyframes nh-fadein { 0%,40% { opacity: 0; } 52%,100% { opacity: 1; } }
@keyframes nh-fadein2 { 0%,54% { opacity: 0; } 64%,100% { opacity: 1; } }
@keyframes nh-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes nh-ping { 0% { r: 8; opacity: .9; } 70%,100% { r: 20; opacity: 0; } }
@keyframes nh-float { 0%,100% { transform: translate(0,0); } 33% { transform: translate(2.5px,-2px); } 66% { transform: translate(-2px,2.5px); } }
@keyframes nh-tap { 0%,55% { transform: scale(1); } 62% { transform: scale(.965); } 70%,100% { transform: scale(1); } }

.nh-typing { animation: nh-type 4.2s ease-in-out infinite; }
.nh-answer { animation: nh-pop 4.2s ease-in-out infinite; transform-origin: 210px 46px; }
.nh-drag { animation: nh-drag 4.6s cubic-bezier(.3,.7,.3,1) infinite; }
.nh-link { animation: nh-draw 4.6s ease-in-out infinite; }
.nh-port { animation: nh-pulse 4.6s ease-in-out infinite; }
.nh-stroke1 { animation: nh-draw 5s ease-in-out infinite; }
.nh-stroke2 { animation: nh-draw2 5s ease-in-out infinite; }
.nh-stroke3 { animation: nh-fadein 5s ease-in-out infinite; }
.nh-recognized { animation: nh-fadein2 5s ease-in-out infinite; }
.nh-pen-dot { animation: nh-pulse 5s ease-in-out infinite; }
.nh-flyout { animation: nh-pop 4s ease-in-out infinite; transform-origin: 310px 107px; }
.nh-tool-on { animation: nh-pulse 4s ease-in-out infinite; }
.nh-float { animation: nh-float 6s ease-in-out infinite; }
.nh-ping { animation: nh-ping 3.4s ease-out infinite; }
.nh-jump { animation: nh-pop 3.4s ease-in-out infinite; transform-origin: 314px 86px; }
.nh-tap { animation: nh-tap 4s ease-in-out infinite; transform-origin: 79px 71px; }
.nh-popup { animation: nh-pop 4s ease-in-out infinite; transform-origin: 152px 101px; }

/* 움직임을 줄여 달라고 한 사람에게는 **멈춘 그림**을 준다 — 설명은 글이 하고,
   그림은 거들 뿐이라 정지 상태로도 뜻이 통해야 한다. */
@media (prefers-reduced-motion: reduce) {
  .nh-typing, .nh-answer, .nh-drag, .nh-link, .nh-port, .nh-stroke1, .nh-stroke2,
  .nh-stroke3, .nh-recognized, .nh-pen-dot, .nh-flyout, .nh-tool-on, .nh-float,
  .nh-ping, .nh-jump, .nh-tap, .nh-popup { animation: none; }
  .nh-typing, .nh-answer, .nh-stroke3, .nh-recognized, .nh-flyout, .nh-jump, .nh-popup { opacity: 1; clip-path: none; }
  .nh-link, .nh-stroke1, .nh-stroke2 { stroke-dashoffset: 0; }
}
`}</style>
  );
}
