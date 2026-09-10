import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "pistamond.log", template: "%s · pistamond.log" },
  alternates: { canonical: "/" },
  openGraph: { title: "pistamond.log", url: "/", siteName: "pistamond.log", locale: "ko_KR", type: "website" },
  twitter: { card: "summary", title: "pistamond.log" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
