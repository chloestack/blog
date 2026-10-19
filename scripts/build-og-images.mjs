/**
 * 글마다 공유 카드 이미지(1200×630 PNG)를 그린다.
 *
 * 카카오톡·슬랙·X·링크드인은 og:image가 없으면 이미지 없는 작은 카드를 보여 준다.
 * 빌드 전에 public/og/<slug>.png(영문은 public/og/en/)로 그려 두고, 글 메타데이터는
 * 파일이 있을 때만 그 주소를 og:image로 내보낸다(`lib/metadata.ts`).
 *
 * 한글 글꼴(Gothic A1)은 저장소에 두기엔 크다. 모든 제목에 쓰인 글자만 담은 부분 글꼴을
 * Google Fonts에서 한 번 받아 쓴다. 받지 못하면 경고만 남기고 이미지 없이 빌드를
 * 계속한다 — 공유 카드가 작아질 뿐 글은 그대로 선다.
 *
 * public/og/는 빌드 산출물이라 커밋하지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { ImageResponse } from "next/dist/compiled/@vercel/og/index.node.js";

const root = path.join(import.meta.dirname, "..");
const postsRoot = path.join(root, "content", "posts");
const outRoot = path.join(root, "public", "og");

// 사이트와 같은 색. app/globals.css의 :root 값을 옮겨 왔다.
const C = { paper: "#e6ebed", surface: "#f8fafb", ink: "#122127", ink2: "#3f545c", ink3: "#6c8188", line: "#c3d0d4", accent: "#0d5763", accentSoft: "#d4e7ea" };
const WORDMARK = "blog.pistamond";

function readPosts(locale) {
  const dir = locale === "ko" ? postsRoot : path.join(postsRoot, locale);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(dir, file), "utf8"));
      const raw = data.date instanceof Date ? data.date.toISOString() : String(data.date ?? file.slice(0, 10));
      return {
        locale,
        slug: file.replace(/\.md$/, ""),
        title: typeof data.title === "string" ? data.title : "",
        category: typeof data.category === "string" ? data.category : "",
        date: raw.slice(0, 10).replaceAll("-", "."),
      };
    })
    .filter((post) => post.title);
}

/** text에 쓰인 글자만 담은 TTF. 오래된 브라우저인 척해야 woff2 대신 TTF를 준다(satori는 woff2를 못 읽는다). */
async function loadFont(family, weight, text) {
  const query = `family=${family.replaceAll(" ", "+")}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(`https://fonts.googleapis.com/css2?${query}`, { headers: { "user-agent": "Mozilla/4.0" } })).text();
  const url = css.match(/src: url\((.+?)\) format\('truetype'\)/)?.[1];
  if (!url) throw new Error(`${family} ${weight}: TTF 주소가 없다`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${family} ${weight}: ${res.status}`);
  return res.arrayBuffer();
}

const h = (type, style, children) => ({ type, props: { style, children } });

function card(post) {
  const size = post.title.length > 44 ? 54 : post.title.length > 28 ? 62 : 72;
  return h("div", { display: "flex", width: "100%", height: "100%", background: C.paper, padding: 36 }, [
    h("div", { display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", background: C.surface, border: `1px solid ${C.line}`, borderLeft: `10px solid ${C.accent}`, padding: "52px 64px 48px" }, [
      h("div", { display: "flex", alignItems: "center", gap: 16 }, [
        h("div", { display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, background: C.accent, color: C.surface, fontFamily: "Head", fontSize: 26 }, "P"),
        h("div", { display: "flex", fontFamily: "Mono", fontSize: 26, color: C.ink }, WORDMARK),
      ]),
      h("div", { display: "flex", fontFamily: "Head", fontSize: size, lineHeight: 1.28, letterSpacing: "-0.02em", color: C.ink }, post.title),
      h("div", { display: "flex", alignItems: "center", gap: 18, fontFamily: "Mono", fontSize: 22 }, [
        ...(post.category ? [h("div", { display: "flex", padding: "4px 14px", background: C.accentSoft, color: C.accent, border: `1px solid ${C.accent}` }, post.category.toUpperCase())] : []),
        h("div", { display: "flex", color: C.ink3 }, post.date),
      ]),
    ]),
  ]);
}

async function main() {
  const posts = [...readPosts("ko"), ...readPosts("en")];
  const glyphs = [...new Set([...posts.map((p) => p.title).join(""), ..."P"])].join("");
  const monoGlyphs = [...new Set([...WORDMARK, ...posts.map((p) => p.category.toUpperCase() + p.date).join("")])].join("");

  let fonts;
  try {
    fonts = [
      { name: "Head", data: await loadFont("Gothic A1", 800, glyphs), weight: 800 },
      { name: "Mono", data: await loadFont("IBM Plex Mono", 600, monoGlyphs), weight: 600 },
    ];
  } catch (error) {
    console.warn(`[og] 글꼴을 받지 못해 공유 이미지를 건너뜀: ${error.message}`);
    return;
  }

  fs.rmSync(outRoot, { recursive: true, force: true });
  const started = Date.now();
  for (const post of posts) {
    const dir = post.locale === "ko" ? outRoot : path.join(outRoot, post.locale);
    fs.mkdirSync(dir, { recursive: true });
    const image = new ImageResponse(card(post), { width: 1200, height: 630, fonts });
    fs.writeFileSync(path.join(dir, `${post.slug}.png`), Buffer.from(await image.arrayBuffer()));
  }
  console.log(`[og] ${posts.length}장 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
}

await main();
