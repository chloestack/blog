"use client";

import { useEffect, useState } from "react";
import type { VisitCounts } from "@/lib/visits";

/** 푸터의 방문자 수. 서버 렌더에는 비어 있고, 집계가 꺼져 있으면 끝까지 아무것도 그리지 않는다. */
export function VisitCounter() {
  const [counts, setCounts] = useState<VisitCounts | null>(null);

  useEffect(() => {
    fetch("/api/visit", { method: "POST" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: VisitCounts | null) => { if (data) setCounts(data); })
      .catch(() => {});
  }, []);

  if (!counts) return null;
  const format = (value: number) => value.toLocaleString("ko-KR");
  return <p className="visit-counter">오늘 {format(counts.today)} · 전체 {format(counts.total)}</p>;
}
