/**
 * 이 블로그는 한국어가 원본이고 영어가 번역본이다. 한국어는 주소 그대로(`/`),
 * 영어는 `/en` 아래에 선다. 지면에 찍히는 문구는 전부 이 파일에 모아 두고,
 * 컴포넌트는 locale만 받아 골라 쓴다 — 두 언어가 따로 낡지 않도록.
 */

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const SITE = "https://blog.pistamond.dev";

/** 언어 선택을 기억하는 쿠키. 있으면 지역에 따른 리다이렉트를 하지 않는다. */
export const LOCALE_COOKIE = "lang";

/** 주소 앞에 붙는 조각. 한국어는 원본이라 접두어가 없다. */
export function localePrefix(locale: Locale): string {
  return locale === "ko" ? "" : `/${locale}`;
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** 검색 결과와 공유 카드에 나가는 사이트 설명. README가 이 블로그를 설명하는 말과 같다. */
export const SITE_DESCRIPTION: Record<Locale, string> = {
  ko: "소프트웨어의 구조와 인터페이스, 운영에서 내린 판단을 기록하는 한국어 기술 블로그입니다. Spring·Java·아키텍처·DevOps·AI 도구를 다룹니다.",
  en: "A software engineering blog on structure, interfaces, and the judgment calls behind running systems. Spring, Java, architecture, DevOps, and AI tooling.",
};

/** og:locale에 쓰는 표기. */
export const OG_LOCALE: Record<Locale, string> = {
  ko: "ko_KR",
  en: "en_US",
};

/** 목록과 글 페이지가 쓰는 문구. 클라이언트 컴포넌트로 그대로 넘어가므로 값만 담는다. */
export type Strings = {
  homeAria: string;
  listAria: string;
  categoriesTitle: string;
  categoryFilterAria: string;
  seriesTitle: string;
  seriesFilterAria: string;
  seriesBadge: string;
  all: string;
  /** 시리즈 목록 머리의 한 줄. */
  seriesLede: (name: string, count: number) => string;
  /** 시리즈 안의 순서 표시. */
  seriesOrderLabel: (order: number) => string;
  emptyAll: string;
  emptyTopic: (name: string) => string;
  relatedTitle: string;
  backToList: string;
  backToListFooter: string;
  backToTop: string;
  aboutTitle: string;
  aboutCopy: string;
  contactTitle: string;
  privacy: string;
  /** 방문자 수 앞에 붙는 말. 숫자는 굵게 따로 그린다. */
  visitsToday: string;
  visitsTotal: string;
  /** 숫자를 지역 표기로 찍을 때 쓰는 로케일 태그. */
  numberLocale: string;
};

export const STRINGS: Record<Locale, Strings> = {
  ko: {
    homeAria: "blog.pistamond 홈",
    listAria: "글 목록",
    categoriesTitle: "카테고리",
    categoryFilterAria: "카테고리로 거르기",
    seriesTitle: "시리즈",
    seriesFilterAria: "시리즈로 거르기",
    seriesBadge: "시리즈",
    all: "전체",
    seriesLede: (name, count) => `${name} · 총 ${count}편, 1편부터 순서대로`,
    seriesOrderLabel: (order) => `${order}편`,
    emptyAll: "아직 공개된 글이 없습니다.",
    emptyTopic: (name) => `${name} 주제의 글이 아직 없습니다.`,
    relatedTitle: "관련 글",
    backToList: "← 목록으로",
    backToListFooter: "목록으로 ←",
    backToTop: "맨 위로 ↑",
    aboutTitle: "About",
    aboutCopy:
      "Java/Spring 기반 백엔드 개발과 AI/RAG, 아키텍처, 개발 도구에 대한 실무 경험을 공유하고 새로운 기술을 탐구합니다.",
    contactTitle: "Contact · 연락처",
    privacy: "개인정보처리방침",
    visitsToday: "오늘",
    visitsTotal: "전체",
    numberLocale: "ko-KR",
  },
  en: {
    homeAria: "blog.pistamond home",
    listAria: "Posts",
    categoriesTitle: "Categories",
    categoryFilterAria: "Filter by category",
    seriesTitle: "Series",
    seriesFilterAria: "Filter by series",
    seriesBadge: "Series",
    all: "All",
    seriesLede: (name, count) => `${name} · ${count} parts, in reading order`,
    seriesOrderLabel: (order) => `Part ${order}`,
    emptyAll: "No posts yet.",
    emptyTopic: (name) => `No posts on ${name} yet.`,
    relatedTitle: "Related posts",
    backToList: "← All posts",
    backToListFooter: "All posts ←",
    backToTop: "Back to top ↑",
    aboutTitle: "About",
    aboutCopy:
      "Notes from backend work in Java and Spring, plus AI/RAG, architecture, and the tools that go with them.",
    contactTitle: "Contact",
    privacy: "Privacy policy",
    visitsToday: "Today",
    visitsTotal: "Total",
    numberLocale: "en-US",
  },
};

/** 다른 언어와 짝이 되는 주소. */
export function otherLocale(locale: Locale): Locale {
  return locale === "ko" ? "en" : "ko";
}
