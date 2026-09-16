import { recordVisit } from "@/lib/visits";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "";
  const counts = await recordVisit(ip, request.headers.get("user-agent") ?? "");
  return Response.json(counts, { headers: { "cache-control": "no-store" } });
}
