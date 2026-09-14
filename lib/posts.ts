import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Marked } from "marked";

export type Post = {
  slug: string;
  file: string;
  title: string;
  /** 지면에 찍히는 날짜. YYYY-MM-DD. */
  date: string;
  /** 정렬과 메타데이터에 쓰는 발행 시각. KST 기준 ISO 8601. */
  publishedAt: string;
  category: string;
  tags: string[];
  excerpt: string;
  body: string;
};

const POSTS_DIR = path.join(process.cwd(), "content", "posts");

// 카테고리는 config 한 곳에서만 늘어나면 되도록, 톤은 순환 배정한다.
const TONES = ["teal", "blue", "clay", "plum", "olive", "rose"] as const;

export function toneFor(category: string): string {
  let hash = 0;
  for (const ch of category) hash = (hash * 31 + ch.codePointAt(0)!) % 100003;
  return TONES[hash % TONES.length];
}

/**
 * frontmatter의 `date`는 "2026-09-11" 또는 "2026-09-11 07:36" 두 가지로 들어온다.
 * 하루에 여러 편이 올라오므로 날짜만으로는 순서가 정해지지 않아, 글을 만드는 쪽에서
 * 시각까지 적는다. 따옴표를 빼먹어 YAML이 Date로 해석한 경우도 받아 준다.
 */
function readDate(value: unknown, fallback: string): { date: string; publishedAt: string } {
  const raw =
    value instanceof Date
      ? value.toISOString().replace("T", " ").slice(0, 16)
      : typeof value === "string"
        ? value.trim()
        : "";

  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(raw);
  if (!match) return { date: fallback, publishedAt: `${fallback}T00:00:00+09:00` };

  const [, date, time] = match;
  // 이 블로그의 시각은 전부 한국 시간이다. 오프셋을 붙여야 클라이언트에서 밀리지 않는다.
  return { date, publishedAt: `${date}T${time ?? "00:00"}:00+09:00` };
}

function readPostFile(file: string): Post | null {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
  const { data, content } = matter(raw);
  const title = typeof data.title === "string" ? data.title : "";
  if (!title) return null;

  const slug = file.replace(/\.md$/, "");
  const body = content.trim();
  const { date, publishedAt } = readDate(data.date, slug.slice(0, 10));
  return {
    slug,
    file,
    title,
    date,
    publishedAt,
    category: typeof data.category === "string" ? data.category : "GENERAL",
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    excerpt: typeof data.excerpt === "string" ? data.excerpt : "",
    body,
  };
}

/**
 * 저장소에 있는 글은 전부 공개된 글이다. 비공개 상태는 두지 않는다 —
 * 커밋되어 배포에 포함되는 순간이 곧 공개 시점이다.
 */
export function getAllPosts(): Post[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map(readPostFile)
    .filter((post): post is Post => post !== null)
    // 발행 시각 내림차순. 같은 분에 올라온 글이 남으면 slug로 마지막을 가른다.
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
}

export function getPostBySlug(slug: string): Post | null {
  return getAllPosts().find((post) => post.slug === slug) ?? null;
}

/**
 * 글 끝에서 다음에 읽을 것을 고른다. 같은 카테고리의 최신 글이 먼저고, 그것만으로
 * 모자라면 다른 카테고리의 최신 글로 채운다 — 글이 몇 편 없는 동안에도 자리가
 * 비지 않도록. 목록 정렬(날짜 내림차순)을 그대로 물려받는다.
 */
export function getRelatedPosts(post: Post, limit = 4): PostCard[] {
  const others = getAllPosts().filter((candidate) => candidate.slug !== post.slug);
  const sameCategory = others.filter((candidate) => candidate.category === post.category);
  const fill = others.filter((candidate) => candidate.category !== post.category);
  return [...sameCategory, ...fill].slice(0, limit).map(toCard);
}

const DIAGRAMS_DIR = path.join(process.cwd(), "content", "diagrams");

/**
 * ```diagram 블록에는 content/diagrams 아래 HTML 파일 이름(확장자 없이)만 적는다.
 * 파일은 diagram-design 스킬이 만든 단독 HTML이고, 그 안의 <svg>만 본문에 그대로 넣는다.
 * 브라우저 스크립트 없이 서버에서 끝나며, 글꼴은 본문과 같은 웹 폰트를 물려받는다.
 * 파일이 없거나 <svg>가 없으면 빌드를 멈춘다 — 빈 그림으로 배포되는 것보다 낫다.
 */
function readDiagramSvg(name: string): string {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(name)) throw new Error(`도식 이름이 올바르지 않습니다: ${name}`);
  const html = fs.readFileSync(path.join(DIAGRAMS_DIR, `${name}.html`), "utf8");
  const svg = /<svg\b[\s\S]*<\/svg>/.exec(html)?.[0];
  if (!svg) throw new Error(`도식 파일에 <svg>가 없습니다: ${name}`);
  return svg;
}

// marked 인스턴스를 매번 만들면 확장 등록 비용이 반복된다. 모듈 스코프에 하나만 둔다.
const marked = new Marked({ gfm: true, breaks: false });

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

marked.use({
  tokenizer: {
    // GFM은 물결표 하나(~text~)도 취소선으로 읽는다. 한국어 글은 "10~20%"처럼
    // 범위를 물결표로 쓰므로 한 문단에 두 번 나오면 그 사이가 통째로 그어진다.
    // 취소선은 ~~text~~ 만 인정하고, 나머지는 undefined를 돌려 글자로 남긴다.
    del(src) {
      return src.startsWith("~~") ? false : undefined;
    },
  },
  renderer: {
    // mermaid 블록은 서버에서는 원문을 담아 두고, 브라우저에서 그림으로 바꾼다
    // (components/mermaid-diagrams.tsx). 스크립트가 돌지 않아도 원문은 읽힌다.
    code({ text, lang }) {
      const kind = lang?.trim();
      if (kind === "diagram") return `<figure class="diagram diagram-svg">${readDiagramSvg(text.trim())}</figure>\n`;
      if (kind !== "mermaid") return false;
      return `<figure class="diagram"><pre class="mermaid">${escapeHtml(text)}</pre></figure>\n`;
    },
  },
});

export function hasDiagrams(body: string): boolean {
  return /^\s*```\s*mermaid\b/m.test(body);
}

export function renderMarkdown(body: string): string {
  return marked.parse(body, { async: false });
}

export function postHref(slug: string): string {
  return `/posts/${encodeURIComponent(slug)}`;
}

/**
 * 목록/필터는 클라이언트에서 돌아간다. 본문까지 넘기면 RSC 페이로드가 글 전체만큼
 * 커지므로, 카드에 실제로 그려지는 값만 서버에서 미리 계산해 내려보낸다.
 */
export type PostCard = {
  slug: string;
  href: string;
  title: string;
  date: string;
  /** HH:MM. 목록에서 날짜 아래에 함께 찍는다. */
  time: string;
  category: string;
  excerpt: string;
  tone: string;
};

export function toCard(post: Post): PostCard {
  return {
    slug: post.slug,
    href: postHref(post.slug),
    title: post.title,
    date: post.date,
    time: post.publishedAt.slice(11, 16),
    category: post.category,
    excerpt: post.excerpt,
    tone: toneFor(post.category),
  };
}
