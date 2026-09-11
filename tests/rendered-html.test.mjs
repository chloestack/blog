import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import matter from "gray-matter";

const POSTS_DIR = new URL("../content/posts/", import.meta.url);

function readPosts() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(POSTS_DIR.pathname, file), "utf8"));
      return { title: String(data.title ?? ""), date: String(data.date ?? file.slice(0, 10)) };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the blog homepage", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>blog\.pistamond/);
  assert.match(html, /최근 기록/);
  // 카테고리는 목록 위가 아니라 왼쪽 레일에서만 나온다.
  assert.match(html, /class="category-rail"/);
  assert.doesNotMatch(html, /class="filter-bar"/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

/**
 * 이 사이트는 한때 템플릿에서 나온 가짜 글과 지어낸 소개 문구로 채워져 있었다.
 * 실제로 쓰지 않은 문장이 다시 지면에 올라오지 않도록 여기서 막는다.
 */
test("no placeholder copy or fake sections are served", async () => {
  const html = await (await render()).text();

  const banned = [
    "VOL. 01",
    "ENGINEERING NOTES",
    "FEATURED ESSAY",
    "만들면서 이해한 것들을",
    "결과보다 그 결과에 도착한 판단",
    "생각이 달라지면 글도 고칩니다",
    "코드 바깥의 판단까지",
    "pistamond는 제품을 만들고",
    "Seoul, KR",
    "Built with curiosity",
    "새 글을 천천히 받아보세요",
    "구독하기",
    "boundary.ts",
    "abstractions are decisions",
  ];
  for (const phrase of banned) {
    assert.ok(!html.includes(phrase), `placeholder copy is back on the homepage: ${phrase}`);
  }
});

test("every post in the repository is public on the homepage", async () => {
  const posts = readPosts();
  const html = await (await render()).text();

  for (const post of posts) {
    assert.ok(html.includes(post.title), `post missing from homepage: ${post.title}`);
  }
  if (posts.length === 0) assert.match(html, /아직 공개된 글이 없습니다/);
});
