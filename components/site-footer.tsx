import Link from "next/link";
import { VisitBeacon } from "@/components/visit-counter";
import { STRINGS, type Locale } from "@/lib/i18n";

/** 네 페이지가 같은 푸터를 쓰므로 한 곳에서만 고친다. */
export function SiteFooter({
  locale,
  homeHref,
  backHref,
  backLabel,
}: {
  locale: Locale;
  homeHref: string;
  backHref: string;
  backLabel: string;
}) {
  const strings = STRINGS[locale];

  return (
    <footer>
      <div className="footer-top">
        <section className="footer-about">
          <h2 className="footer-title">{strings.aboutTitle}</h2>
          <p>{strings.aboutCopy}</p>
        </section>
        <section className="footer-contact">
          <h2 className="footer-title">{strings.contactTitle}</h2>
          <p><a href="mailto:contact@pistamond.dev">contact@pistamond.dev</a></p>
        </section>
      </div>

      <VisitBeacon />
      <div className="footer-bottom">
        <Link className="wordmark footer-mark" href={homeHref}><span className="mark">P</span><span>blog.pistamond</span></Link>
        <p>© 2026 pistamond</p>
        {/* 개인정보처리방침은 한국어 원문 한 벌만 둔다. 영문 지면에서도 같은 문서를 가리킨다. */}
        <Link href="/privacy">{strings.privacy}</Link>
        <Link href={backHref}>{backLabel}</Link>
      </div>
    </footer>
  );
}
