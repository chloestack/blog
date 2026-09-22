import { PostBrowser } from "@/components/post-browser";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { STRINGS } from "@/lib/i18n";
import { getAllPosts, toCard } from "@/lib/posts";

export default function Home() {
  const posts = getAllPosts("ko").map(toCard);
  const strings = STRINGS.ko;

  return (
    <main>
      <SiteHeader locale="ko" homeHref="#top" wide />

      <div className="wrap wide" id="top">
        <PostBrowser posts={posts} locale="ko" />

        <SiteFooter locale="ko" homeHref="#top" backHref="#top" backLabel={strings.backToTop} />
      </div>
    </main>
  );
}
