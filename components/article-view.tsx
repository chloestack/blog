import Link from "next/link";
import { getRelatedPosts, readingTime, renderMarkdown, toneFor, type Post } from "@/lib/posts";

export function ArticleView({ post }: { post: Post }) {
  const tone = toneFor(post.category);
  const date = post.date.replaceAll("-", ".");
  const related = getRelatedPosts(post);

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
            <div className="label-row"><span className={`tag ${tone}`}>{post.category.toUpperCase()}</span><span className="meta">{date} · {readingTime(post.body)}</span></div>
            <h1>{post.title}</h1>
            {post.excerpt ? <p className="lede">{post.excerpt}</p> : null}
          </div>

          <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(post.body) }} />

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

        <footer>
          <Link className="wordmark footer-mark" href="/"><span className="mark">P</span><span>blog.pistamond</span></Link>
          <p>© 2026 pistamond. Built with curiosity.</p><Link href="/#articles">목록으로 ←</Link>
        </footer>
      </div>
    </main>
  );
}
