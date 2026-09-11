import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/posts";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://blog.pistamond.dev";
  const posts = getAllPosts();

  return [
    { url: base, lastModified: posts[0]?.publishedAt || undefined, changeFrequency: "weekly" },
    { url: `${base}/privacy`, changeFrequency: "yearly" as const },
    ...posts.map((post) => ({
      url: `${base}/posts/${encodeURIComponent(post.slug)}`,
      lastModified: post.publishedAt,
    })),
  ];
}
