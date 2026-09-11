import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 마크다운은 런타임에 fs로 읽는다. 추적기가 잡지 못하므로 명시적으로 포함한다.
  outputFileTracingIncludes: {
    "/": ["./content/**/*"],
    "/sitemap.xml": ["./content/**/*"],
    "/rss.xml": ["./content/**/*"],
    "/posts/[slug]": ["./content/**/*"],
  },
};

export default nextConfig;
