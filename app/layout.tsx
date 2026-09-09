import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://pistamond.dev"),
  title: { default: "pistamond.log — 소프트웨어를 만들며 배운 것들", template: "%s · pistamond.log" },
  description: "소프트웨어의 구조, 인터페이스, 운영에 관한 기술 블로그. 결과보다 그 결과에 도착한 판단을 기록합니다.",
  keywords: ["기술 블로그", "소프트웨어 엔지니어링", "프론트엔드", "시스템 디자인", "개발"],
  alternates: { canonical: "/" },
  openGraph: { title: "pistamond.log", description: "만들면서 이해한 것들을 다시 꺼내 쓸 수 있게 기록합니다.", url: "/", siteName: "pistamond.log", locale: "ko_KR", type: "website" },
  twitter: { card: "summary", title: "pistamond.log", description: "소프트웨어의 구조, 인터페이스, 운영에 관한 기술 블로그." },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
