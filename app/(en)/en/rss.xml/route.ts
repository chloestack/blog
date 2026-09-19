import { renderFeed } from "@/lib/feed";

export function GET(): Response {
  return renderFeed("en");
}
