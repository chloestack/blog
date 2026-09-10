import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleView } from "@/components/article-view";
import { getAllPosts, getPostBySlug, postHref } from "@/lib/posts";

// 저장소에 있는 글이 곧 전부이므로, 그 외의 주소는 404다.
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(decodeURIComponent(slug));
  if (!post) return {};

  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: postHref(post.slug) },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url: postHref(post.slug),
      type: "article",
      publishedTime: post.date,
    },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(decodeURIComponent(slug));
  if (!post) notFound();

  return <ArticleView post={post} />;
}
