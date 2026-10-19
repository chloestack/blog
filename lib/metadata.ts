import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { OG_LOCALE, localePrefix, otherLocale } from "@/lib/i18n";
import { counterpartSlug, postHref, type Post } from "@/lib/posts";

/**
 * 공유 카드 이미지의 공개 경로. 한국어는 /og/<slug>.png, 영어는 /og/en/<slug>.png다.
 * PNG는 `scripts/build-og-images.mjs`가 next build 전에 public/og/에 그려 둔다.
 */
export function ogImagePath(post: Pick<Post, "locale" | "slug">): string {
  const prefix = post.locale === "ko" ? "/og" : "/og/en";
  return `${prefix}/${encodeURIComponent(post.slug)}.png`;
}

/**
 * 공유 이미지가 실제로 그려져 있는지. 글꼴을 받지 못해 생성을 건너뛴 빌드에서
 * og:image가 없는 파일을 가리키면 카드가 깨지므로, 있을 때만 붙인다.
 */
export function hasOgImage(post: Pick<Post, "locale" | "slug">): boolean {
  const dir = post.locale === "ko" ? ["og"] : ["og", "en"];
  return fs.existsSync(path.join(process.cwd(), "public", ...dir, `${post.slug}.png`));
}

/**
 * 글 페이지의 메타데이터. 두 언어가 같은 규칙을 쓰도록 한 곳에서 만든다.
 * 번역본이 있는 글에는 hreflang으로 짝을 알려 준다 — 크롤러는 리다이렉트로
 * 옮기지 않으므로, 같은 글임을 알릴 방법은 이 태그뿐이다.
 */
export function articleMetadata(post: Post): Metadata {
  const locale = post.locale;
  const url = postHref(post.slug, locale);
  const counterpart = counterpartSlug(post);
  const other = otherLocale(locale);
  const image = hasOgImage(post) ? ogImagePath(post) : undefined;

  const languages: Record<string, string> = { [locale]: url };
  if (counterpart) languages[other] = postHref(counterpart, other);
  // 원본은 한국어다. 언어를 가릴 수 없는 크롤러에게는 한국어 주소를 가리킨다.
  languages["x-default"] = locale === "ko" ? url : (counterpart ? postHref(counterpart, "ko") : `${localePrefix("ko")}/`);

  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: url, languages },
    // openGraph는 루트 레이아웃의 값을 물려받지 않고 통째로 대체된다.
    // siteName과 locale을 다시 적지 않으면 글 페이지 공유 카드에서만 빠진다.
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url,
      siteName: "blog.pistamond",
      locale: OG_LOCALE[locale],
      type: "article",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      tags: post.tags,
      ...(image ? { images: [{ url: image, width: 1200, height: 630, alt: post.title }] } : {}),
    },
    // 이미지가 있으면 메신저·SNS에서 큰 카드로 보이게 한다. 클릭률이 가장 크게 갈리는 지점이다.
    twitter: image
      ? { card: "summary_large_image", title: post.title, description: post.excerpt, images: [image] }
      : { card: "summary", title: post.title, description: post.excerpt },
  };
}
