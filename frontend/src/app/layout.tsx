import type { Metadata } from "next";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`h-full ${plexSans.variable} ${plexMono.variable}`}>
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
