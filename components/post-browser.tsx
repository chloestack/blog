"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { STRINGS, type Locale } from "@/lib/i18n";
import type { PostCard } from "@/lib/posts";
import { VisitCounter } from "@/components/visit-counter";

/** 카테고리 이름이 아니라 "전부"를 가리키는 표식. 지면에 찍히는 말은 locale에서 온다. */
const ALL = "\u0000all";
/** 도구 이야기는 주제라기보다 곁가지라 개수와 상관없이 레일 맨 아래에 둔다. */
const PINNED_LAST = "Tools";

/** 카테고리 필터인지 시리즈 필터인지 구분한다. 전체는 category + ALL로 둔다. */
type Selection = { kind: "category" | "series"; name: string };

function formatDate(value: string): string {
  return value.replaceAll("-", ".");
}

/** 왼쪽 카테고리 레일과 목록이 같은 필터를 공유하므로 한 컴포넌트가 함께 들고 있는다. */
export function PostBrowser({ posts, locale }: { posts: PostCard[]; locale: Locale }) {
  const [active, setActive] = useState<Selection>({ kind: "category", name: ALL });
  const strings = STRINGS[locale];
  const labelOf = (name: string) => (name === ALL ? strings.all : name);

  const topics = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) counts.set(post.category, (counts.get(post.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => {
      if ((a[0] === PINNED_LAST) !== (b[0] === PINNED_LAST)) return a[0] === PINNED_LAST ? 1 : -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
  }, [posts]);

  // 시리즈는 목록 순서(발행 시각 내림차순)대로 처음 나온 것을 먼저 둔다 — 최근 시리즈가 위로.
  const seriesList = useMemo(() => {
    const counts = new Map<string, number>();
    for (const post of posts) {
      if (!post.series) continue;
      counts.set(post.series, (counts.get(post.series) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [posts]);

  const visible = useMemo(() => {
    if (active.kind === "series") {
      // 시리즈는 읽는 순서(seriesOrder 오름차순)로 보여준다. 목록의 시각순과 다르다.
      return posts
        .filter((post) => post.series === active.name)
        .sort((a, b) => a.seriesOrder - b.seriesOrder);
    }
    if (active.name === ALL) return posts;
    return posts.filter((post) => post.category === active.name);
  }, [posts, active]);

  const isActive = (sel: Selection) => active.kind === sel.kind && active.name === sel.name;
  const inSeriesView = active.kind === "series";

  return (
    <section className="articles" id="articles" aria-label={strings.listAria}>
      <div className={topics.length > 0 ? "articles-layout" : "articles-layout no-rail"}>
        {topics.length > 0 ? (
          <aside className="category-rail" aria-labelledby="category-title">
            <h3 className="rail-title" id="category-title">{strings.categoriesTitle}</h3>
            <div className="rail-list" role="group" aria-label={strings.categoryFilterAria}>
              {[[ALL, posts.length] as const, ...topics].map(([topic, count]) => (
                <button
                  key={topic}
                  type="button"
                  className={isActive({ kind: "category", name: topic }) ? "is-active" : undefined}
                  aria-pressed={isActive({ kind: "category", name: topic })}
                  onClick={() => setActive({ kind: "category", name: topic })}
                >
                  <span className="rail-name">{labelOf(topic)}</span>
                  <span className="rail-count">{String(count).padStart(2, "0")}</span>
                </button>
              ))}
            </div>

            {seriesList.length > 0 ? (
              <>
                <h3 className="rail-title series" id="series-title">{strings.seriesTitle}</h3>
                <div className="rail-list" role="group" aria-label={strings.seriesFilterAria}>
                  {seriesList.map(([name, count]) => (
                    <button
                      key={name}
                      type="button"
                      className={isActive({ kind: "series", name }) ? "is-active" : undefined}
                      aria-pressed={isActive({ kind: "series", name })}
                      onClick={() => setActive({ kind: "series", name })}
                    >
                      <span className="rail-name">{name}</span>
                      <span className="rail-count">{String(count).padStart(2, "0")}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </aside>
        ) : null}

        <div className="articles-main">
          <VisitCounter locale={locale} />
          {posts.length === 0 ? (
            <p className="empty-note">{strings.emptyAll}</p>
          ) : visible.length === 0 ? (
            <p className="empty-note">{strings.emptyTopic(labelOf(active.name))}</p>
          ) : (
            <>
              {inSeriesView ? (
                <p className="series-lede"><span className="series-badge">{strings.seriesBadge}</span>{strings.seriesLede(active.name, visible.length)}</p>
              ) : null}
              <div className="post-list">
                {visible.map((post) => (
                  <article className={`post-row ${post.tone}`} key={post.slug}>
                    <div className="post-body">
                      <div className="label-row">
                        {inSeriesView ? (
                          <span className="tag series-order">{strings.seriesOrderLabel(post.seriesOrder)}</span>
                        ) : (
                          <span className={`tag ${post.tone}`}>{post.category.toUpperCase()}</span>
                        )}
                        <span className="post-when"><span className="when-day">{formatDate(post.date)}</span><span className="when-clock">{post.time}</span></span>
                      </div>
                      <h3><Link href={post.href}>{post.title}</Link></h3>
                      {post.excerpt ? <p>{post.excerpt}</p> : null}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
  </section>
  );
}
