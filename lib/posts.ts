import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Marked } from "marked";

export type Post = {
  slug: string;
  file: string;
  title: string;
  date: string;
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

/** 한글 산문 기준 분당 약 500자. 코드 블록은 읽는 속도가 달라 절반만 센다. */
export function readingTime(body: string): string {
  const prose = body.replace(/```[\s\S]*?```/g, "");
  const code = body.length - prose.length;
  const minutes = Math.max(1, Math.round((prose.length + code / 2) / 500));
  return `${minutes}분`;
}

function readPostFile(file: string): Post | null {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), "utf8");
  const { data, content } = matter(raw);
  const title = typeof data.title === "string" ? data.title : "";
  if (!title) return null;

  const slug = file.replace(/\.md$/, "");
  const body = content.trim();
  return {
    slug,
    file,
    title,
    date: typeof data.date === "string" ? data.date : slug.slice(0, 10),
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
    // 같은 날 올라온 글끼리도 순서가 흔들리지 않도록 slug로 한 번 더 가른다.
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

export function getPostBySlug(slug: string): Post | null {
  return getAllPosts().find((post) => post.slug === slug) ?? null;
}

// marked 인스턴스를 매번 만들면 확장 등록 비용이 반복된다. 모듈 스코프에 하나만 둔다.
const marked = new Marked({ gfm: true, breaks: false });

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
  category: string;
  excerpt: string;
  tone: string;
  minutes: string;
};

export function toCard(post: Post): PostCard {
  return {
    slug: post.slug,
    href: postHref(post.slug),
    title: post.title,
    date: post.date,
    category: post.category,
    excerpt: post.excerpt,
    tone: toneFor(post.category),
    minutes: readingTime(post.body),
  };
}
