/**
 * 네이버 애널리틱스(wcs) 태그.
 *
 * 루트 레이아웃이 </body> 바로 앞에서 한 번만 렌더링하므로, 새 페이지를 추가할 때
 * 이 스크립트를 따로 붙일 필요는 없다. 페이지는 app/ 아래에 만들면 되고,
 * 측정 태그는 여기서만 관리한다.
 */
const WCS_SNIPPET = `if(!wcs_add) var wcs_add = {};
wcs_add["wa"] = "2d2e2d4e62aa6e";
if(window.wcs) {
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
