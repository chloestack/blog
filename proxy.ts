import { NextResponse, type NextRequest } from "next/server";
import { localeChoice, localeRedirect } from "@/lib/geo";
import { LOCALE_COOKIE } from "@/lib/i18n";

/** 목록과 글 주소에서만 돈다. API·정적 파일·사이트맵은 건드리지 않는다. */
export const config = {
  matcher: ["/", "/posts/:slug*", "/en", "/en/posts/:slug*"],
};

const YEAR = 60 * 60 * 24 * 365;

export default function proxy(request: NextRequest) {
  const url = request.nextUrl;

  // 언어 전환 링크(`?lang=ko`)를 쿠키로 옮기고 파라미터 없는 주소로 다시 보낸다.
  const chosen = localeChoice(url.searchParams.get("lang"));
  if (chosen) {
    const clean = new URL(url);
    clean.searchParams.delete("lang");
    const response = NextResponse.redirect(clean, 302);
    response.cookies.set(LOCALE_COOKIE, chosen, { path: "/", maxAge: YEAR, sameSite: "lax" });
    return response;
  }

  const target = localeRedirect({
    pathname: url.pathname,
    // Vercel과 Cloudflare가 각자 다른 헤더로 접속 국가를 알려 준다.
    country: request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry"),
    acceptLanguage: request.headers.get("accept-language"),
    userAgent: request.headers.get("user-agent"),
    cookie: request.cookies.get(LOCALE_COOKIE)?.value ?? null,
    // 사이트 안에서 눌러 온 이동인지 본다. 읽는 도중에 지면이 바뀌지 않게 한다.
    referer: request.headers.get("referer"),
    host: request.headers.get("host") ?? url.host,
  });
  if (!target) return NextResponse.next();

  const destination = new URL(target, url);
  destination.search = url.search;
  const response = NextResponse.redirect(destination, 302);
  // 이 응답은 방문자마다 다르다. 중간 캐시가 한 사람의 결과를 남에게 주면 안 된다.
  response.headers.set("cache-control", "no-store");
  response.headers.set("vary", "accept-language, cookie, referer");
  return response;
}
