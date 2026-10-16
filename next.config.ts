import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 마크다운은 런타임에 fs로 읽는다. 추적기가 잡지 못하므로 명시적으로 포함한다.
  outputFileTracingIncludes: {
    "/": ["./content/**/*"],
    "/sitemap.xml": ["./content/**/*"],
    "/rss.xml": ["./content/**/*"],
    "/posts/[slug]": ["./content/**/*"],
    "/en": ["./content/**/*"],
    "/en/rss.xml": ["./content/**/*"],
    "/en/posts/[slug]": ["./content/**/*"],
  },
  // 이 프로젝트에는 루트 도메인도 붙어 있어 같은 글이 두 주소로 열렸다. 공식 주소는
  // blog.pistamond.dev 하나다(canonical·사이트맵과 같다). ads.txt만 남긴다 —
  // 애드센스는 하위 도메인 사이트의 ads.txt를 루트 도메인에서 찾는다.
  async redirects() {
    return [
      {
        source: "/:path((?!ads\\.txt$).*)",
        has: [{ type: "host", value: "pistamond.dev" }],
        destination: "https://blog.pistamond.dev/:path",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
