import Link from "next/link";
import { STRINGS, type Locale } from "@/lib/i18n";

/**
 * 네 페이지가 같은 머리를 쓴다. 언어 전환 링크는 두지 않는다 — 지면은 접속
 * 지역으로 정하고, 다른 언어는 `?lang=` 파라미터로만 확인한다.
 */
export function SiteHeader({
  locale,
  homeHref,
  wide = false,
}: {
  locale: Locale;
  homeHref: string;
  wide?: boolean;
}) {
  const strings = STRINGS[locale];

  return (
    <header className="site-header">
      <div className={wide ? "wrap wide header-inner" : "wrap header-inner"}>
        <Link className="wordmark" href={homeHref} aria-label={strings.homeAria}><span className="mark">P</span><span>blog.pistamond</span></Link>
      </div>
    </header>
  );
}
