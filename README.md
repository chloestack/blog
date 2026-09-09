# pistamond.log

`pistamond.dev`에서 운영하는 한국어 기술 블로그입니다. 소프트웨어의 구조,
인터페이스, 운영 과정에서 내린 판단을 기록합니다.

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
- `npm run build:vercel`: Vercel용 정적 Next.js 빌드 (`out/`)

GitHub의 기본 브랜치가 갱신되면 Vercel이 자동으로 다시 배포합니다.
