import Link from "next/link";

/** 세 페이지가 같은 푸터를 쓰므로 한 곳에서만 고친다. */
export function SiteFooter({ homeHref, backHref, backLabel }: { homeHref: string; backHref: string; backLabel: string }) {
  return (
    <footer>
      <div className="footer-top">
        <section className="footer-about">
          <h2 className="footer-title">About</h2>
          <p>Java/Spring 기반 백엔드 개발과 AI/RAG, 아키텍처, 개발 도구에 대한 실무 경험을 공유하고 새로운 기술을 탐구합니다.</p>
        </section>
        <section className="footer-contact">
          <h2 className="footer-title">Contact · 연락처</h2>
          <p><a href="mailto:contact@pistamond.dev">contact@pistamond.dev</a></p>
        </section>
      </div>

      <div className="footer-bottom">
        <Link className="wordmark footer-mark" href={homeHref}><span className="mark">P</span><span>blog.pistamond</span></Link>
        <p>© 2026 pistamond</p>
        <Link href="/privacy">개인정보처리방침</Link>
        <Link href={backHref}>{backLabel}</Link>
      </div>
    </footer>
  );
}
