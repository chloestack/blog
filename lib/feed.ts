import { SITE, SITE_DESCRIPTION, localePrefix, type Locale } from "@/lib/i18n";
import { getAllPosts, postHref } from "@/lib/posts";

const TITLE = "blog.pistamond";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 언어마다 피드가 하나씩 선다. 한국어는 /rss.xml, 영문은 /en/rss.xml. */
export function renderFeed(locale: Locale): Response {
  const posts = getAllPosts(locale);
  const self = `${SITE}${localePrefix(locale)}/rss.xml`;
  // 발행 시각이 곧 목록 순서다. 피드의 lastBuildDate도 맨 앞 글에서 가져온다.
  const updated = posts[0] ? new Date(posts[0].publishedAt) : new Date();

  const items = posts
    .map((post) => {
      const url = `${SITE}${postHref(post.slug, locale)}`;
      return [
        "<item>",
        `<title>${escapeXml(post.title)}</title>`,
        `<link>${escapeXml(url)}</link>`,
        `<guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `<pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>`,
        `<category>${escapeXml(post.category)}</category>`,
        `<description>${escapeXml(post.excerpt)}</description>`,
        "</item>",
      ].join("");
    })
    .join("");

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">' +
    "<channel>" +
    `<title>${escapeXml(TITLE)}</title>` +
    `<link>${SITE}${localePrefix(locale) || "/"}</link>` +
    `<description>${escapeXml(SITE_DESCRIPTION[locale])}</description>` +
    `<language>${locale}</language>` +
    `<lastBuildDate>${updated.toUTCString()}</lastBuildDate>` +
    `<atom:link href="${self}" rel="self" type="application/rss+xml"/>` +
    items +
    "</channel></rss>";

  return new Response(body, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
