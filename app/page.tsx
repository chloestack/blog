import { PostBrowser } from "@/components/post-browser";
import { getAllPosts, toCard } from "@/lib/posts";

export default function Home() {
  const posts = getAllPosts().map(toCard);

  return (
    <main>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="wordmark" href="#top" aria-label="blog.pistamond 홈"><span className="mark">P</span><span>blog.pistamond</span></a>
          <nav aria-label="주요 메뉴"><a href="#articles">글</a><a href="#topics">주제</a></nav>
        </div>
      </header>

      <div className="wrap" id="top">
        <PostBrowser posts={posts} />

        <footer>
          <a className="wordmark footer-mark" href="#top"><span className="mark">P</span><span>blog.pistamond</span></a>
          <p>© 2026 pistamond</p><a href="#top">맨 위로 ↑</a>
        </footer>
      </div>
    </main>
  );
}
