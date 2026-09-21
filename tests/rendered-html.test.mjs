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

async function render(pathname = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" }, ...init }),
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
  // 날짜와 시각은 줄 맨 앞이 아니라 카테고리 태그 바로 옆에 붙는다.
  assert.match(
    home,
    /<div class="label-row"><span class="tag [a-z]+">[A-Z]+<\/span><span class="post-when"><span class="when-day">2026\.\d{2}\.\d{2}<\/span><span class="when-clock">\d{2}:\d{2}</,
  );

  const posts = readPosts();
  if (posts.length === 0) return;
  const article = await (await render(`/posts/${encodeURIComponent(posts[0].slug)}`)).text();
  const head = article.slice(article.indexOf('class="article-head"'), article.indexOf("</h1>")).replaceAll("<!-- -->", "");
  // 제목에 "5분" 같은 말이 들어갈 수 있으니 독서 시간은 제목 앞 메타 줄에서만 찾는다.
  assert.doesNotMatch(head.slice(0, head.indexOf("<h1")), /\d+분/, "reading time is back on the article");
  assert.match(head, /<span class="meta">2026\.\d{2}\.\d{2} \d{2}:\d{2}<\/span>/);
});

/**
 * 검색 결과와 공유 카드에 나가는 설명. 글 페이지는 루트의 설명을 물려받지 않고
 * 자기 발췌문으로 덮어써야 하고, openGraph는 통째로 대체되는 값이라
 * siteName·locale이 조용히 빠지기 쉽다.
 */
test("every page describes itself for search results and share cards", async () => {
  const head = (await (await render()).text()).split("</head>")[0];
  for (const attr of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    assert.match(head, new RegExp(`<meta ${attr} content="소프트웨어의 구조`), `homepage is missing ${attr}`);
  }

  const posts = readPosts();
  if (posts.length === 0) return;
  const article = (await (await render(`/posts/${encodeURIComponent(posts[0].slug)}`)).text()).split("</head>")[0];
  assert.doesNotMatch(article, /content="소프트웨어의 구조[^"]*"/, "the article reuses the site description");
  for (const attr of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    assert.match(article, new RegExp(`<meta ${attr} content="[^"]+"`), `article is missing ${attr}`);
  }
  assert.match(article, /property="og:site_name" content="blog\.pistamond"/);
  assert.match(article, /property="og:locale" content="ko_KR"/);

  const robots = await (await render("/robots.txt")).text();
  assert.match(robots, /User-Agent: \*/i);
  assert.match(robots, /Sitemap: https:\/\/blog\.pistamond\.dev\/sitemap\.xml/);
});

/**
 * 푸터는 세 페이지가 같은 컴포넌트를 쓴다. 소개, 라벨 붙은 연락처, 개인정보처리방침
 * 링크가 어느 페이지에서도 빠지지 않아야 한다.
 */
test("the footer introduces the site and labels the contact address", async () => {
  const posts = readPosts();
  const pages = ["/", "/privacy", ...posts.slice(0, 1).map((post) => `/posts/${encodeURIComponent(post.slug)}`)];

  for (const pathname of pages) {
    const html = await (await render(pathname)).text();
    const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
    assert.match(footer, /About/, `no about section: ${pathname}`);
    assert.match(footer, /Java\/Spring 기반 백엔드 개발과/, `no about copy: ${pathname}`);
    assert.match(footer, /Contact · 연락처/, `the contact address has no label: ${pathname}`);
    assert.match(footer, /<a href="mailto:contact@pistamond\.dev">contact@pistamond\.dev<\/a>/, `no contact address: ${pathname}`);
    assert.match(footer, /href="\/privacy">개인정보처리방침</, `no privacy link: ${pathname}`);
  }
});

/** 개인정보처리방침은 별도 페이지로 서고, 실제로 쓰는 외부 서비스를 밝힌다. */
test("the privacy policy stands on its own page", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<title>개인정보처리방침 · blog\.pistamond/);
  assert.match(html, /<h1[^>]*>개인정보처리방침</);
  const sections = [...html.matchAll(/<h2>(\d)\. /g)].map((match) => match[1]);
  assert.deepEqual(sections, ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.match(html, /네이버 애널리틱스/, "the policy hides the analytics it actually runs");
  assert.match(html, /mailto:contact@pistamond\.dev/);
  assert.match(html, /Upstash/, "the policy does not disclose the visit counter");
  assert.match(html, /시행일: 2026년 9월 16일/);

  const sitemap = await (await render("/sitemap.xml")).text();
  assert.match(sitemap, /https:\/\/blog\.pistamond\.dev\/privacy/);
});

