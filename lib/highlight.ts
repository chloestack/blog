/**
 * 본문 코드 블록을 서버에서 색칠한다. 브라우저 스크립트는 없다.
 *
 * Shiki(VS Code와 같은 TextMate 문법)를 동기식으로 쓴다 — marked가 동기로 돌기
 * 때문이다. 정규식 엔진은 WASM 없이 도는 JavaScript 엔진을 쓴다. Cloudflare Worker와
 * Vercel 양쪽에서 같은 결과가 나와야 한다.
 *
 * 색은 테마 파일에 박지 않고 CSS 변수로만 내보낸다. 실제 색은 app/globals.css의
 * `.code-block`에서 사이트 토큰에 맞춰 정한다.
 */
import { createCssVariablesTheme, createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import go from "shiki/langs/go.mjs";
import html from "shiki/langs/html.mjs";
import http from "shiki/langs/http.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import markdown from "shiki/langs/markdown.mjs";
import nginx from "shiki/langs/nginx.mjs";
import properties from "shiki/langs/properties.mjs";
import python from "shiki/langs/python.mjs";
import sql from "shiki/langs/sql.mjs";
import toml from "shiki/langs/toml.mjs";
import turtle from "shiki/langs/turtle.mjs";
import typescript from "shiki/langs/typescript.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";

const theme = createCssVariablesTheme({ name: "pistamond", variablePrefix: "--code-", fontStyle: true });

const highlighter = createHighlighterCoreSync({
  themes: [theme],
  langs: [bash, css, diff, dockerfile, go, html, http, ini, java, javascript, json, kotlin, markdown, nginx, properties, python, sql, toml, turtle, typescript, xml, yaml],
  engine: createJavaScriptRegexEngine(),
});

/**
 * 글에 적힌 언어 이름 → 색칠에 쓸 문법. 머리에 찍히는 이름은 글에 적힌 그대로 둔다.
 * 문법이 따로 없는 것은 가까운 문법을 빌린다.
 */
const GRAMMAR: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", mjs: "javascript", ts: "typescript",
  yml: "yaml", py: "python", kt: "kotlin", docker: "dockerfile",
  // Cassandra CQL은 SQL 문법으로 충분하다. redis.conf 같은 설정 파일은 ini로 읽는다.
  cql: "sql", conf: "ini", env: "properties",
  md: "markdown",
};

export type CodeInfo = {
  /** 글에 적힌 언어 이름(소문자). 없으면 빈 문자열. */
  lang: string;
  /** `title="..."`로 적은 파일 이름 등. 없으면 빈 문자열. */
  title: string;
};

/** 펜스 뒤의 정보 문자열(```java title="OrderService.java")을 읽는다. */
export function parseCodeInfo(info: string | undefined): CodeInfo {
  const raw = (info ?? "").trim();
  const lang = (/^[^\s{]+/.exec(raw)?.[0] ?? "").toLowerCase();
  const title = /\btitle=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(raw);
  return { lang, title: title ? (title[1] ?? title[2] ?? title[3]) : "" };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function grammarFor(lang: string): string | null {
  const name = GRAMMAR[lang] ?? lang;
  return highlighter.getLoadedLanguages().includes(name) ? name : null;
}

/**
 * 모든 코드 블록을 같은 틀에 담는다 — 위에 언어(와 파일 이름)를 적은 머리, 아래에 코드.
 * 모르는 언어나 text는 색 없이 같은 틀에 넣는다.
 */
export function renderCodeBlock(code: string, info: string | undefined): string {
  const { lang, title } = parseCodeInfo(info);
  const text = code.replace(/\n+$/, "");
  const grammar = grammarFor(lang);

  const body = grammar
    ? highlighter.codeToHtml(text, { lang: grammar, theme: "pistamond" })
    : `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`;

  const label = lang && lang !== "text" && lang !== "plaintext" ? lang : "text";
  const head =
    `<figcaption class="code-head">` +
    `<span class="code-lang">${escapeHtml(label)}</span>` +
    (title ? `<span class="code-title">${escapeHtml(title)}</span>` : "") +
    `</figcaption>`;

  return `<figure class="code-block" data-lang="${escapeHtml(label)}">${head}${body}</figure>\n`;
}
