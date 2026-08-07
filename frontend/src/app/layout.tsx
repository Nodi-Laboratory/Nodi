import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

/**
 * 캔버스 v2 타이포 (D127).
 *
 * 손글씨 폰트(Nanum Pen Script · Gaegu)를 걷어냈다. 본문에 손글씨를 쓰면
 * 긴 글이 안 읽히고, 무엇보다 이 화면이 학습지처럼 보인다. 대신 역할을
 * 셋으로 나눈다:
 *
 *   본문   Pretendard        한글 가변 폰트. 밀도 높은 문단에 제일 잘 읽힌다
 *   UI     IBM Plex Sans KR  각진 터미널 — 제도 도구의 인상. 한글을 지원한다
 *   라벨   IBM Plex Mono     태그·단축키·수치. 고정폭이 "계측"의 감각을 준다
 *
 * D164에서 넷째 역할이 붙었다(사용자 지시 2026-08-03):
 *
 *   캔버스 글  나눔손글씨 야근하는 김주임   학생·AI가 노트에 쓴 글. **여기에만**
 *
 * D127이 손글씨를 걷어낸 근거(긴 글이 안 읽힌다·화면이 학습지가 된다)는
 * 여전하므로 UI 크롬과 앱의 나머지 화면에는 절대 번지지 않게 `.canvas2 .hand`
 * 로 스코프한다(globals.css).
 *
 * 캔버스 폰트만 **이 파일에 없다**(2026-08-04, Gaegu 대체). Google Fonts에 없어
 * 자체 호스팅해야 하는데, 여기에 두면 앱 전체가 그 CSS를 받는다. @font-face는
 * `components/canvas2/hand-font.css`(생성물)에 있고 CanvasStage가 임포트한다.
 */
const plexSans = IBM_Plex_Sans_KR({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
  preload: false,
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-label",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "nodi",
  description: "AI 대화를 노드·트리 구조로 시각화하는 대화형 AI 서비스",
};

/**
 * 뷰포트 (D204) — **패드에서 아래가 잘리던 문제.**
 *
 * 셸이 `100vh`였다. 모바일 브라우저의 `100vh`는 주소창이 **보이지 않는다고
 * 가정한** 높이라, 주소창이 떠 있는 동안 화면보다 큰 상자가 된다. 그래서
 * 아래에 붙는 것들(질문 입력창·사이드바 하단 프로필)이 화면 밖으로 밀려
 * 눌러 볼 수조차 없었다(사용자 보고 2026-08-07). 셸은 `dvh`로 옮겼다.
 *
 * `interactiveWidget`은 **자판이 올라올 때** 같은 일이 벌어지는 것을 막는다 —
 * 기본값(`resizes-visual`)은 상자 크기를 그대로 두고 화면만 밀어 올려서
 * 입력창이 자판 뒤에 깔린다.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 확대를 막지 않는다 — 교실에서 글씨를 키워 보는 학생이 있다.
  maximumScale: 5,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`h-full ${plexSans.variable} ${plexMono.variable}`}
      /**
       * 하이드레이션 경고를 여기서만 끈다 (2026-08-04 실측).
       *
       * 크롬의 비밀번호 관리자·자동완성이 React가 붙기 **전에** DOM을 고친다 —
       * `<html __gcrremoteframetoken>`. 서버가 보낸 HTML에는 없는 속성이라
       * 하이드레이션 불일치로 잡히고, 콘솔에 빨간 오류가 매 로드마다 찍힌다.
       * 우리 코드가 만든 것이 아니고 우리가 없앨 수도 없다(확장·브라우저 기능).
       *
       * **한 겹만 덮는다** — 이 요소의 속성·텍스트까지고 자식에는 안 내려간다.
       * 진짜 불일치(날짜·랜덤·분기)는 그대로 드러난다.
       */
      suppressHydrationWarning
    >
      <head>
        {/* Pretendard (한글 가변 폰트, dynamic subset) */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css"
        />
      </head>
      <body className="min-h-full bg-bg text-fg antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
