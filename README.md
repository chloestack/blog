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
date: "2026-09-10 07:19"  # 발행 시각(KST). 목록은 이 값의 내림차순
category: "Spring"
tags: ["Spring Boot"]
excerpt: "목록에 쓰이는 한 문단"
---
```

`date`는 `YYYY-MM-DD HH:MM` 형식입니다. 하루에 여러 편이 올라오므로 날짜만 적으면
같은 날 글의 순서가 파일명 순으로 흩어집니다. 글을 만드는
`~/workspace/mcp/tistory-writer/blog_repo.py`가 파일을 쓰는 시각을 함께 적습니다.
시각이 없는 글은 그날 00:00으로 보고, 같은 시각인 글끼리는 파일명 순입니다.

`status`, `publishedAt` 필드는 더 이상 쓰이지 않습니다. 남아 있어도 무시됩니다.

## 영문판과 지역 전환

한국어가 원본이고 영어가 번역본입니다. 한국어는 주소 그대로(`/`, `/posts/<slug>`),
영어는 `/en` 아래(`/en`, `/en/posts/<영문 slug>`)에 섭니다. **기존 한국어 주소는
바뀌지 않습니다.**

- 번역본은 `content/posts/en/<영문 slug>.md`에 두고, frontmatter에
  `koSlug: "<원본 slug>"`로 원본을 가리킵니다. **이 값이 두 언어의 글을 짝짓는 유일한
  근거입니다** — 이것이 없으면 hreflang도, 언어 전환 링크도, 지역 리다이렉트도
  그 글에서는 생기지 않습니다.
- 도식은 `content/diagrams/en/<이름>.html`에 영문판을 두고, 영문 본문의
  ` ```diagram ` 블록이 `en/<이름>`을 가리킵니다. 영문화에 실패한 도식은 한국어
  그림을 그대로 가리킵니다.
- 지면에 찍히는 문구(목록, 푸터, 버튼)는 전부 `lib/i18n.ts`에 있습니다. 컴포넌트는
  `locale`만 받아 골라 씁니다.
- `<html lang>`이 언어마다 달라야 해서 루트 레이아웃이 둘입니다 —
  `app/(ko)/layout.tsx`와 `app/(en)/layout.tsx`. 페이지를 더할 때는 어느 지면에
  세울지부터 정하세요.
- 개인정보처리방침은 한국어 원문 한 벌만 둡니다(`/privacy`). 영문 푸터도 같은
  문서를 가리킵니다.

### 어떤 사람이 영문으로 넘어가는가

`proxy.ts`가 한국어 목록·글 주소에서만 판단합니다. 자동 전환은 한국어 → 영어 한
방향뿐이고, 영문 주소로 직접 들어온 사람을 되돌리지는 않습니다(공유된 링크가 열려야
하니까요).

| 들어온 사람 | 결과 |
| --- | --- |
| 접속 국가가 KR | 한국어 그대로 |
| Accept-Language에 한국어가 있음 | 한국어 그대로 (해외 거주 한국어 사용자) |
| 크롤러(Googlebot 등) | 한국어 그대로. 짝은 hreflang으로만 알립니다 |
| `lang` 쿠키로 한국어를 고른 사람 | 한국어 그대로 |
| 그 밖의 해외 방문자 | `/en/posts/<영문 slug>`로 302 |
| 번역본이 없는 글 | 옮길 곳이 없으므로 한국어 그대로 |

머리의 언어 링크는 `?lang=ko|en`을 붙여 보내고, 미들웨어가 그 값을 `lang` 쿠키로
옮긴 뒤 파라미터 없는 주소로 다시 보냅니다. 한 번 고르면 그 뒤로는 지역을 보지
않습니다.

미들웨어는 엣지에서 돌아 파일을 읽을 수 없으므로, 한국어 → 영문 slug 색인을
`lib/post-pairs.generated.ts`로 굳혀 둡니다. 빌드가 `npm run pairs`로 다시 만들고,
번역본 frontmatter와 어긋나면 테스트가 잡습니다. **손으로 고치지 마세요.**

### 영문판은 어떻게 만들어지는가

`~/workspace/mcp/tistory-writer/translate.py`가 `claude -p`로 옮깁니다. 일일 생성기는
글을 저장한 뒤 커밋 전에 이것을 부르므로, 새 글은 두 언어가 같은 커밋에 올라갑니다.

```bash
cd ~/workspace/mcp/tistory-writer
python3 translate.py --list          # 번역본이 없는 글
python3 translate.py                 # 전부 옮긴다 (있는 것은 건너뜀)
python3 translate.py --limit 5       # 최신 5편만
python3 translate.py --slug <원본 slug>
python3 translate.py --force --slug <원본 slug>   # 다시 옮긴다
python3 translate.py --fix-diagrams  # 영문 글에 남은 한국어 도식만 다시 시도
```

도식 영문화는 두 번까지 시도하고, 그래도 실패하면 그 블록만 한국어 그림을 그대로
가리킵니다 — 글은 영문으로 서고 그림 하나만 한국어로 남습니다.

## 도식

**기본 도식 도구는 diagram-design 스킬입니다** (2026-09-15 글부터).

- 도식은 `content/diagrams/<이름>.html`(스킬이 만든 단독 HTML)에 두고, 본문에는
  ` ```diagram ` 블록에 이름만 적습니다. 빌드 때 `lib/posts.ts`의 `readDiagramSvg`가
  그 파일의 `<svg>`를 본문에 인라인하므로 방문자 브라우저의 JS와 무관하게 보입니다.
  이름은 영소문자·숫자·하이픈만 됩니다. 파일이 없으면 빌드가 멈춥니다.
- 생성기는 모델이 쓴 ` ```mermaid ` 블록을 설계도로 삼아 블록마다 diagram-design으로
  다시 그린 뒤 ` ```diagram `으로 바꿔 커밋합니다(`tistory-writer/diagrams.py`).
- ` ```mermaid ` 블록은 9/14 이전 글과 변환에 실패한 블록을 위해서만 남아 있고,
  브라우저에서 mermaid.js로 그립니다(`components/mermaid-diagrams.tsx`).

## 측정 태그

네이버 애널리틱스(wcs) 태그는 `components/analytics.tsx`에 있고, 두 루트 레이아웃
(`app/(ko)/layout.tsx`, `app/(en)/layout.tsx`)이 `</body>` 바로 앞에서 한 번만
렌더링합니다. **새 페이지를 만들 때
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
- 두 빌드 모두 `npm run pairs`를 먼저 돌려 slug 색인을 새로 만듭니다

GitHub의 기본 브랜치가 갱신되면 Vercel이 자동으로 다시 배포합니다.
