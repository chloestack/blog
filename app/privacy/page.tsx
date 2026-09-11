import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "개인정보처리방침",
  description: "blog.pistamond이 방문 통계와 광고를 위해 어떤 정보를 다루는지 정리했습니다.",
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "개인정보처리방침",
    description: "blog.pistamond이 방문 통계와 광고를 위해 어떤 정보를 다루는지 정리했습니다.",
    url: "/privacy",
    siteName: "blog.pistamond",
    locale: "ko_KR",
    type: "article",
  },
};

export default function PrivacyPage() {
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
            <Link className="back-link" href="/">← 홈으로</Link>
            <div className="label-row"><span className="meta">시행일 2026.09.01</span></div>
            <h1>개인정보처리방침</h1>
            <p className="lede">
              blog.pistamond.dev(이하 &ldquo;사이트&rdquo;)는 개발 및 기술 관련 콘텐츠를 제공하는 개인 블로그입니다. 사이트를
              이용하는 과정에서 서비스 운영, 방문 통계 분석 및 광고 제공을 위해 일부 정보가 자동으로 수집될 수 있습니다.
            </p>
          </div>

          <div className="prose">
            <h2>1. 자동으로 수집될 수 있는 정보</h2>
            <p>
              사이트 방문 시 브라우저 종류, 기기 정보, 접속 시간, 방문한 페이지, 유입 경로 등의 정보가 자동으로 기록될 수
              있습니다. 이러한 정보는 사이트 이용 현황을 파악하고 콘텐츠와 서비스 품질을 개선하기 위한 목적으로만
              사용합니다.
            </p>

            <h2>2. 쿠키</h2>
            <p>
              사이트는 방문 통계 분석, 사용자 경험 개선 및 광고 제공 등을 위해 쿠키(Cookie) 또는 이와 유사한 기술을 사용할
              수 있습니다. 쿠키는 이용자의 기기에 저장되는 작은 정보이며, 브라우저 설정을 통해 저장을 제한하거나 삭제할 수
              있습니다.
            </p>

            <h2>3. 광고</h2>
            <p>
              사이트는 운영을 위해 제3자 광고 서비스를 이용할 수 있습니다. 광고 서비스 제공자는 광고 제공, 광고 성과 측정,
              또는 이용자의 관심사에 맞는 광고 제공을 위해 쿠키 등의 기술을 사용할 수 있습니다. 사이트는 Google이 제공하는
              광고 서비스를 이용할 수 있으며, 이 경우 Google의 개인정보 보호 및 광고 관련 정책이 함께 적용됩니다.
            </p>

            <h2>4. 외부 서비스</h2>
            <p>현재 사이트가 이용하고 있는 외부 서비스는 다음과 같습니다.</p>
            <ul>
              <li><strong>네이버 애널리틱스</strong> — 방문 통계 분석. 방문 기록과 쿠키를 수집합니다.</li>
              <li><strong>Google AdSense</strong> — 광고 게재. 광고 제공과 성과 측정을 위해 쿠키를 사용할 수 있습니다.</li>
              <li><strong>Vercel</strong> — 사이트 호스팅. 요청 처리 과정에서 접속 기록이 남습니다.</li>
            </ul>
            <p>
              외부 서비스를 이용하는 과정에는 해당 서비스 제공자의 개인정보처리방침과 이용약관이 적용됩니다. 운영에 필요한
              서비스가 추가되거나 바뀌면 이 목록도 함께 갱신합니다.
            </p>

            <h2>5. 개인정보의 직접 수집</h2>
            <p>
              사이트는 회원가입 기능을 제공하지 않으며, 이름·전화번호·주소 등의 개인정보를 직접 수집하지 않습니다. 다만 문의
              과정에서 이용자가 자발적으로 보내 주신 정보는 해당 문의에 답하기 위한 목적으로만 사용합니다.
            </p>

            <h2>6. 외부 링크</h2>
            <p>
              사이트의 글에는 다른 웹사이트로 연결되는 링크가 포함될 수 있습니다. 링크를 따라간 외부 사이트에서 이루어지는
              개인정보 처리에 대해서는 해당 사이트의 개인정보처리방침이 적용됩니다.
            </p>

            <h2>7. 문의</h2>
            <p>
              이 방침이나 사이트 운영과 관련한 문의는 <a href="mailto:contact@pistamond.dev">contact@pistamond.dev</a>로
              보내 주세요.
            </p>

            <h2>8. 변경사항</h2>
            <p>
              사이트 운영 방식이나 이용하는 외부 서비스가 바뀌면 이 방침의 내용도 달라질 수 있습니다. 변경된 내용은 이
              페이지에 게시하며, 시행일을 함께 적습니다.
            </p>

            <hr />
            <p>시행일: 2026년 9월 1일</p>
          </div>
        </article>

        <SiteFooter homeHref="/" backHref="/#articles" backLabel="목록으로 ←" />
      </div>
    </main>
  );
}
