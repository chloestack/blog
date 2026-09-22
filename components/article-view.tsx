import Link from "next/link";
import { MermaidDiagrams } from "@/components/mermaid-diagrams";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { STRINGS, localePrefix } from "@/lib/i18n";
import { getRelatedPosts, getSeriesPosts, hasDiagrams, postHref, renderMarkdown, toneFor, type Post } from "@/lib/posts";

export function ArticleView({ post }: { post: Post }) {
  const locale = post.locale;
  const strings = STRINGS[locale];
  // 한국어는 접두어가 없어 "/"가 되고, 영문은 "/en"이다. 뒤에 슬래시를 붙이면 한 번 더 튕긴다.
  const home = localePrefix(locale) || "/";
  const list = `${localePrefix(locale)}/#articles`;
  const tone = toneFor(post.category);
  const date = post.date.replaceAll("-", ".");
  const time = post.publishedAt.slice(11, 16);
  const related = getRelatedPosts(post);
  const series = getSeriesPosts(post.series, locale);

  return (
    <main>
      <SiteHeader locale={locale} homeHref={home} />

      <div className="wrap">
        <article className="article">
          <div className="article-head">
            <Link className="back-link" href={list}>{strings.backToList}</Link>
            <div className="label-row"><span className={`tag ${tone}`}>{post.category.toUpperCase()}</span><span className="meta">{date} {time}</span></div>
            <h1>{post.title}</h1>
            {post.excerpt ? <p className="lede">{post.excerpt}</p> : null}
          </div>

          {series.length > 1 ? (
            <nav className="series-nav" aria-label={`${strings.seriesBadge}: ${post.series}`}>
              <p className="series-nav-head"><span className="series-badge">{strings.seriesBadge}</span>{post.series}</p>
              <ol className="series-nav-list">
                {series.map((item) => (
                  <li key={item.slug} className={item.slug === post.slug ? "is-current" : undefined}>
                    <span className="series-nav-num">{item.seriesOrder}</span>
                    {item.slug === post.slug ? (
                      <span className="series-nav-name" aria-current="true">{item.title}</span>
                    ) : (
                      <Link className="series-nav-name" href={postHref(item.slug, locale)}>{item.title}</Link>
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

        <SiteFooter locale={locale} homeHref={home} backHref={list} backLabel={strings.backToListFooter} />
      </div>
    </main>
  );
}
