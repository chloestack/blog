/**
 * 네이버 애널리틱스(wcs) 태그.
 *
 * 루트 레이아웃이 </body> 바로 앞에서 한 번만 렌더링하므로, 새 페이지를 추가할 때
 * 이 스크립트를 따로 붙일 필요는 없다. 페이지는 app/ 아래에 만들면 되고,
 * 측정 태그는 여기서만 관리한다.
 *
 * Vercel 배포별 주소와 로컬 개발 방문은 집계하지 않도록 운영 도메인에서만 wcs_do()를 부른다.
 */
const WCS_SNIPPET = `if(!wcs_add) var wcs_add = {};
wcs_add["wa"] = "2d2e2d4e62aa6e";
if(window.wcs && location.hostname === "blog.pistamond.dev") {
wcs_do();
}`;

export function NaverAnalytics() {
  return (
    <>
      {/* 네이버가 주는 스니펫 그대로다. async로 바꾸면 아래 window.wcs 확인이
          먼저 돌아 방문이 빠질 수 있어 동기 로드를 유지한다. </body> 끝에
          있으므로 본문 렌더링을 막지도 않는다. */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script type="text/javascript" src="//wcs.pstatic.net/wcslog.js" />
      <script type="text/javascript" dangerouslySetInnerHTML={{ __html: WCS_SNIPPET }} />
    </>
  );
}

/**
 * Google 태그(gtag.js) — Google 애널리틱스 4.
 *
 * 네이버 태그와 같은 자리에서 같은 규칙으로 돈다. dataLayer와 gtag('js')는 늘 세워
 * 두되, 집계를 시작하는 config는 운영 도메인에서만 부른다.
 */
export const GA_MEASUREMENT_ID = "G-PES3ZK8G87";

const GTAG_SNIPPET = `window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
if(location.hostname === "blog.pistamond.dev") {
gtag('config', '${GA_MEASUREMENT_ID}');
}`;

export function GoogleAnalytics() {
  return (
    <>
      {/* async 로더라 React가 <head>로 끌어올린다. 구글이 권하는 자리와 같다. */}
      <script async src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`} />
      <script dangerouslySetInnerHTML={{ __html: GTAG_SNIPPET }} />
    </>
  );
}

/**
 * Vercel Web Analytics. 방문자·유입 경로 기준선을 Vercel API로 뽑으려고 둔다.
 *
 * 스크립트는 Vercel이 배포에 붙여 주는 /_vercel/insights 경로에서 받으므로 패키지를 따로
 * 들이지 않는다. 배포별 주소와 운영 주소는 Vercel이 environment로 나눠 집계한다.
 */
const VA_SNIPPET = `window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };`;

export function VercelAnalytics() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: VA_SNIPPET }} />
      <script defer src="/_vercel/insights/script.js" />
    </>
  );
}
