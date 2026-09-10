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

test("server-renders the technology blog homepage", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="ko">/i);
  assert.match(html, /<title>pistamond\.log/);
  assert.match(html, /만들면서 이해한 것들을/);
  assert.match(html, /최근 기록/);
  assert.match(html, /주제별 찾아보기/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);
});

// 홈에는 최신 글 7건(대표 1 + 목록 6)만 실린다. 그 범위 안의 글은 빠짐없이 보여야 한다.
test("every recent post in the repository is public on the homepage", async () => {
  const posts = readPosts().slice(0, 7);
  const html = await (await render()).text();

  for (const post of posts) {
    assert.ok(html.includes(post.title), `post missing from homepage: ${post.title}`);
  }
});
