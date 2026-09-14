import Link from "next/link";
import { MermaidDiagrams } from "@/components/mermaid-diagrams";
import { SiteFooter } from "@/components/site-footer";
import { getRelatedPosts, getSeriesPosts, hasDiagrams, postHref, renderMarkdown, toneFor, type Post } from "@/lib/posts";

export function ArticleView({ post }: { post: Post }) {
  const tone = toneFor(post.category);
  const date = post.date.replaceAll("-", ".");
  const time = post.publishedAt.slice(11, 16);
  const related = getRelatedPosts(post);
  const series = getSeriesPosts(post.series);

  return (
    <main>
      <header className="site-header">
        <div className="wrap header-inner">
          <Link className="wordmark" href="/" aria-label="blog.pistamond 홈"><span className="mark">P</span><span>blog.pistamond</span></Link>
        </div>
      </header>

      <div className="wrap">
        <article className="article">
          <div className="article-head">
            <Link className="back-link" href="/#articles">← 목록으로</Link>
            <div className="label-row"><span className={`tag ${tone}`}>{post.category.toUpperCase()}</span><span className="meta">{date} {time}</span></div>
            <h1>{post.title}</h1>
            {post.excerpt ? <p className="lede">{post.excerpt}</p> : null}
          </div>

          {series.length > 1 ? (
            <nav className="series-nav" aria-label={`시리즈: ${post.series}`}>
              <p className="series-nav-head"><span className="series-badge">시리즈</span>{post.series}</p>
              <ol className="series-nav-list">
                {series.map((item) => (
                  <li key={item.slug} className={item.slug === post.slug ? "is-current" : undefined}>
                    <span className="series-nav-num">{item.seriesOrder}</span>
                    {item.slug === post.slug ? (
                      <span className="series-nav-name" aria-current="true">{item.title}</span>
                    ) : (
                      <Link className="series-nav-name" href={postHref(item.slug)}>{item.title}</Link>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          ) : null}

          <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(post.body) }} />
          {hasDiagrams(post.body) ? <MermaidDiagrams /> : null}

          {post.tags.length > 0 ? (
            <div className="article-tags">{post.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
          ) : null}
        </article>

        {related.length > 0 ? (
          <aside className="related" aria-labelledby="related-title">
            <h2 className="related-title" id="related-title">관련 글</h2>
            <ul className="related-list">
              {related.map((item) => (
                <li key={item.slug}>
                  <Link href={item.href}>
                    <span className="label-row"><span className={`tag ${item.tone}`}>{item.category.toUpperCase()}</span><span className="meta">{item.date.replaceAll("-", ".")}</span></span>
                    <span className="related-name">{item.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <SiteFooter homeHref="/" backHref="/#articles" backLabel="목록으로 ←" />
      </div>
    </main>
  );
}
