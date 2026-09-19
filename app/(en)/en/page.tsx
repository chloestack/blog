import { PostBrowser } from "@/components/post-browser";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { STRINGS, switchHref } from "@/lib/i18n";
import { getAllPosts, toCard } from "@/lib/posts";

export default function EnglishHome() {
  const posts = getAllPosts("en").map(toCard);
  const strings = STRINGS.en;

  return (
    <main>
      <SiteHeader locale="en" homeHref="#top" switchTo={switchHref("en", null)} wide />

      <div className="wrap wide" id="top">
        <PostBrowser posts={posts} locale="en" />

        <SiteFooter locale="en" homeHref="#top" backHref="#top" backLabel={strings.backToTop} />
      </div>
    </main>
  );
}
