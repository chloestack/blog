/**
 * 한국어 slug → 영문 slug 색인을 만든다.
 *
 * 미들웨어는 엣지에서 돌아 파일 시스템을 읽을 수 없으므로, 번역본 frontmatter의
 * `koSlug`를 빌드 전에 한 모듈로 굳혀 둔다. 짝의 근거는 여전히 마크다운이고
 * 이 파일은 파생물이다 — 손으로 고치지 말고 `npm run pairs`로 다시 만든다.
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const root = path.join(import.meta.dirname, "..");
const koDir = path.join(root, "content", "posts");
const enDir = path.join(koDir, "en");
const out = path.join(root, "lib", "post-pairs.generated.ts");

function koSlugOf(file) {
  const { data } = matter(fs.readFileSync(path.join(enDir, file), "utf8"));
  return typeof data.koSlug === "string" ? data.koSlug.trim() : "";
}

const pairs = {};
const files = fs.existsSync(enDir) ? fs.readdirSync(enDir).filter((file) => file.endsWith(".md")).sort() : [];

for (const file of files) {
  const enSlug = file.replace(/\.md$/, "");
  const koSlug = koSlugOf(file);
  if (!koSlug) {
    console.warn(`[pairs] koSlug 없음, 건너뜀: en/${file}`);
    continue;
  }
  if (!fs.existsSync(path.join(koDir, `${koSlug}.md`))) {
    console.warn(`[pairs] 원본 글이 없음, 건너뜀: en/${file} → ${koSlug}`);
    continue;
  }
  pairs[koSlug] = enSlug;
}

const body = `/** 자동 생성 파일 — scripts/build-post-pairs.mjs. 직접 고치지 마세요. */
export const POST_PAIRS: Record<string, string> = ${JSON.stringify(pairs, null, 2)};
`;

fs.writeFileSync(out, body, "utf8");
console.log(`[pairs] ${Object.keys(pairs).length}쌍 기록: ${path.relative(root, out)}`);
