import Link from "next/link";
import { STRINGS, type Locale } from "@/lib/i18n";

/**
 * 네 페이지가 같은 머리를 쓴다. 오른쪽의 언어 링크는 짝이 되는 글로 가고,
 * 번역이 없으면 그 언어의 목록으로 간다.
 */
export function SiteHeader({
  locale,
  homeHref,
  switchTo,
  wide = false,
}: {
  locale: Locale;
  homeHref: string;
  switchTo: string;
  wide?: boolean;
}) {
  const strings = STRINGS[locale];

  return (
    <header className="site-header">
      <div className={wide ? "wrap wide header-inner" : "wrap header-inner"}>
        <Link className="wordmark" href={homeHref} aria-label={strings.homeAria}><span className="mark">P</span><span>blog.pistamond</span></Link>
        <nav>
          <Link className="lang-switch" href={switchTo} aria-label={strings.switchToAria} hrefLang={locale === "ko" ? "en" : "ko"}>
            {strings.switchTo}
          </Link>
        </nav>
      </div>
    </header>
  );
}
