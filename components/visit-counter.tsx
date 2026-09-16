"use client";

import { useEffect, useState } from "react";
import type { VisitCounts } from "@/lib/visits";

// 방문 기록은 페이지를 처음 열 때 한 번만 보낸다. 푸터(기록)와 목록 머리(표시)가
// 같은 응답을 나눠 쓰고, 사이트 안에서 링크로 옮겨 다닐 때도 다시 보내지 않는다.
let pending: Promise<VisitCounts | null> | null = null;

function loadVisits() {
  pending ??= fetch("/api/visit", { method: "POST" })
    .then((response) => (response.ok ? (response.json() as Promise<VisitCounts | null>) : null))
    .catch(() => null);
  return pending;
}

/** 아무것도 그리지 않고 방문만 기록한다. 모든 페이지의 푸터에 들어간다. */
export function VisitBeacon() {
  useEffect(() => { void loadVisits(); }, []);
  return null;
}

/** 목록 오른쪽 위의 방문자 수. 자리는 미리 잡아 두고, 집계가 꺼져 있으면 비워 둔다. */
export function VisitCounter() {
  const [counts, setCounts] = useState<VisitCounts | null>(null);

  useEffect(() => {
    let alive = true;
    void loadVisits().then((data) => { if (alive && data) setCounts(data); });
    return () => { alive = false; };
  }, []);

  const format = (value: number) => value.toLocaleString("ko-KR");
  return (
    <p className="visit-counter" aria-live="polite">
      {counts ? <>오늘 <b>{format(counts.today)}</b> · 전체 <b>{format(counts.total)}</b></> : null}
    </p>
  );
}
