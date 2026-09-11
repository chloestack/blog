/**
 * Google AdSense.
 *
 * 루트 레이아웃이 한 번만 렌더링한다 — 측정 태그와 같은 규칙이라, 새 페이지를
 * 추가할 때 이 스크립트를 따로 붙일 필요는 없다. app/ 아래에 페이지만 만들면 된다.
 *
 * 소유권 확인용 <meta name="google-adsense-account">는 app/layout.tsx의 metadata가
 * 내보내고, 광고를 실제로 받아 오는 것은 아래 로더다. 광고 단위를 지면에 직접
 * 심지 않았으므로 어디에 얼마나 붙일지는 애드센스 쪽 자동 광고 설정이 정한다.
 */
export const ADSENSE_CLIENT = "ca-pub-3822322592120078";

export function AdSense() {
  // async 로더라 React가 <head>로 끌어올린다. 구글이 요구하는 자리와 같다.
  return (
    <script
      async
      src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
      crossOrigin="anonymous"
    />
  );
}