/** 탭 아이콘. 링크 태그가 없으면 브라우저는 빈 아이콘을 쓴다. */
test("every page points the browser tab at the P mark", async () => {
  const posts = readPosts();
  const pages = ["/", ...posts.slice(0, 1).map((post) => `/posts/${encodeURIComponent(post.slug)}`)];

  for (const pathname of pages) {
    const html = await (await render(pathname)).text();
    assert.match(html, /<link rel="icon" href="[^"]*\/favicon\.svg"/, `no tab icon: ${pathname}`);
  }
});

/**
 * RSS 피드. 리더와 검색엔진이 새 글을 빨리 집어가는 통로이고, 네이버
 * 서치어드바이저에도 이 주소를 넣는다.
 */
test("the blog publishes a valid RSS feed", async () => {
  const response = await render("/rss.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/rss\+xml/);
  const xml = await response.text();

  const posts = readPosts();
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].map((match) => match[0]);
  assert.equal(items.length, posts.length, "the feed and the repository disagree on how many posts exist");

  for (const item of items) {
    assert.match(item, /<link>https:\/\/blog\.pistamond\.dev\/posts\//);
    assert.match(item, /<guid isPermaLink="true">/);
    // RFC 822. 리더가 못 읽으면 글 순서가 무너진다.
    assert.match(item, /<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
  }
  // 제목과 발췌문에 &, < 가 섞여도 문서가 깨지면 안 된다.
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos);/g, ""), /&/);
  assert.match(xml, /<atom:link href="https:\/\/blog\.pistamond\.dev\/rss\.xml" rel="self"/);

  const home = await (await render()).text();
  assert.match(home, /<link rel="alternate" type="application\/rss\+xml" href="[^"]*\/rss\.xml"/);
});

/**
 * 애드센스도 측정 태그와 같은 규칙이다 — 루트 레이아웃이 한 번만 넣고, 페이지마다
 * 손으로 붙이지 않는다. 소유권 표식(meta)과 광고 로더가 둘 다 있어야 하고,
 * ads.txt가 없으면 구글은 이 게시자를 이 도메인의 판매자로 인정하지 않는다.
 */
test("every page carries the adsense tag, and ads.txt names the publisher", async () => {
  const posts = readPosts();
  const pages = ["/", "/privacy", ...posts.slice(0, 1).map((post) => `/posts/${encodeURIComponent(post.slug)}`)];

  for (const pathname of pages) {
    const html = await (await render(pathname)).text();
    const head = html.split("</head>")[0];
    assert.match(head, /name="google-adsense-account" content="ca-pub-3822322592120078"/, `no adsense account meta: ${pathname}`);
    // RSC 페이로드에도 같은 주소가 실리므로 문서 부분만 놓고 센다.
    const document = html.slice(0, html.indexOf("</body>"));
    assert.match(document, /adsbygoogle\.js\?client=ca-pub-3822322592120078/, `no adsense loader: ${pathname}`);
    assert.equal(
      document.split("pagead/js/adsbygoogle.js").length - 1,
      1,
      `the adsense loader is duplicated: ${pathname}`,
    );
  }

  const adsTxt = fs.readFileSync(new URL("../public/ads.txt", import.meta.url), "utf8").trim();
  assert.equal(adsTxt, "google.com, pub-3822322592120078, DIRECT, f08c47fec0942fa0");

  const privacy = await (await render("/privacy")).text();
  assert.match(privacy, /Google AdSense/, "the policy hides the ads it actually serves");
});

/**
 * 한국어 글은 범위를 "10~20%"처럼 물결표로 쓴다. GFM 기본값은 물결표 하나도
 * 취소선으로 읽어서, 한 문단에 범위가 두 번 나오면 그 사이가 통째로 그어졌다.
 * 취소선은 ~~ 두 개일 때만 인정한다.
 */
