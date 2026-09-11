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
      const slug = file.replace(/\.md$/, "");
      return { slug, title: String(data.title ?? ""), date: String(data.date ?? slug.slice(0, 10)) };
    })
    // 사이트와 같은 기준: 발행 시각 내림차순, 같은 시각이면 slug.
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
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
  // 목록 위의 "최근 기록" 제목은 걷어냈다. 날짜순 목록이 바로 아래에 있어 제목이
  // 하는 일이 없었다. 섹션 이름은 aria-label로만 남는다.
  assert.doesNotMatch(html, /최근 기록/);
  assert.match(html, /<section class="articles"[^>]*aria-label="글 목록"/);
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

/**
 * 네이버 애널리틱스(wcs) 태그는 루트 레이아웃이 </body> 바로 앞에 한 번만 넣는다.
 * 새 페이지를 만들 때 붙이는 것을 잊어도 되도록 만든 규칙이라, 페이지마다
 * 실제로 따라붙는지 여기서 지킨다.
 */
test("every page closes with the naver analytics tag", async () => {
  const posts = readPosts();
  const pages = ["/", ...posts.slice(0, 1).map((post) => `/posts/${encodeURIComponent(post.slug)}`)];

  for (const pathname of pages) {
    const html = await (await render(pathname)).text();
    const loader = html.indexOf('src="//wcs.pstatic.net/wcslog.js"');
    const account = html.indexOf('wcs_add["wa"] = "2d2e2d4e62aa6e"');
    const bodyEnd = html.indexOf("</body>");

    assert.ok(loader > 0, `analytics loader missing: ${pathname}`);
    assert.ok(account > loader, `analytics account id missing or before the loader: ${pathname}`);
    assert.ok(account < bodyEnd, `analytics tag is not inside the body: ${pathname}`);
    // 본문 다음, 프레임워크 부트스트랩 앞. 즉 페이지가 그리는 마지막 것.
    assert.ok(loader > html.indexOf("</main>"), `analytics tag runs before the page content: ${pathname}`);
    // RSC 페이로드에도 같은 문자열이 실리므로, 문서 부분만 놓고 센다.
    const document = html.slice(0, bodyEnd);
    assert.equal(document.split("wcs_do()").length - 1, 1, `analytics tag is duplicated: ${pathname}`);
  }
});

/**
 * 글을 다 읽은 사람에게 다음 행선지를 준다. 같은 카테고리를 먼저 채우되,
 * 자기 자신이 그 목록에 다시 나오면 안 된다.
 */
test("an article ends with related posts that exclude itself", async () => {
  const posts = readPosts();
  if (posts.length < 2) return;

  const [post] = posts;
  const html = await (await render(`/posts/${encodeURIComponent(post.slug)}`)).text();
  const section = html.slice(html.indexOf('class="related"'), html.indexOf("<footer"));

  assert.ok(section.includes("관련 글"), "related section is missing from the article");
  const links = [...section.matchAll(/href="\/posts\/([^"]+)"/g)].map((match) => decodeURIComponent(match[1]));
  assert.ok(links.length > 0 && links.length <= 4, `unexpected related count: ${links.length}`);
  assert.ok(!links.includes(post.slug), "the article links to itself as a related post");
  assert.equal(new Set(links).size, links.length, "related posts are duplicated");
});

/**
 * 날짜에는 시각까지 적는다. 하루에 여러 편이 올라오는 블로그라, 날짜만 있으면
 * 같은 날 글의 순서가 파일명 순으로 흩어졌다.
 */
test("the homepage lists posts newest first, by publish time", async () => {
  const posts = readPosts();
  if (posts.length < 2) return;

  for (const post of posts) {
    assert.match(post.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `post has no publish time: ${post.slug}`);
  }

  const html = await (await render()).text();
  const listed = [...html.matchAll(/<h3><a href="\/posts\/([^"]+)"/g)].map((match) => decodeURIComponent(match[1]));
  assert.deepEqual(listed, posts.map((post) => post.slug));
});

/**
 * 목록 왼쪽에 있던 01, 02… 는 순위도 번호도 아닌 그냥 줄 번호였다. 그 자리에
 * 발행 날짜와 시각을 넣었고, 글 상세의 "N분" 예상 독서 시간은 뺐다.
 */
test("rows are stamped with the publish time instead of a running number", async () => {
  const home = await (await render()).text();
  assert.doesNotMatch(home, /class="post-number"/);
  assert.match(home, /class="when-day">2026\.\d{2}\.\d{2}</);
  assert.match(home, /class="when-clock">\d{2}:\d{2}</);

  const posts = readPosts();
  if (posts.length === 0) return;
  const article = await (await render(`/posts/${encodeURIComponent(posts[0].slug)}`)).text();
  const head = article.slice(article.indexOf('class="article-head"'), article.indexOf("</h1>")).replaceAll("<!-- -->", "");
  assert.doesNotMatch(head, /\d+분/, "reading time is back on the article");
  assert.match(head, /<span class="meta">2026\.\d{2}\.\d{2} \d{2}:\d{2}<\/span>/);
});
