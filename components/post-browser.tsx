"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { PostCard } from "@/lib/posts";

const ALL = "전체";

function formatDate(value: string): string {
  return value.replaceAll("-", ".");
}

/** 목록과 주제 그리드는 같은 필터를 공유해야 하므로 한 컴포넌트가 함께 들고 있는다. */
export function PostBrowser({ posts }: { posts: PostCard[] }) {
  const [active, setActive] = useState(ALL);

  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) counts.set(post.category, (counts.get(post.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [posts]);

  const visible = active === ALL ? posts : posts.filter((post) => post.category === active);

  // 같은 주제를 다시 누르면 필터가 풀리는 편이 토글로 자연스럽다.
  const toggle = (topic: string) => setActive((current) => (current === topic ? ALL : topic));

  return (
    <>
      <section className="articles" id="articles" aria-labelledby="latest-title">
        <div className="section-heading"><h2 id="latest-title">최근 기록</h2></div>

        {topics.length > 0 ? (
          <div className="filter-bar" role="group" aria-label="주제로 거르기">
            {[ALL, ...topics.map(([topic]) => topic)].map((topic) => (
              <button
                key={topic}
                type="button"
                className={topic === active ? "is-active" : undefined}
                aria-pressed={topic === active}
                onClick={() => setActive(topic)}
              >
                {topic}
                <span>{topic === ALL ? posts.length : topics.find(([name]) => name === topic)![1]}</span>
              </button>
            ))}
          </div>
        ) : null}

        {posts.length === 0 ? (
          <p className="empty-note">아직 공개된 글이 없습니다.</p>
        ) : visible.length === 0 ? (
          <p className="empty-note">{active} 주제의 글이 아직 없습니다.</p>
        ) : (
          <div className="post-list">
            {visible.map((post, index) => (
              <article className={`post-row ${post.tone}`} key={post.slug}>
                <div className="post-number">{String(index + 1).padStart(2, "0")}</div>
                <div className="post-body">
                  <div className="label-row"><span className={`tag ${post.tone}`}>{post.category.toUpperCase()}</span><span className="meta">{formatDate(post.date)}</span></div>
                  <h3><Link href={post.href}>{post.title}</Link></h3>
                  {post.excerpt ? <p>{post.excerpt}</p> : null}
                </div>
                <div className="post-time"><span>{post.minutes}</span><span className="arrow" aria-hidden="true">↗</span></div>
              </article>
            ))}
          </div>
        )}
      </section>

      {topics.length > 0 ? (
        <section className="topics" id="topics" aria-labelledby="topics-title">
          <div className="section-heading compact"><h2 id="topics-title">주제별 찾아보기</h2></div>
          <div className="topic-grid">
            {topics.map(([topic, count]) => (
              <a
                key={topic}
                href="#articles"
                className={topic === active ? "is-active" : undefined}
                aria-current={topic === active ? "true" : undefined}
                onClick={() => toggle(topic)}
              >
                <span>{topic}</span>
                <span>{String(count).padStart(2, "0")}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
