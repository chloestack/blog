import type { Metadata } from "next";
import { NaverAnalytics } from "@/components/analytics";
import "./globals.css";

// 검색 결과와 공유 카드에 함께 나가는 한 문장. README가 이 블로그를 설명하는
// 말을 그대로 쓴다 — 두 곳이 따로 놀면 어느 쪽이 맞는지 알 수 없게 된다.
const DESCRIPTION =
  "소프트웨어의 구조와 인터페이스, 운영에서 내린 판단을 기록하는 한국어 기술 블로그입니다. Spring·Java·아키텍처·DevOps·AI 도구를 다룹니다.";

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "blog.pistamond", template: "%s · blog.pistamond" },
  description: DESCRIPTION,
  alternates: { canonical: "/", types: { "application/rss+xml": "/rss.xml" } },
  // 헤더 워드마크와 같은 표식을 탭에도 세운다. 링크 태그가 없으면 브라우저는
  // /favicon.ico를 찾다 실패하고 빈 아이콘을 쓴다.
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "blog.pistamond",
    description: DESCRIPTION,
    url: "/",
    siteName: "blog.pistamond",
    locale: "ko_KR",
    type: "website",
  },
  twitter: { card: "summary", title: "blog.pistamond", description: DESCRIPTION },
  verification: { other: { "naver-site-verification": "230557197f1de53a7987731b9ebbbedc8163acfb" } },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 측정 태그는 </body> 바로 앞, 페이지 내용 다음에 온다.
  return <html lang="ko"><body>{children}<NaverAnalytics /></body></html>;
}
