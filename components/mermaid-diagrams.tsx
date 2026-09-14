"use client";

import { useEffect } from "react";

/** 도식은 자연 폭까지만 키우고, 컨테이너가 더 좁으면 그 폭에 맞춰 줄인다. */
function fitToColumn(svg: SVGSVGElement | null) {
  if (!svg) return;
  const natural = parseFloat(svg.style.maxWidth);
  svg.style.maxWidth = Number.isFinite(natural) ? `min(100%, ${Math.round(natural)}px)` : "100%";
}

/**
 * 본문의 `<pre class="mermaid">`를 SVG로 바꾼다. mermaid는 수백 KB라 도식이 있는
 * 글에서만 이 컴포넌트를 두고, 그 안에서도 동적 import로 따로 받는다.
 *
 * 색은 글 쪽의 classDef(ok·warn·stop·new·acc·mute)가 정하고, 여기서는 그 밖의
 * 바탕 — 선 색, 글꼴, 곡선, 여백 — 을 사이트 톤(globals.css의 변수)에 맞춘다.
 * 티스토리 시절 도식(cross-the-line.tistory.com/157)과 같은 모양이 기준이다.
 */
export function MermaidDiagrams() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(".prose pre.mermaid"));
      if (nodes.length === 0) return;

      // mermaid는 글자 폭을 재서 상자 크기를 정한다. 웹 폰트가 오기 전에 재면
      // 대체 글꼴 기준으로 상자가 잡혀, 폰트가 바뀐 뒤 라벨 끝이 잘린다.
      // figure는 본문 문단과 같은 CSS 글자 크기를 쓰므로 실제 픽셀 값을 읽는다.
      const figure = nodes[0].closest<HTMLElement>("figure.diagram");
      if (!figure) return;
      const bodyFontSize = getComputedStyle(figure).fontSize;
      const [{ default: mermaid }] = await Promise.all([
        import("mermaid"),
        document.fonts.load(`${bodyFontSize} "IBM Plex Sans KR"`).catch(() => undefined),
      ]);
      await document.fonts.ready;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        // 12의 기본값은 그림자 있는 상자에 직각으로 꺾이는 선이다. 티스토리 도식은
        // 평면 상자에 곡선이라, 예전 모양(classic)과 예전 배치기(dagre)를 고른다.
        // flowchart.curve는 dagre 배치에서만 먹는다.
        look: "classic",
        layout: "dagre",
        // 한국어 라벨이 폭 계산에 걸려 "구/분"처럼 음절 중간에서 줄이 바뀌었다. 줄바꿈은 글에서 <br/>로만 한다.
        markdownAutoWrap: false,
        fontFamily: '"IBM Plex Sans KR", "Apple SD Gothic Neo", system-ui, sans-serif',
        themeVariables: {
          background: "#f8fafb",
          fontSize: bodyFontSize,
          primaryColor: "#eef2f4",
          primaryBorderColor: "#c3d0d4",
          primaryTextColor: "#122127",
          secondaryColor: "#d4e7ea",
          tertiaryColor: "#f8fafb",
          lineColor: "#6c8188",
          textColor: "#122127",
          edgeLabelBackground: "#f8fafb",
          clusterBkg: "#eef2f4",
          clusterBorder: "#dae3e6",
          noteBkgColor: "#f5e8cc",
          noteBorderColor: "#a96a08",
          actorBkg: "#d4e7ea",
          actorBorder: "#0d5763",
          signalColor: "#3f545c",
        },
        flowchart: { curve: "basis", padding: 18, nodeSpacing: 46, rankSpacing: 56, htmlLabels: true, wrappingWidth: 480 },
        sequence: { mirrorActors: false },
      });

      for (const [index, node] of nodes.entries()) {
        if (cancelled || node.dataset.rendered) continue;
        const source = node.textContent ?? "";
        try {
          const { svg } = await mermaid.render(`diagram-${index}-${Date.now()}`, source);
          if (cancelled) return;
          node.innerHTML = svg;
          fitToColumn(node.querySelector("svg"));
          node.dataset.rendered = "true";
        } catch (error) {
          // 문법이 틀린 도식은 원문 코드로 남긴다. 빈 칸이나 폭탄 아이콘보다 낫다.
          node.classList.add("mermaid-error");
          node.dataset.rendered = "error";
          console.warn("[mermaid] 렌더링 실패", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
