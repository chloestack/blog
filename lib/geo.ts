/**
 * 어느 언어의 지면으로 보낼지 정한다. 미들웨어(Vercel)와 Cloudflare Worker가
 * 같은 판단을 쓰도록, 요청에서 읽은 값만 받는 순수 함수로 둔다.
 *
 * 원본은 한국어다. 자동 전환은 한국어 → 영어 한 방향뿐이고, 영문 주소로 직접
 * 들어온 사람을 한국어로 되돌리지는 않는다 — 공유된 영문 링크가 열리지 않으면
 * 안 되고, 두 방향을 다 열어 두면 짝이 어긋난 글에서 리다이렉트가 맴돈다.
 */
import { isLocale, type Locale } from "@/lib/i18n";
import { POST_PAIRS } from "@/lib/post-pairs.generated";

export type LocaleRequest = {
  pathname: string;
  /** Vercel은 x-vercel-ip-country, Cloudflare는 cf-ipcountry로 알려 준다. */
  country: string | null;
  acceptLanguage: string | null;
  userAgent: string | null;
  /** lang 쿠키 값. 방문자가 직접 고른 언어. */
  cookie: string | null;
  /** Referer. 사이트 안에서 온 이동인지 보려고 쓴다. */
  referer?: string | null;
  /** 지금 요청의 host. Referer와 견줘 같은 사이트인지 가른다. */
  host?: string | null;
};

/**
 * 크롤러는 지역으로 옮기지 않는다. 구글은 미국에서 오므로 리다이렉트를 걸면
 * 한국어 글이 색인에서 밀려난다. 크롤러에게는 hreflang만 보여 주고 각 주소를
 * 있는 그대로 읽게 한다.
 */
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse|headlesschrome/i;

function isBot(userAgent: string | null): boolean {
  return userAgent !== null && BOTS.test(userAgent);
}

/**
 * Accept-Language에 한국어가 들어 있으면 한국어로 읽는 사람으로 본다.
 * 해외에 있는 한국어 사용자가 영문으로 밀려나지 않게 하는 장치다.
 */
function prefersKorean(acceptLanguage: string | null): boolean {
  if (!acceptLanguage) return false;
  return acceptLanguage
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .some((tag) => tag === "ko" || tag.startsWith("ko-"));
}

/**
 * 접속 국가를 모르는 경우는 헤더가 아예 없는 것 말고도 있다. Cloudflare는 알 수
 * 없는 주소에 XX, Tor 출구에 T1을 적어 보낸다. 이런 값을 나라 이름으로 믿으면
 * "KR이 아니다"가 되어, 한국에서 영어로 설정된 브라우저로 보는 사람이 영문으로
 * 밀려난다.
 */
const UNKNOWN_COUNTRIES = new Set(["XX", "T1"]);

function knownCountry(country: string | null): string | null {
  const code = country?.trim().toUpperCase();
  return code && !UNKNOWN_COUNTRIES.has(code) ? code : null;
}

function guessLocale(country: string | null, acceptLanguage: string | null): Locale {
  // 어디서 왔는지 모르면 원본을 보여 준다. 로컬과 테스트도 여기에 해당한다.
  const code = knownCountry(country);
  if (!code) return "ko";
  if (code === "KR") return "ko";
  if (prefersKorean(acceptLanguage)) return "ko";
  return "en";
}

/**
 * 사이트 안에서 링크를 눌러 온 이동인지 본다. 읽던 도중에 지면이 갈아엎히는 일을
 * 막으려고, 지역 추측은 처음 들어올 때만 한다 — 방문자가 직접 고른 쿠키는 이와
 * 무관하게 계속 듣는다.
 */
function isInternalNavigation(request: LocaleRequest): boolean {
  if (!request.referer || !request.host) return false;
  try {
    return new URL(request.referer).host === request.host;
  } catch {
    return false;
  }
}

/** 한국어 글 주소를 같은 글의 영문 주소로 옮긴다. 번역본이 없으면 null. */
function englishPath(pathname: string): string | null {
  if (pathname === "/") return "/en";
  const match = /^\/posts\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;

  let koSlug: string;
  try {
    koSlug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const enSlug = POST_PAIRS[koSlug];
  return enSlug ? `/en/posts/${encodeURIComponent(enSlug)}` : null;
}

/**
 * 보낼 곳이 있으면 경로를, 그대로 두어야 하면 null을 돌려준다.
 * 한국어 목록과 글 주소에서만 움직인다.
 */
export function localeRedirect(request: LocaleRequest): string | null {
  if (isBot(request.userAgent)) return null;

  const cookieLocale = request.cookie && isLocale(request.cookie) ? request.cookie : null;
  let want: Locale;
  if (cookieLocale) {
    want = cookieLocale;
  } else {
    // 첫 진입에서만 지역을 본다. 사이트 안에서 글을 넘겨 가는 중에는 건드리지 않는다.
    if (isInternalNavigation(request)) return null;
    want = guessLocale(request.country, request.acceptLanguage);
  }
  if (want !== "en") return null;

  return englishPath(request.pathname);
}

/**
 * 언어 전환 링크는 `?lang=en` 처럼 붙어 온다. 미들웨어가 이 값을 쿠키로 옮기고
 * 파라미터 없는 주소로 다시 보낸다 — 페이지는 정적인 채로 두고, 선택만 기억한다.
 */
export function localeChoice(value: string | null): Locale | null {
  return value && isLocale(value) ? value : null;
}
