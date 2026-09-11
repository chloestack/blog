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
    // openGraph는 루트 레이아웃의 값을 물려받지 않고 통째로 대체된다.
    // siteName과 locale을 다시 적지 않으면 글 페이지 공유 카드에서만 빠진다.
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url: postHref(post.slug),
      siteName: "blog.pistamond",
      locale: "ko_KR",
      type: "article",
      publishedTime: post.publishedAt,
    },
    twitter: { card: "summary", title: post.title, description: post.excerpt },
  };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(decodeURIComponent(slug));
  if (!post) notFound();

  return <ArticleView post={post} />;
}
