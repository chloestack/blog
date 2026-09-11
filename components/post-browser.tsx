"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PostCard } from "@/lib/posts";

const ALL = "전체";
/** 도구 이야기는 주제라기보다 곁가지라 개수와 상관없이 레일 맨 아래에 둔다. */
const PINNED_LAST = "Tools";

function formatDate(value: string): string {
  return value.replaceAll("-", ".");
}

/** 왼쪽 카테고리 레일과 목록이 같은 필터를 공유하므로 한 컴포넌트가 함께 들고 있는다. */
export function PostBrowser({ posts }: { posts: PostCard[] }) {
  const [active, setActive] = useState(ALL);

  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) counts.set(post.category, (counts.get(post.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => {
      if ((a[0] === PINNED_LAST) !== (b[0] === PINNED_LAST)) return a[0] === PINNED_LAST ? 1 : -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }, [posts]);

  const visible = active === ALL ? posts : posts.filter((post) => post.category === active);

  return (
    <section className="articles" id="articles" aria-label="글 목록">
      <div className={topics.length > 0 ? "articles-layout" : "articles-layout no-rail"}>
        {topics.length > 0 ? (
          <aside className="category-rail" aria-labelledby="category-title">
            <h3 className="rail-title" id="category-title">카테고리</h3>
            <div className="rail-list" role="group" aria-label="카테고리로 거르기">
              {[[ALL, posts.length] as const, ...topics].map(([topic, count]) => (
                <button
                  key={topic}
                  type="button"
                  className={topic === active ? "is-active" : undefined}
                  aria-pressed={topic === active}
                  onClick={() => setActive(topic)}
                >
                  <span className="rail-name">{topic}</span>
                  <span className="rail-count">{String(count).padStart(2, "0")}</span>
                </button>
              ))}
            </div>
          </aside>
        ) : null}

        <div className="articles-main">
          {posts.length === 0 ? (
            <p className="empty-note">아직 공개된 글이 없습니다.</p>
          ) : visible.length === 0 ? (
            <p className="empty-note">{active} 주제의 글이 아직 없습니다.</p>
          ) : (
            <div className="post-list">
              {visible.map((post) => (
                <article className={`post-row ${post.tone}`} key={post.slug}>
                  <div className="post-when">
                    <span className="when-day">{formatDate(post.date)}</span>
                    <span className="when-clock">{post.time}</span>
                  </div>
                  <div className="post-body">
                    <div className="label-row"><span className={`tag ${post.tone}`}>{post.category.toUpperCase()}</span></div>
                    <h3><Link href={post.href}>{post.title}</Link></h3>
                    {post.excerpt ? <p>{post.excerpt}</p> : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
  </section>
  );
}
