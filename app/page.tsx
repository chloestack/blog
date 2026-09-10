import Link from "next/link";
import { categoryCounts, getAllPosts, postHref, readingTime, toneFor } from "@/lib/posts";

function formatDate(value: string): string {
  return value.replaceAll("-", ".");
}

export default function Home() {
  const posts = getAllPosts();
  const topics = categoryCounts(posts);

  return (
    <main>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="wordmark" href="#top" aria-label="pistamond.log 홈"><span className="mark">P</span><span>pistamond.log</span></a>
          <nav aria-label="주요 메뉴"><a href="#articles">글</a><a href="#topics">주제</a></nav>
        </div>
      </header>

      <div className="wrap" id="top">
        <section className="masthead">
          <h1>pistamond.log</h1>
        </section>

        <section className="articles" id="articles" aria-labelledby="latest-title">
          <div className="section-heading"><h2 id="latest-title">최근 기록</h2></div>
          {posts.length === 0 ? (
            <p className="empty-note">아직 공개된 글이 없습니다.</p>
          ) : (
            <div className="post-list">
              {posts.map((post, index) => {
                const tone = toneFor(post.category);
                return (
                  <article className={`post-row ${tone}`} key={post.slug}>
                    <div className="post-number">{String(index + 1).padStart(2, "0")}</div>
                    <div className="post-body">
                      <div className="label-row"><span className={`tag ${tone}`}>{post.category.toUpperCase()}</span><span className="meta">{formatDate(post.date)}</span></div>
                      <h3><Link href={postHref(post.slug)}>{post.title}</Link></h3>
                      {post.excerpt ? <p>{post.excerpt}</p> : null}
                    </div>
                    <div className="post-time"><span>{readingTime(post.body)}</span><span className="arrow" aria-hidden="true">↗</span></div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {topics.length > 0 ? (
          <section className="topics" id="topics" aria-labelledby="topics-title">
            <div className="section-heading compact"><h2 id="topics-title">주제별 찾아보기</h2></div>
            <div className="topic-grid">{topics.map(([topic, count]) => <a href="#articles" key={topic}><span>{topic}</span><span>{count}</span></a>)}</div>
          </section>
        ) : null}

        <footer>
          <a className="wordmark footer-mark" href="#top"><span className="mark">P</span><span>pistamond.log</span></a>
          <p>© 2026 pistamond</p><a href="#top">맨 위로 ↑</a>
        </footer>
      </div>
    </main>
  );
}
