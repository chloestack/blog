import Link from "next/link";
import { categoryCounts, getAllPosts, postHref, readingTime, toneFor } from "@/lib/posts";

function formatDate(value: string): string {
  return value.replaceAll("-", ".");
}

export default function Home() {
  const published = getAllPosts();
  const [featured, ...rest] = published;
  const posts = rest.slice(0, 6);
  const topics = categoryCounts(published);

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

        {featured ? (
          <section className="featured" aria-labelledby="featured-title">
            <div className="section-kicker"><span>FEATURED ESSAY</span><span>01 / {String(published.length).padStart(2, "0")}</span></div>
            <Link className="featured-card" href={postHref(featured.slug)}>
              <div className="featured-copy">
                <div className="label-row"><span className={`tag ${toneFor(featured.category)}`}>{featured.category.toUpperCase()}</span><span className="meta">{readingTime(featured.body)} · {formatDate(featured.date)}</span></div>
                <h2 id="featured-title">{featured.title}</h2>
                <p>{featured.excerpt}</p>
                <span className="read-link">글 읽기 <span aria-hidden="true">→</span></span>
              </div>
              <div className="code-study" aria-hidden="true">
                <div className="code-head"><span>boundary.ts</span><span>···</span></div>
                <pre><code><span className="dim">01</span>  <span className="kw">type</span> Boundary = &#123;{`\n`}<span className="dim">02</span>    hides: Complexity;{`\n`}<span className="dim">03</span>    reveals: Intent;{`\n`}<span className="dim">04</span>  &#125;;{`\n\n`}<span className="dim">06</span>  <span className="kw">const</span> design ={`\n`}<span className="dim">07</span>    makeTradeoffVisible();</code></pre>
                <div className="code-note">{"// abstractions are decisions"}</div>
              </div>
            </Link>
          </section>
        ) : null}

        <section className="articles" id="articles" aria-labelledby="latest-title">
          <div className="section-heading"><div><p className="eyebrow">RECENT WRITING</p><h2 id="latest-title">최근 기록</h2></div><p>생각이 달라지면 글도 고칩니다.<br />각 글의 날짜는 마지막 수정일입니다.</p></div>
          {posts.length === 0 ? (
            <p className="empty-note">아직 공개된 글이 없습니다.</p>
          ) : (
            <div className="post-list">
              {posts.map((post, index) => {
                const tone = toneFor(post.category);
                return (
                  <article className={`post-row ${tone}`} key={post.slug}>
                    <div className="post-number">{String(index + 2).padStart(2, "0")}</div>
                    <div className="post-body">
                      <div className="label-row"><span className={`tag ${tone}`}>{post.category.toUpperCase()}</span><span className="meta">{formatDate(post.date)}</span></div>
                      <h3><Link href={postHref(post.slug)}>{post.title}</Link></h3><p>{post.excerpt}</p>
                    </div>
                    <div className="post-time"><span>{readingTime(post.body)}</span><span className="arrow" aria-hidden="true">↗</span></div>
                  </article>
                );
              })}
            </div>
          )}
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
