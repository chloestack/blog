import { getAllPosts, postHref } from "@/lib/posts";

const SITE = "https://blog.pistamond.dev";
const TITLE = "blog.pistamond";
const DESCRIPTION =
  "소프트웨어의 구조와 인터페이스, 운영에서 내린 판단을 기록하는 한국어 기술 블로그입니다. Spring·Java·아키텍처·DevOps·AI 도구를 다룹니다.";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function GET(): Response {
  const posts = getAllPosts();
  // 발행 시각이 곧 목록 순서다. 피드의 lastBuildDate도 맨 앞 글에서 가져온다.
  const updated = posts[0] ? new Date(posts[0].publishedAt) : new Date();

  const items = posts
    .map((post) => {
      const url = `${SITE}${postHref(post.slug)}`;
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
    `<link>${SITE}</link>` +
    `<description>${escapeXml(DESCRIPTION)}</description>` +
    "<language>ko</language>" +
    `<lastBuildDate>${updated.toUTCString()}</lastBuildDate>` +
    `<atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>` +
    items +
    "</channel></rss>";

  return new Response(body, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
