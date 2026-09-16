/**
 * 방문자 수. 따로 DB를 두지 않고 Vercel 마켓플레이스로 붙인 Upstash Redis의 REST API를
 * fetch로 직접 부른다. 연결 정보가 없으면(로컬·테스트) 아무것도 세지 않는다.
 *
 * - 하루 기준은 한국 시간 자정이다.
 * - 같은 사람이 같은 날 여러 페이지를 봐도 한 번만 센다. 사람은 IP·브라우저를 날짜와
 *   함께 해시한 값으로만 구분하고, 그 집합은 이틀 뒤 지워진다. 원래 IP는 저장하지 않는다.
 * - 이 Redis는 finance.pistamond와 같이 쓴다. 숫자가 섞이지 않도록 키 앞에 `blog:`를 붙인다.
 */

export type VisitCounts = { today: number; total: number };

const PREFIX = "blog:visits";

const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|curl|wget|python|axios|node-fetch/i;

function redisConfig() {
  const env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env;
  // 마켓플레이스 연동은 KV_*, Upstash에서 직접 만든 DB는 UPSTASH_* 이름을 쓴다.
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function pipeline(config: { url: string; token: string }, commands: (string | number)[][]) {
  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`redis ${response.status}`);
  return ((await response.json()) as { result: unknown }[]).map((entry) => entry.result);
}

function kstDate(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function visitorId(day: string, ip: string, userAgent: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${day}|${ip}|${userAgent}`));
  return [...new Uint8Array(bytes).slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 방문을 기록하고 오늘·전체 수를 돌려준다. 저장소가 없거나 실패하면 null. */
export async function recordVisit(ip: string, userAgent: string): Promise<VisitCounts | null> {
  const config = redisConfig();
  if (!config) return null;

  const day = kstDate();
  const todayKey = `${PREFIX}:day:${day}`;
  const totalKey = `${PREFIX}:total`;

  try {
    let results: unknown[];
    if (BOT.test(userAgent)) {
      results = await pipeline(config, [["GET", todayKey], ["GET", totalKey]]);
    } else {
      const seenKey = `${PREFIX}:seen:${day}`;
      const [added] = await pipeline(config, [
        ["SADD", seenKey, await visitorId(day, ip, userAgent)],
        ["EXPIRE", seenKey, 2 * 24 * 60 * 60],
      ]);
      results = added === 1
        ? await pipeline(config, [["INCR", todayKey], ["INCR", totalKey]])
        : await pipeline(config, [["GET", todayKey], ["GET", totalKey]]);
    }
    const [today, total] = results.map((value) => Number(value ?? 0));
    return { today, total };
  } catch {
    return null;
  }
}
