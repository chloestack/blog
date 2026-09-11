import { PostBrowser } from "@/components/post-browser";
import { SiteFooter } from "@/components/site-footer";
import { getAllPosts, toCard } from "@/lib/posts";

export default function Home() {
  const posts = getAllPosts().map(toCard);

  return (
    <main>
      <header className="site-header">
        <div className="wrap wide header-inner">
          <a className="wordmark" href="#top" aria-label="blog.pistamond 홈"><span className="mark">P</span><span>blog.pistamond</span></a>
          <nav aria-label="주요 메뉴"><a href="#articles">글</a></nav>
        </div>
      </header>

      <div className="wrap wide" id="top">
        <PostBrowser posts={posts} />

        <SiteFooter homeHref="#top" backHref="#top" backLabel="맨 위로 ↑" />
      </div>
    </main>
  );
}
