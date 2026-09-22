import type { Metadata } from "next";
import { AdSense, ADSENSE_CLIENT } from "@/components/adsense";
import { GoogleAnalytics, NaverAnalytics } from "@/components/analytics";
import { OG_LOCALE, SITE_DESCRIPTION } from "@/lib/i18n";
import "../globals.css";

// 영문 지면의 뿌리. 한국어 쪽(app/(ko)/layout.tsx)과 같은 몸통에 <html lang>과
// 설명만 다르다. 측정 태그와 광고는 두 지면이 같은 컴포넌트를 쓴다.
const DESCRIPTION = SITE_DESCRIPTION.en;

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "blog.pistamond", template: "%s · blog.pistamond" },
  description: DESCRIPTION,
  alternates: {
    canonical: "/en",
    languages: { ko: "/", en: "/en", "x-default": "/" },
    types: { "application/rss+xml": "/en/rss.xml" },
  },
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "blog.pistamond",
    description: DESCRIPTION,
    url: "/en",
    siteName: "blog.pistamond",
    locale: OG_LOCALE.en,
    type: "website",
  },
  twitter: { card: "summary", title: "blog.pistamond", description: DESCRIPTION },
  verification: { other: { "google-adsense-account": ADSENSE_CLIENT } },
};

export default function EnglishLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<AdSense /><NaverAnalytics /><GoogleAnalytics /></body></html>;
}
