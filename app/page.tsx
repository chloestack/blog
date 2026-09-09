const posts = [
  { date: "2026.09.07", category: "SYSTEM DESIGN", title: "작은 서비스가 이벤트 기반 아키텍처를 선택하기 전에", excerpt: "메시지 큐가 주는 자유와 함께 따라오는 운영 비용을 실제 의사결정의 순서로 정리했습니다.", readTime: "8분", tone: "teal" },
  { date: "2026.08.24", category: "FRONTEND", title: "React Server Components를 경계부터 이해하기", excerpt: "렌더링 방식이 아니라 코드와 데이터가 이동하는 경계라는 관점에서 다시 살펴봅니다.", readTime: "11분", tone: "blue" },
  { date: "2026.08.11", category: "DATABASE", title: "인덱스는 왜 때때로 쿼리를 더 느리게 만들까", excerpt: "카디널리티, 통계 정보, 쓰기 비용을 실행 계획 한 장으로 연결해 봅니다.", readTime: "7분", tone: "clay" },
  { date: "2026.07.29", category: "OPERATIONS", title: "좋은 알림은 장애보다 먼저 맥락을 말한다", excerpt: "알림 피로를 줄이고 판단 시간을 단축하는 관측 가능성 설계 원칙을 기록했습니다.", readTime: "6분", tone: "plum" },
  { date: "2026.07.16", category: "ENGINEERING", title: "코드 리뷰에서 취향과 결함을 구분하는 법", excerpt: "리뷰 코멘트의 기준을 명확하게 만들고 팀의 신뢰를 지키는 작은 규칙들입니다.", readTime: "5분", tone: "olive" },
  { date: "2026.06.30", category: "TOOLS", title: "매일 쓰는 CLI를 위한 오류 메시지 설계", excerpt: "실패 원인, 현재 상태, 다음 행동. 유용한 오류가 갖춰야 할 세 가지를 예제로 설명합니다.", readTime: "9분", tone: "rose" },
];

const topics = [["Frontend", "12"], ["System Design", "09"], ["Database", "07"], ["Operations", "06"], ["Engineering", "11"], ["Tools", "08"]];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <div className="wrap header-inner">
          <a className="wordmark" href="#top" aria-label="pistamond.log 홈"><span className="mark">P</span><span>pistamond.log</span></a>
          <nav aria-label="주요 메뉴"><a href="#articles">글</a><a href="#topics">주제</a><a href="#about">소개</a></nav>
        </div>
      </header>

      <div className="wrap" id="top">
        <section className="masthead" aria-labelledby="hero-title">
          <p className="eyebrow">ENGINEERING NOTES · SEOUL</p>
          <h1 id="hero-title">만들면서 이해한 것들을<br /><em>다시 꺼내 쓸 수 있게</em> 기록합니다.</h1>
          <div className="hero-foot">
            <p className="lede">소프트웨어의 구조, 인터페이스, 그리고 운영에 관한 기술 블로그. 결과보다 그 결과에 도착한 판단을 오래 남깁니다.</p>
            <p className="issue">VOL. 01 — 2026</p>
          </div>
        </section>

        <section className="featured" aria-labelledby="featured-title">
          <div className="section-kicker"><span>FEATURED ESSAY</span><span>01 / 07</span></div>
          <a className="featured-card" href="#featured-article">
            <div className="featured-copy">
              <div className="label-row"><span className="tag teal">ARCHITECTURE</span><span className="meta">12분 · 2026.09.09</span></div>
              <h2 id="featured-title">복잡성을 옮기는 일:<br />좋은 추상화의 조건</h2>
              <p>추상화는 복잡성을 없애지 않습니다. 사용자가 감당할 수 있는 장소로 옮길 뿐입니다. 오래 살아남는 인터페이스의 경계를 사례와 함께 살펴봅니다.</p>
              <span className="read-link">글 읽기 <span aria-hidden="true">→</span></span>
            </div>
            <div className="code-study" aria-hidden="true">
              <div className="code-head"><span>boundary.ts</span><span>···</span></div>
              <pre><code><span className="dim">01</span>  <span className="kw">type</span> Boundary = &#123;{`\n`}<span className="dim">02</span>    hides: Complexity;{`\n`}<span className="dim">03</span>    reveals: Intent;{`\n`}<span className="dim">04</span>  &#125;;{`\n\n`}<span className="dim">06</span>  <span className="kw">const</span> design ={`\n`}<span className="dim">07</span>    makeTradeoffVisible();</code></pre>
              <div className="code-note">{"// abstractions are decisions"}</div>
            </div>
          </a>
        </section>

        <section className="articles" id="articles" aria-labelledby="latest-title">
          <div className="section-heading"><div><p className="eyebrow">RECENT WRITING</p><h2 id="latest-title">최근 기록</h2></div><p>생각이 달라지면 글도 고칩니다.<br />각 글의 날짜는 마지막 수정일입니다.</p></div>
          <div className="post-list">
            {posts.map((post, index) => (
              <article className={`post-row ${post.tone}`} key={post.title}>
                <div className="post-number">{String(index + 2).padStart(2, "0")}</div>
                <div className="post-body">
                  <div className="label-row"><span className={`tag ${post.tone}`}>{post.category}</span><span className="meta">{post.date}</span></div>
                  <h3><a href={`#post-${index + 1}`}>{post.title}</a></h3><p>{post.excerpt}</p>
                </div>
                <div className="post-time"><span>{post.readTime}</span><span className="arrow" aria-hidden="true">↗</span></div>
              </article>
            ))}
          </div>
        </section>

        <section className="topics" id="topics" aria-labelledby="topics-title">
          <div className="section-heading compact"><div><p className="eyebrow">INDEX</p><h2 id="topics-title">주제별 찾아보기</h2></div></div>
          <div className="topic-grid">{topics.map(([topic, count]) => <a href="#articles" key={topic}><span>{topic}</span><span>{count}</span></a>)}</div>
        </section>

        <section className="about" id="about" aria-labelledby="about-title">
          <div><p className="eyebrow">ABOUT THIS LOG</p><h2 id="about-title">코드 바깥의 판단까지<br />기록하는 사람.</h2></div>
          <div className="about-copy"><p>pistamond는 제품을 만들고 운영하며 배운 것을 씁니다. 정답을 선언하기보다 선택의 조건과 실패의 맥락을 선명하게 남기는 글을 지향합니다.</p><p className="signature">pistamond · Seoul, KR</p></div>
        </section>

        <section className="newsletter" aria-labelledby="newsletter-title">
          <div><span className="tag teal">LETTER</span><h2 id="newsletter-title">새 글을 천천히 받아보세요.</h2><p>한 달에 한두 번, 새 기록과 짧은 메모를 보냅니다.</p></div>
          <form action="#newsletter" id="newsletter"><label className="sr-only" htmlFor="email">이메일 주소</label><input id="email" name="email" type="email" placeholder="you@example.com" required /><button type="submit">구독하기</button></form>
        </section>

        <footer>
          <a className="wordmark footer-mark" href="#top"><span className="mark">P</span><span>pistamond.log</span></a>
          <p>© 2026 pistamond. Built with curiosity.</p><a href="#top">맨 위로 ↑</a>
        </footer>
      </div>
    </main>
  );
}
