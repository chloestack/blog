import type { Metadata } from "next";
import { NaverAnalytics } from "@/components/analytics";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "blog.pistamond", template: "%s · blog.pistamond" },
  alternates: { canonical: "/" },
  openGraph: { title: "blog.pistamond", url: "/", siteName: "blog.pistamond", locale: "ko_KR", type: "website" },
  twitter: { card: "summary", title: "blog.pistamond" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 측정 태그는 </body> 바로 앞, 페이지 내용 다음에 온다.
  return <html lang="ko"><body>{children}<NaverAnalytics /></body></html>;
}
