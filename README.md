# blog.pistamond

`pistamond.dev`에서 운영하는 한국어 기술 블로그입니다. 소프트웨어의 구조,
인터페이스, 운영 과정에서 내린 판단을 기록합니다.

## 글은 어떻게 올라오는가

매일 아침 07:00에 로컬 launchd 잡(`com.tistory-writer.daily`)이
`~/workspace/mcp/tistory-writer/agent.py`를 실행해 카테고리별 글을 생성하고,
`content/posts/`에 마크다운으로 커밋·푸시합니다.

**비공개 상태는 없습니다.** `content/posts/`에 있는 마크다운은 전부 공개된 글입니다.
커밋이 기본 브랜치에 올라가면 Vercel이 자동으로 다시 배포하고, 그 배포부터 글이
목록과 사이트맵에 그대로 나타납니다. 즉 커밋되는 순간이 곧 공개 시점입니다.

글을 내리려면 해당 마크다운 파일을 저장소에서 지우고 푸시하면 됩니다.

### frontmatter

```yaml
---
title: "글 제목"
date: "2026-09-10"        # 작성일이자 공개일. 목록 정렬 기준
category: "Spring"
tags: ["Spring Boot"]
excerpt: "목록에 쓰이는 한 문단"
---
```

`status`, `publishedAt` 필드는 더 이상 쓰이지 않습니다. 남아 있어도 무시됩니다.

## 측정 태그

네이버 애널리틱스(wcs) 태그는 `components/analytics.tsx`에 있고, 루트 레이아웃
(`app/layout.tsx`)이 `</body>` 바로 앞에서 한 번만 렌더링합니다. **새 페이지를 만들 때
태그를 따로 붙이지 마세요.** `app/` 아래에 페이지만 추가하면 레이아웃을 거치면서
자동으로 따라붙습니다.

측정 ID를 바꾸거나 다른 태그를 더할 곳도 `components/analytics.tsx` 한 곳입니다.
모든 페이지에 실제로 붙는지는 `tests/rendered-html.test.mjs`가 확인합니다.

## 환경변수

사이트를 빌드하고 띄우는 데 필요한 환경변수는 없습니다.

## 로컬 실행

```bash
npm install
npm run dev
```

## 확인 및 빌드

```bash
npm run lint
npm test
npm run build:vercel
```

- `npm run build`: Sites용 vinext 빌드
- `npm run build:vercel`: Vercel용 Next.js 빌드

GitHub의 기본 브랜치가 갱신되면 Vercel이 자동으로 다시 배포합니다.