test("a single tilde in a range is text, not strikethrough", async () => {
  const [file] = fs
    .readdirSync(POSTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /\d~\d[^\n]*\d~\d/.test(fs.readFileSync(path.join(POSTS_DIR.pathname, name), "utf8")));
  if (!file) return;

  const html = await (await render(`/posts/${encodeURIComponent(file.replace(/\.md$/, ""))}`)).text();
  const prose = html.slice(html.indexOf('class="prose"'), html.indexOf("</article>"));
  assert.doesNotMatch(prose, /\d<del>/, "a tilde range turned into strikethrough");
  assert.match(prose, /\d~\d/);
});

/**
 * mermaid 블록은 코드 블록이 아니라 도식 자리로 나간다. 원문은 그대로 담겨 있어서
 * 스크립트가 돌기 전이나 실패했을 때도 읽을 수 있다.
 */
test("mermaid blocks become diagram placeholders", async () => {
  const [file] = fs
    .readdirSync(POSTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => /^```mermaid/m.test(fs.readFileSync(path.join(POSTS_DIR.pathname, name), "utf8")));
  if (!file) return;

  const html = await (await render(`/posts/${encodeURIComponent(file.replace(/\.md$/, ""))}`)).text();
  const prose = html.slice(html.indexOf('class="prose"'), html.indexOf("</article>"));
  assert.match(prose, /<figure class="diagram"><pre class="mermaid">/);
  assert.doesNotMatch(prose, /class="language-mermaid"/);
  assert.doesNotMatch(prose, /<pre class="mermaid">[^<]*<(?!\/pre>)/, "diagram source is not escaped");
});

/**
 * 방문자 수는 저장소가 연결됐을 때만 센다. 로컬·테스트에는 연결 정보가 없으니
 * API는 null을 돌려주고, 목록 머리의 방문자 수 자리는 비어 있어야 한다.
 */
test("the visit counter stays silent without a store", async () => {
  const response = await render("/api/visit", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(await response.json(), null);

  // 자리는 목록 머리에 잡혀 있지만 숫자는 비어 있다.
  const html = await (await render()).text();
  assert.match(html, /<div class="articles-main"><p class="visit-counter"[^>]*><\/p>/);
  assert.doesNotMatch(html, /오늘 <b>/);
});

// ---------------------------------------------------------------------------
// 영문 지면
// ---------------------------------------------------------------------------

const EN_POSTS_DIR = new URL("../content/posts/en/", import.meta.url);

function readEnglishPosts() {
  if (!fs.existsSync(EN_POSTS_DIR)) return [];
  return fs
    .readdirSync(EN_POSTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(EN_POSTS_DIR.pathname, file), "utf8"));
      return { slug: file.replace(/\.md$/, ""), title: String(data.title ?? ""), koSlug: String(data.koSlug ?? "") };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** 방문자의 지역·언어·선택을 흉내내 요청한다. */
function visitor(headers) {
  return { headers: { accept: "text/html", ...headers } };
}

const FROM_KOREA = { "cf-ipcountry": "KR", "accept-language": "ko-KR,ko;q=0.9" };
const FROM_ABROAD = { "cf-ipcountry": "US", "accept-language": "en-US,en;q=0.9" };

/**
 * 영문 지면은 한국어 지면과 같은 몸통에 <html lang>과 문구만 다르다. 번역본이
 * 저장소에 있으면 전부 목록에 선다 — 한국어와 같은 규칙이다.
 */
test("the english pages stand on their own locale", async () => {
  const response = await render("/en");
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /<html lang="en">/i);
  assert.match(html, /<section class="articles"[^>]*aria-label="Posts"/);
  // 머리의 언어 전환 링크만은 상대 언어로 적는다 — 그 한 줄은 빼고 본다.
  const body = html.slice(0, html.indexOf("</main>")).replace(/<a [^>]*class="lang-switch"[^>]*>.*?<\/a>/s, "");
  assert.doesNotMatch(body, /[가-힣]/, "korean copy leaked into the english page");

  for (const post of readEnglishPosts()) {
    assert.ok(html.includes(post.title), `english post missing from /en: ${post.title}`);
  }
});

/** 번역본은 원본을 frontmatter의 koSlug로 가리킨다. 짝이 없으면 고립된 글이 된다. */
test("every english post points back at a korean post", async () => {
  const korean = new Set(readPosts().map((post) => post.slug));
  for (const post of readEnglishPosts()) {
    assert.ok(post.koSlug, `no koSlug: en/${post.slug}`);
    assert.ok(korean.has(post.koSlug), `koSlug has no korean post: en/${post.slug} → ${post.koSlug}`);
  }
});

/**
 * 미들웨어가 읽는 slug 색인은 번역본 frontmatter에서 파생된 파일이다. 손으로
 * 고치거나 `npm run pairs`를 잊으면 리다이렉트가 옛 짝을 가리킨다.
 */
test("the slug index agrees with the translations on disk", async () => {
  const { POST_PAIRS } = await import(new URL("../lib/post-pairs.generated.ts", import.meta.url).href);
  const expected = Object.fromEntries(readEnglishPosts().map((post) => [post.koSlug, post.slug]));
  assert.deepEqual(POST_PAIRS, expected, "run npm run pairs");
});

/**
 * 두 언어가 같은 글임을 검색엔진에 알리는 것은 hreflang뿐이다 — 크롤러에게는
 * 지역 리다이렉트를 걸지 않는다. canonical은 언제나 자기 자신을 가리킨다.
 */
test("paired posts declare each other with hreflang", async () => {
  const [pair] = readEnglishPosts();
  if (!pair) return;

  const koUrl = `https://blog.pistamond.dev/posts/${encodeURIComponent(pair.koSlug)}`;
  const enUrl = `https://blog.pistamond.dev/en/posts/${pair.slug}`;

  for (const [pathname, self] of [
    [`/posts/${encodeURIComponent(pair.koSlug)}`, koUrl],
    [`/en/posts/${pair.slug}`, enUrl],
  ]) {
    const head = (await (await render(pathname)).text()).split("</head>")[0];
    assert.match(head, new RegExp(`rel="canonical" href="${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `wrong canonical: ${pathname}`);
    for (const [lang, url] of [["ko", koUrl], ["en", enUrl], ["x-default", koUrl]]) {
      assert.ok(
        head.includes(`hrefLang="${lang}" href="${url}"`),
        `missing hreflang ${lang} on ${pathname}`,
      );
    }
  }

  // 목록도 서로를 가리킨다.
  const home = (await (await render("/")).text()).split("</head>")[0];
  assert.ok(home.includes('hrefLang="en" href="https://blog.pistamond.dev/en"'));
});

/**
 * 한국 밖에서 들어온 사람은 같은 글의 영문 주소로 보낸다. 한국어를 읽는
 * 브라우저, 크롤러, 언어를 직접 고른 사람은 그대로 둔다 — 원본은 한국어다.
 */
test("visitors from outside korea land on the english post", async () => {
  const [pair] = readEnglishPosts();
  if (!pair) return;
  const korean = `/posts/${encodeURIComponent(pair.koSlug)}`;

  const abroad = await render(korean, visitor(FROM_ABROAD));
  assert.equal(abroad.status, 302);
  assert.equal(new URL(abroad.headers.get("location")).pathname, `/en/posts/${pair.slug}`);
  // 방문자마다 다른 응답이다. 중간 캐시가 한 사람의 결과를 남에게 주면 안 된다.
  assert.match(abroad.headers.get("cache-control") ?? "", /no-store/);

  const home = await render("/", visitor(FROM_ABROAD));
  assert.equal(home.status, 302);
  assert.equal(new URL(home.headers.get("location")).pathname, "/en");

  for (const [who, headers] of [
    ["from korea", FROM_KOREA],
    ["korean browser abroad", { "cf-ipcountry": "US", "accept-language": "ko-KR,ko;q=0.9" }],
    ["googlebot", { ...FROM_ABROAD, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }],
    ["chose korean", { ...FROM_ABROAD, cookie: "lang=ko" }],
  ]) {
    const response = await render(korean, visitor(headers));
    assert.equal(response.status, 200, `redirected a visitor that should stay: ${who}`);
  }

  // 영문 주소로 직접 들어온 사람은 되돌리지 않는다. 공유된 링크가 열려야 한다.
  const direct = await render(`/en/posts/${pair.slug}`, visitor(FROM_KOREA));
  assert.equal(direct.status, 200);
});

/** 번역본이 없는 글은 옮길 곳이 없다. 한국어 그대로 보여 준다. */
test("a post without a translation is served as it is", async () => {
  const translated = new Set(readEnglishPosts().map((post) => post.koSlug));
  const untranslated = readPosts().find((post) => !translated.has(post.slug));
  if (!untranslated) return;

  const response = await render(`/posts/${encodeURIComponent(untranslated.slug)}`, visitor(FROM_ABROAD));
  assert.equal(response.status, 200);
});

/**
 * 지역 추측은 첫 진입에서만 한다. 사이트 안에서 글을 넘겨 가는 중에 지면이
 * 영문으로 갈아엎히면 읽던 사람이 길을 잃는다.
 */
test("browsing inside the site is never flipped by geography", async () => {
  const [pair] = readEnglishPosts();
  if (!pair) return;
  const korean = `/posts/${encodeURIComponent(pair.koSlug)}`;
  const inside = { ...FROM_ABROAD, referer: "http://localhost/" };

  const response = await render(korean, visitor(inside));
  assert.equal(response.status, 200, "flipped a visitor who clicked a link inside the site");

  // 다른 사이트에서 들어온 첫 진입은 그대로 옮긴다.
  const outside = await render(korean, visitor({ ...FROM_ABROAD, referer: "https://news.ycombinator.com/" }));
  assert.equal(outside.status, 302);

  // 직접 고른 언어는 사이트 안 이동에서도 계속 듣는다.
  const chose = await render(korean, visitor({ ...inside, cookie: "lang=en" }));
  assert.equal(chose.status, 302);
  assert.equal(new URL(chose.headers.get("location")).pathname, `/en/posts/${pair.slug}`);
});

/**
 * 접속 국가를 모를 때 쓰는 값(Cloudflare의 XX, T1)을 나라로 믿으면 "KR이 아니다"가
 * 되어, 한국에서 영어로 설정된 브라우저로 보는 사람이 영문으로 밀려난다.
 */
test("an unknown country code keeps the korean page", async () => {
  const [pair] = readEnglishPosts();
  if (!pair) return;
  const korean = `/posts/${encodeURIComponent(pair.koSlug)}`;

  for (const code of ["XX", "T1", ""]) {
    const response = await render(korean, visitor({ "cf-ipcountry": code, "accept-language": "en-US,en;q=0.9" }));
    assert.equal(response.status, 200, `redirected on an unknown country code: ${code || "(empty)"}`);
  }

  // 국가 헤더가 아예 없는 경우도 같다.
  const noHeader = await render(korean, visitor({ "accept-language": "en-US,en;q=0.9" }));
  assert.equal(noHeader.status, 200);
});

/** 언어를 직접 고르면 쿠키로 남고, 주소에서 파라미터는 지워진다. */
test("the language switch remembers the choice", async () => {
  const response = await render("/en?lang=en", visitor(FROM_KOREA));
  assert.equal(response.status, 302);

  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/en");
  assert.equal(location.search, "");
  assert.match(response.headers.get("set-cookie") ?? "", /lang=en/);

  // 두 지면 모두 상대 언어로 가는 링크를 머리에 세운다.
  const ko = await (await render("/")).text();
  assert.match(ko, /<a [^>]*href="\/en\?lang=en"[^>]*class="lang-switch"/);
  const en = await (await render("/en")).text();
  assert.match(en, /<a [^>]*href="\/\?lang=ko"[^>]*class="lang-switch"/);
});

/** 피드도 언어마다 하나씩 선다. 리더가 두 언어를 섞어 받지 않도록. */
test("each locale publishes its own feed", async () => {
  const response = await render("/en/rss.xml");
  assert.equal(response.status, 200);
  const xml = await response.text();

  assert.match(xml, /<language>en<\/language>/);
  assert.match(xml, /<atom:link href="https:\/\/blog\.pistamond\.dev\/en\/rss\.xml" rel="self"/);
  const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)];
  assert.equal(items.length, readEnglishPosts().length);
  for (const [item] of items) assert.match(item, /<link>https:\/\/blog\.pistamond\.dev\/en\/posts\//);

  // 사이트맵은 두 언어를 한 곳에 담는다.
  const sitemap = await (await render("/sitemap.xml")).text();
  if (readEnglishPosts().length > 0) {
    assert.match(sitemap, /<loc>https:\/\/blog\.pistamond\.dev\/en<\/loc>/);
    assert.match(sitemap, /hreflang="en"/);
  }
});
