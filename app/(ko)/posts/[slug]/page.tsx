import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArticleView } from "@/components/article-view";
import { articleMetadata } from "@/lib/metadata";
import { getAllPosts, getPostBySlug } from "@/lib/posts";

// 저장소에 있는 글이 곧 전부이므로, 그 외의 주소는 404다.
export const dynamicParams = false;

export function generateStaticParams() {
  return getAllPosts("ko").map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(decodeURIComponent(slug), "ko");
  return post ? articleMetadata(post) : {};
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(decodeURIComponent(slug), "ko");
  if (!post) notFound();

  return <ArticleView post={post} />;
}
