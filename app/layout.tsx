import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://blog.pistamond.dev"),
  title: { default: "blog.pistamond", template: "%s · blog.pistamond" },
  alternates: { canonical: "/" },
  openGraph: { title: "blog.pistamond", url: "/", siteName: "blog.pistamond", locale: "ko_KR", type: "website" },
  twitter: { card: "summary", title: "blog.pistamond" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
