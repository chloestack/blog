import type { MetadataRoute } from "next";
import { SITE, localePrefix } from "@/lib/i18n";
import { counterpartSlug, getAllPosts, postHref } from "@/lib/posts";

/**
 * 두 언어의 주소를 한 사이트맵에 담고, 짝이 있는 글에는 alternates로 서로를
 * 가리킨다. 지역에 따른 리다이렉트는 크롤러에게 걸지 않으므로 색인은 이 목록과
 * hreflang만 보고 만들어진다.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const ko = getAllPosts("ko");
  const en = getAllPosts("en");

  const home: MetadataRoute.Sitemap = [
    {
      url: SITE,
      lastModified: ko[0]?.publishedAt || undefined,
      changeFrequency: "weekly",
      alternates: { languages: { ko: SITE, en: `${SITE}/en` } },
    },
    { url: `${SITE}/privacy`, changeFrequency: "yearly" as const },
  ];

  if (en.length > 0) {
    home.push({
      url: `${SITE}${localePrefix("en")}`,
      lastModified: en[0]?.publishedAt || undefined,
      changeFrequency: "weekly",
      alternates: { languages: { ko: SITE, en: `${SITE}/en` } },
    });
  }

  const posts = [...ko, ...en].map((post) => {
    const url = `${SITE}${postHref(post.slug, post.locale)}`;
    const counterpart = counterpartSlug(post);
    const koUrl = post.locale === "ko" ? url : `${SITE}${postHref(post.koSlug, "ko")}`;
    const enUrl = post.locale === "en" ? url : counterpart ? `${SITE}${postHref(counterpart, "en")}` : null;

    return {
      url,
      lastModified: post.publishedAt,
      ...(counterpart && enUrl ? { alternates: { languages: { ko: koUrl, en: enUrl } } } : {}),
    };
  });

  return [...home, ...posts];
}
