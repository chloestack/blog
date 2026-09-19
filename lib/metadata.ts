import type { Metadata } from "next";
import { OG_LOCALE, localePrefix, otherLocale } from "@/lib/i18n";
import { counterpartSlug, postHref, type Post } from "@/lib/posts";

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
    },
    twitter: { card: "summary", title: post.title, description: post.excerpt },
  };
}
