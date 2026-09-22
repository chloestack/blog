import type { Metadata } from "next";
import { AdSense, ADSENSE_CLIENT } from "@/components/adsense";
import { GoogleAnalytics, NaverAnalytics } from "@/components/analytics";
import { OG_LOCALE, SITE_DESCRIPTION } from "@/lib/i18n";
import "../globals.css";

// 한국어 지면의 뿌리. 영문 지면은 app/(en)/layout.tsx가 따로 세운다 —
// <html lang>이 언어마다 달라야 해서 레이아웃을 둘로 나눴다.
const DESCRIPTION = SITE_DESCRIPTION.ko;

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "blog.pistamond", template: "%s · blog.pistamond" },
  description: DESCRIPTION,
  alternates: {
    canonical: "/",
    // 검색엔진에 두 언어가 같은 글임을 알린다. 지역에 따른 리다이렉트는
    // 크롤러에게 걸지 않으므로, 짝을 알려 주는 것은 이 태그뿐이다.
    languages: { ko: "/", en: "/en", "x-default": "/" },
    types: { "application/rss+xml": "/rss.xml" },
  },
  // 헤더 워드마크와 같은 표식을 탭에도 세운다. 링크 태그가 없으면 브라우저는
  // /favicon.ico를 찾다 실패하고 빈 아이콘을 쓴다.
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "blog.pistamond",
    description: DESCRIPTION,
    url: "/",
    siteName: "blog.pistamond",
    locale: OG_LOCALE.ko,
    type: "website",
  },
  twitter: { card: "summary", title: "blog.pistamond", description: DESCRIPTION },
  verification: {
    other: {
      "naver-site-verification": "230557197f1de53a7987731b9ebbbedc8163acfb",
      // 애드센스가 사이트 소유권을 확인하는 표식. 광고를 받아 오는 로더는 <AdSense />에 있다.
      "google-adsense-account": ADSENSE_CLIENT,
    },
  },
};

export default function KoreanLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 측정 태그는 </body> 바로 앞, 페이지 내용 다음에 온다.
  return <html lang="ko"><body>{children}<AdSense /><NaverAnalytics /><GoogleAnalytics /></body></html>;
}
