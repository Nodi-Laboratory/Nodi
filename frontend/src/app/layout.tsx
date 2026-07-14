import type { Metadata } from "next";
import { Nanum_Pen_Script, Gaegu } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// Handwriting fonts for the concept-card canvas (scoped via CSS vars). Korean
// Google fonts: subsets:["latin"] + preload:false avoids build-time fetch errors.
const nanumPen = Nanum_Pen_Script({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-title",
  display: "swap",
  preload: false,
});
const gaegu = Gaegu({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-body",
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
    <html lang="ko" className={`h-full ${nanumPen.variable} ${gaegu.variable}`}>
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
