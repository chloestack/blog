---
name: code-block
description: 블로그 글(content/posts/**/*.md)에 코드 블록을 넣거나 고칠 때 쓰는 통일된 템플릿. 언어 이름, 파일 이름(title), 출력·ASCII 그림 구분, 길이와 주석 규칙을 정한다. 글을 새로 쓰거나 번역하거나, 본문의 ``` 펜스를 만질 때 반드시 먼저 읽는다.
---

# 코드 블록 템플릿

본문 코드 블록은 `lib/highlight.ts`가 서버에서 색칠해 한 가지 틀에 담는다.
틀 머리에는 **펜스에 적은 언어 이름**과 **title**이 그대로 찍힌다. 그래서 펜스 한 줄을
어떻게 적느냐가 곧 독자가 보는 모양이다. 아래 형식을 지킨다.

## 형식

````markdown
```<언어> title="<파일 이름>"
<코드>
```
````

- `<언어>`는 **항상** 적는다. 빈 펜스(```` ``` ````만)는 쓰지 않는다.
- `title`은 실제 파일에 속한 코드일 때만 붙인다. 파일 이름이나 경로만 적고, 설명은 쓰지 않는다.
  - 예: `title="OrderService.java"`, `title="src/main/resources/application.yml"`, `title="redis.conf"`
  - 조각 코드, 명령어, 쿼리 한 편에는 붙이지 않는다.

## 언어 이름

색칠되는 이름만 쓴다. 목록에 없는 언어가 꼭 필요하면 `lib/highlight.ts`의 `langs`에 문법을 먼저 더한다.

| 내용 | 적는 이름 |
|---|---|
| Java / Kotlin | `java` / `kotlin` |
| Python | `python` |
| JavaScript / TypeScript | `js` / `ts` |
| Go | `go` |
| SQL, Cassandra CQL | `sql`, `cql` |
| 셸 명령 | `bash` (프롬프트 `$`는 붙이지 않는다) |
| YAML / JSON / TOML | `yaml` / `json` / `toml` |
| `.properties`, `.env` | `properties`, `env` |
| redis.conf 같은 설정 파일 | `conf` |
| nginx 설정 | `nginx` |
| Dockerfile | `dockerfile` |
| HTTP 요청·응답 | `http` |
| XML / HTML / CSS | `xml` / `html` / `css` |
| 변경 전후 비교 | `diff` |
| RDF | `turtle` |
| Markdown | `markdown` |
| **명령 출력, 로그, ASCII 그림, 디렉터리 트리** | `text` |

`mermaid`와 `diagram`은 코드 블록이 아니라 도식이다. 이 스킬의 규칙을 따르지 않는다.

## 쓰는 규칙

1. **한 블록에 한 가지만.** 명령과 그 출력은 `bash` 블록과 `text` 블록으로 나눈다.
2. **길이는 40줄 안쪽.** 넘으면 핵심만 남기고 `// ...`(언어의 주석 문법)으로 생략을 표시한다.
   import 문과 getter/setter처럼 뻔한 부분은 먼저 뺀다.
3. **주석은 그 언어의 주석 문법으로, 본문과 같은 언어로.** 한국어 글이면 한국어 주석, 영문 글이면 영문 주석.
4. **좋은 예·나쁜 예 표시**는 주석 첫머리에 `// ❌ 잘못된 예:` / `// ✅ 올바른 예:` 형식으로 통일한다.
5. **들여쓰기는 스페이스 4칸**(YAML·JSON·HTML은 2칸). 탭은 쓰지 않는다.
6. **가짜 값은 가짜임이 드러나게.** 호스트는 `example.com`, 키는 `sk-...` 처럼 줄여 적고 실제 비밀값은 넣지 않는다.
7. 코드 블록 바로 앞 문단에서 **무엇을 보여 주는 코드인지 한 문장**으로 말한다. 블록이 문단 없이 연달아 나오지 않게 한다.

## 예

````markdown
주문 저장은 트랜잭션 하나로 묶는다.

```java title="OrderService.java"
@Transactional
public Order place(OrderRequest request) {
    Order order = orderRepository.save(Order.from(request));
    // ✅ 올바른 예: 커밋 뒤에 이벤트를 보낸다
    eventPublisher.publishEvent(new OrderPlaced(order.getId()));
    return order;
}
```

실행하면 다음처럼 찍힌다.

```text
INFO  OrderService - order 42 placed
```
````

## 확인

글을 고친 뒤 다음을 돌려 빈 펜스가 남지 않았는지 본다(0이 나와야 한다).

```bash
python3 - <<'EOF'
import glob, re
n = 0
for f in glob.glob("content/posts/**/*.md", recursive=True):
    inside = False
    for i, line in enumerate(open(f), 1):
        if re.match(r"^```", line):
            if not inside and line.strip() == "```":
                print(f"{f}:{i}"); n += 1
            inside = not inside
print(n)
EOF
```
