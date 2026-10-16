---
title: "LLM 스트리밍 응답 구현 — Server-Sent Events와 청크 파싱"
date: "2026-10-17 02:09"
category: "AI"
tags: ["LLM 스트리밍", "SSE", "Spring Boot", "청크 파싱", "실시간 응답"]
excerpt: "LLM(대형 언어 모델)을 애플리케이션에 통합할 때 가장 먼저 맞닥뜨리는 과제 중 하나는 응답 지연(latency) 문제입니다."
---

## 목차

1. 개요
2. Server-Sent Events의 동작 원리
3. LLM 스트리밍 API 구조와 청크 파싱
4. Spring Boot로 SSE 스트리밍 서버 구현
5. 프론트엔드 SSE 수신과 실시간 렌더링
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경: LLM 응답과 사용자 경험

LLM(대형 언어 모델)을 애플리케이션에 통합할 때 가장 먼저 맞닥뜨리는 과제 중 하나는 **응답 지연(latency)** 문제입니다. GPT-4나 Claude 같은 모델은 수백 토큰 분량의 응답을 생성할 때 수 초에서 수십 초가 걸릴 수 있으며, 동기적 API 호출 방식에서는 사용자가 빈 화면을 보며 기다려야 합니다. **SSE(Server-Sent Events)와 LLM 스트리밍 API를 결합하면** 모델이 토큰을 생성하는 즉시 화면에 텍스트가 흘러나오도록 구현할 수 있어, 사용자는 응답이 살아있다는 느낌을 받게 됩니다. 이 글에서는 LLM 스트리밍 응답의 내부 원리부터 Spring Boot 서버 구현, 프론트엔드 청크 수신, 그리고 운영 환경에서 반드시 짚어야 할 함정까지 체계적으로 다룹니다.

### 기존 방식의 한계: 동기적 API 호출의 문제점

전통적인 REST API 방식에서는 클라이언트가 요청을 보내고 서버가 전체 응답을 조립한 뒤 한 번에 반환합니다. LLM 백엔드에서도 마찬가지로, 모델이 모든 토큰 생성을 완료할 때까지 HTTP 응답이 시작되지 않습니다. 이 방식은 세 가지 측면에서 구체적인 문제를 만들어 냅니다.

첫째, **체감 응답 시간(perceived latency)**이 실제보다 훨씬 길게 느껴집니다. 500 토큰 응답을 생성하는 데 8초가 걸린다면 사용자는 8초 동안 아무것도 보지 못하지만, 스트리밍 방식에서는 첫 번째 토큰이 300ms 만에 도착하기 시작할 수 있습니다.

둘째, **타임아웃 위험**이 높아집니다. 프록시나 로드 밸런서는 보통 30~60초의 유휴 연결 타임아웃을 갖고 있으며, 복잡한 분석이나 긴 문서 생성을 요청할 경우 응답이 완성되기 전에 연결이 끊어질 수 있습니다. 스트리밍 방식에서는 데이터가 흐르는 한 연결이 유지됩니다.

셋째, **서버 메모리 부담**이 증가합니다. 동기 방식에서는 전체 응답 텍스트를 서버 메모리에 버퍼링한 뒤 한꺼번에 전송하지만, 스트리밍에서는 청크 단위로 즉시 전달하므로 서버 측 메모리 사용량이 훨씬 낮습니다. 대규모 동시 접속 환경에서 이 차이는 무시할 수 없습니다.

---

```diagram
2026-10-17-e8c9176c-01
```

동기 방식에서는 서버가 모델의 모든 토큰 생성을 기다린 뒤에야 클라이언트로 전송을 시작합니다.

---

## Server-Sent Events의 동작 원리

### HTTP 스트리밍과 SSE 프로토콜

**SSE(Server-Sent Events)**는 서버에서 클라이언트로 단방향 이벤트를 연속적으로 전송하기 위한 HTTP 기반 표준입니다. W3C가 정의한 이 프로토콜은 `Content-Type: text/event-stream` 헤더와 특정 텍스트 포맷만 있으면 동작하며, 별도의 WebSocket 핸드셰이크나 바이너리 프레임 파싱 없이 일반 HTTP 연결을 그대로 재사용합니다. SSE 메시지는 `data:`, `event:`, `id:`, `retry:` 필드로 구성된 텍스트 라인이며, 빈 줄(`\n\n`)이 메시지 경계를 구분합니다.

SSE의 핵심 특성은 **HTTP 연결을 열어둔 채 서버가 일방적으로 데이터를 밀어 넣는다**는 점입니다. 클라이언트는 `EventSource` 객체를 생성하면 브라우저가 연결을 유지하고, 연결이 끊어지면 `retry` 필드에 지정된 시간 이후 자동으로 재연결을 시도합니다. 이 자동 재연결 메커니즘은 WebSocket이나 Long Polling에서 직접 구현해야 하는 기능을 프로토콜 레벨에서 제공합니다.

LLM 스트리밍에서 SSE가 특히 적합한 이유는 **단방향성**에 있습니다. 사용자는 질문을 한 번 보내고, 이후 응답 수신은 서버→클라이언트 방향으로만 이루어집니다. 양방향 통신이 필요 없는 이 패턴은 SSE가 설계된 목적과 정확히 일치합니다.

---

```diagram
2026-10-17-e8c9176c-02
```

SSE는 단일 HTTP 연결로 서버가 여러 메시지를 순서대로 전송하며, `[DONE]` 신호로 스트림 종료를 알립니다.

---

### SSE와 WebSocket, Long Polling 비교

LLM 스트리밍 구현 시 세 가지 방식 중 하나를 선택하게 됩니다. 각각의 트레이드오프를 이해하면 프로젝트 특성에 맞는 선택을 내릴 수 있습니다.

| 방식 | 방향성 | 프로토콜 | 자동 재연결 | 로드밸런서 호환성 | LLM 적합도 |
|---|---|---|---|---|---|
| SSE | 단방향 | HTTP/1.1, HTTP/2 | 브라우저 내장 | ✅ 일반 HTTP | ⭐⭐⭐ 최적 |
| WebSocket | 양방향 | WS/WSS | 직접 구현 필요 | ⚠️ 별도 설정 필요 | ⭐⭐ 과잉 |
| Long Polling | 유사 단방향 | HTTP/1.1 | 직접 구현 필요 | ✅ | ⭐ 비효율 |

WebSocket은 양방향 실시간 통신(채팅, 게임 상태 동기화)에 적합하지만, LLM 응답 스트리밍처럼 단방향 데이터 흐름에 적용하면 프로토콜 업그레이드 오버헤드와 로드밸런서 호환 문제만 추가됩니다. 많은 기업용 환경에서 WebSocket을 통과시키려면 프록시나 API 게이트웨이 설정을 별도로 조정해야 합니다. Long Polling은 클라이언트가 요청을 보내고 서버가 데이터가 생길 때까지 응답을 지연시키는 방식인데, LLM처럼 수백 개의 청크가 연속으로 발생하면 각 청크마다 새 HTTP 요청이 발생하므로 연결 수립 오버헤드가 누적됩니다.

### 청크 전송 인코딩의 실제 동작

SSE가 동작하려면 서버가 HTTP `Transfer-Encoding: chunked` 또는 HTTP/2의 데이터 프레임을 사용해 응답 본문을 조각으로 전송해야 합니다. Spring Boot에서는 `SseEmitter` 또는 `Flux<ServerSentEvent>` 반응형 스트림이 이 역할을 맡습니다. Nginx 같은 리버스 프록시를 앞단에 둘 경우, 프록시가 응답을 버퍼링하면 클라이언트에는 청크가 도착하지 않고 전체 응답이 완료된 뒤 한꺼번에 전달됩니다.

> `proxy_buffering off`와 `X-Accel-Buffering: no` 헤더는 Nginx 환경에서 SSE 스트리밍을 위한 필수 설정입니다.

이 문제는 현업에서 자주 마주치는 함정입니다. 로컬 개발 환경에서는 스트리밍이 정상 동작하는데 스테이징 서버에 배포하면 텍스트가 한꺼번에 나타난다면, 거의 대부분 프록시 버퍼링이 원인입니다. 설정 한 줄로 해결되지만 원인을 모르면 디버깅에 오랜 시간이 걸립니다.

---

## LLM 스트리밍 API 구조와 청크 파싱

### OpenAI·Claude API의 스트리밍 응답 형식

주요 LLM 제공사는 스트리밍을 활성화하면 SSE 형식으로 응답을 반환합니다. OpenAI의 경우 요청 바디에 `"stream": true` 파라미터를 추가하면 각 청크가 다음과 같은 형태로 도착합니다.

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"안"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"녕"}}]}

data: [DONE]
```

Anthropic Claude API도 유사한 구조이지만 이벤트 타입(`event: content_block_delta`, `event: message_stop`)을 더 명시적으로 활용합니다. 두 API 모두 `data:` 접두사 뒤에 JSON 페이로드가 오고, 스트림 종료 시 특별한 종료 신호를 보내는 패턴은 동일합니다.

청크를 파싱할 때 중요한 점은 **한 번의 읽기 작업이 반드시 한 개의 완전한 SSE 메시지에 대응하지 않는다**는 것입니다. 네트워크 조건에 따라 여러 메시지가 합쳐지거나(`data: ...\n\ndata: ...\n\n`) 하나의 메시지가 여러 조각으로 나뉠 수 있습니다. 견고한 파서는 항상 누적 버퍼(accumulate buffer)를 유지하며 `\n\n`을 기준으로 메시지를 분리해야 합니다.

---

```diagram
2026-10-17-e8c9176c-03
```

청크 파서는 `\n\n` 경계를 기준으로 메시지를 재조립하며, `[DONE]` 신호를 받을 때까지 버퍼를 유지합니다.

---

### delta 구조와 역할 분리 설계

OpenAI 스트리밍의 각 청크는 `choices[0].delta.content` 경로에 토큰 조각을 담습니다. 대화 히스토리를 조립할 때 이 `delta` 값들을 순서대로 이어 붙이면 최종 응답 텍스트가 됩니다. 스트림이 완료된 뒤 `choices[0].finish_reason`이 `"stop"`이면 정상 완료이고, `"length"`이면 `max_tokens` 제한에 도달한 것입니다.

서버 측에서는 이 파싱 로직을 **별도 서비스 계층으로 분리**하는 것이 중요합니다. LLM 제공사의 API 형식은 버전에 따라 바뀔 수 있고, 향후 다른 모델로 교체할 가능성도 있습니다. 파서를 SSE 전송 로직과 분리해 두면 API 형식이 바뀌었을 때 파싱 부분만 수정하면 되어 변경 범위가 최소화됩니다. 전략 패턴이나 인터페이스 기반 설계를 적용해 OpenAI 파서와 Claude 파서를 교체 가능한 구조로 만드는 것이 규모 있는 프로젝트에서 유리합니다.

### 스트림 오류와 부분 실패 처리

LLM API 스트리밍에서 특별히 까다로운 상황은 **스트림 중간에 오류가 발생하는 경우**입니다. 응답이 절반쯤 오다가 네트워크가 끊어지거나 LLM 제공사 서버에 오류가 생기면, 클라이언트는 이미 일부 텍스트를 화면에 출력한 상태입니다. 이때 단순히 연결을 끊으면 사용자는 텍스트가 중간에 잘린 상태를 보게 됩니다.

권장 패턴은 오류 발생 시 `event: error`라는 별도 SSE 이벤트 타입으로 클라이언트에 알리는 것입니다. 클라이언트는 이 이벤트를 수신하면 지금까지 렌더링한 텍스트를 유지하되, 오류 메시지를 추가로 표시할 수 있습니다. 단순히 연결을 끊는 것보다 훨씬 나은 사용자 경험을 제공하며, 프론트엔드에서 재시도 버튼을 노출하는 등의 후속 처리도 자연스럽게 연결됩니다.

---

## Spring Boot로 SSE 스트리밍 서버 구현

### SseEmitter 설정과 쓰레드 모델

Spring MVC에서 SSE를 구현하는 방법은 크게 두 가지입니다. `SseEmitter`를 사용하는 전통적인 방식과 Spring WebFlux의 `Flux<ServerSentEvent>`를 사용하는 반응형 방식입니다. LLM API 클라이언트 라이브러리 대부분이 블로킹 방식이나 `CompletableFuture` 기반이므로, 기존 Spring MVC 프로젝트에서는 `SseEmitter`가 더 자연스럽게 통합됩니다.

`SseEmitter`를 사용할 때는 **타임아웃 설정**이 핵심입니다. 기본 타임아웃은 30초로, 긴 응답 생성 시 연결이 만료됩니다. 운영 환경에서는 예상 최대 응답 시간에 여유를 더해 180~300초로 설정하고, 그 이상 소요되면 클라이언트에 명시적인 오류 이벤트를 보내 연결을 정리하는 것이 바람직합니다.

LLM API 호출은 블로킹 I/O이므로 Spring의 요청 처리 쓰레드를 점유하지 않도록 별도 쓰레드 풀에서 실행해야 합니다. Java 21의 가상 쓰레드(Virtual Thread)를 사용하면 쓰레드 풀 크기에 대한 걱정 없이 수천 개의 동시 스트리밍 연결을 처리할 수 있습니다. `Executors.newVirtualThreadPerTaskExecutor()`로 생성한 `ExecutorService`에 LLM 호출과 SSE 전송 작업을 제출하면, 연결 수가 늘어나도 OS 쓰레드 고갈 없이 확장됩니다.

---

```diagram
2026-10-17-e8c9176c-04
```

컨트롤러는 `SseEmitter`를 즉시 반환하고, 실제 LLM 호출은 별도 쓰레드 풀에서 진행됩니다.

---

### 핵심 구현: SSE 컨트롤러와 청크 전송

컨트롤러에서 SSE 응답을 반환하려면 `produces = MediaType.TEXT_EVENT_STREAM_VALUE`를 지정하고, `SseEmitter`를 즉시 반환한 뒤 별도 쓰레드에서 LLM 호출과 청크 전송을 처리합니다. Spring Boot 3.x와 OpenAI 호환 클라이언트를 기준으로 작성한 예시입니다.

```java
@RestController
@RequestMapping("/api/chat")
public class ChatStreamController {

    private final LlmStreamService llmStreamService;
    private final ExecutorService executor =
        Executors.newVirtualThreadPerTaskExecutor(); // Java 21 가상 쓰레드

    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamChat(@RequestBody ChatRequest request) {
        SseEmitter emitter = new SseEmitter(300_000L); // 타임아웃 300초

        // 연결 해제 시 LLM 호출 중단을 위한 플래그
        AtomicBoolean cancelled = new AtomicBoolean(false);
        emitter.onCompletion(() -> cancelled.set(true));
        emitter.onTimeout(() -> cancelled.set(true));

        executor.submit(() -> {
            try {
                llmStreamService.stream(request, chunk -> {
                    if (cancelled.get()) return; // 클라이언트 이탈 시 조기 종료
                    try {
                        emitter.send(SseEmitter.event()
                            .name("token")
                            .data(chunk));          // 토큰 청크 전송
                    } catch (IOException e) {
                        cancelled.set(true);
                    }
                });
                if (!cancelled.get()) {
                    emitter.send(SseEmitter.event().name("done").data("[DONE]"));
                    emitter.complete();
                }
            } catch (Exception e) {
                try {
                    emitter.send(SseEmitter.event()
                        .name("error").data(e.getMessage())); // 오류 이벤트
                } catch (IOException ignored) {}
                emitter.completeWithError(e);
            }
        });

        return emitter; // 즉시 반환, 연결은 비동기로 유지
    }
}
```

`produces = MediaType.TEXT_EVENT_STREAM_VALUE`는 Spring이 `Content-Type: text/event-stream`을 응답 헤더에 자동으로 설정하도록 합니다. `AtomicBoolean cancelled` 플래그는 클라이언트가 먼저 연결을 끊었을 때 LLM API 호출을 조기 종료하는 역할을 합니다. LLM 호출 비용과 서버 리소스 낭비를 줄이는 데 중요한 부분입니다.

### 연결 해제와 리소스 정리

스트리밍 구현에서 자주 간과되는 부분이 **클라이언트가 먼저 연결을 끊었을 때의 정리**입니다. 사용자가 응답 생성 중에 페이지를 닫거나 새로고침하면, 서버 측 LLM API 호출은 기본적으로 계속 진행됩니다. 이는 LLM API 비용 낭비와 서버 리소스 점유로 이어집니다.

`SseEmitter`의 `onCompletion()`, `onTimeout()`, `onError()` 콜백을 등록하면 연결 상태 변화를 감지할 수 있습니다. 위 코드에서 사용한 `AtomicBoolean` 방식 외에도, LLM SDK가 `AutoCloseable` 스트림을 제공하는 경우 콜백에서 직접 `close()`를 호출할 수 있습니다. 연결당 자원 할당이 명확해야 대규모 동시 접속에서 리소스 누수 없이 안정적으로 운영할 수 있습니다.

---

## 프론트엔드 SSE 수신과 실시간 렌더링

### EventSource API와 커스텀 이벤트 타입

브라우저의 `EventSource` API는 SSE 연결을 관리하는 표준 인터페이스입니다. 기본 `message` 이벤트 외에 서버에서 지정한 커스텀 이벤트 타입(`event: token`, `event: done`, `event: error`)을 별도 리스너로 처리할 수 있습니다. 커스텀 이벤트 타입을 활용하면 동일한 연결에서 토큰 스트리밍, 완료 신호, 오류 알림을 명확히 분리하여 처리할 수 있습니다.

```javascript
// POST로 세션을 먼저 생성하고, 세션 ID로 SSE 구독
async function startStream(userMessage) {
    // EventSource는 GET만 지원 → POST로 세션 ID를 먼저 발급
    const { sessionId } = await fetch('/api/chat/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ message: userMessage })
    }).then(r => r.json());

    const outputEl = document.getElementById('output');
    let fullText = '';
    const eventSource = new EventSource(`/api/chat/stream?sessionId=${sessionId}`);

    eventSource.addEventListener('token', (e) => {
        fullText += e.data;
        outputEl.textContent = fullText; // 누적 텍스트 실시간 갱신
    });

    eventSource.addEventListener('done', () => {
        eventSource.close(); // 완료 시 명시적 연결 종료
    });

    eventSource.addEventListener('error', (e) => {
        outputEl.textContent += '\n[응답 생성 중 오류: ' + e.data + ']';
        eventSource.close();
    });
}
```

POST로 세션을 먼저 생성하고 GET으로 SSE를 구독하는 패턴은 `EventSource`의 GET 제약을 우회하는 실용적인 방법입니다. 세션 ID는 UUID로 발급하고 Redis 등에 짧은 TTL로 저장하면 됩니다.

---

```diagram
2026-10-17-e8c9176c-05
```

POST로 세션을 생성하고 GET으로 SSE를 구독하면 `EventSource`의 GET 제약을 우회하면서 인증 헤더도 전달할 수 있습니다.

---

### fetch()와 EventSource의 선택 기준

`EventSource`의 GET 제약을 피하는 현대적 방법은 **`fetch()` API와 `ReadableStream`을 활용**하는 것입니다. `fetch()`는 POST 요청을 지원하고, 응답의 `response.body`를 `ReadableStream`으로 읽으면 SSE와 유사한 청크 수신이 가능합니다.

| 항목 | EventSource | fetch + ReadableStream |
|---|---|---|
| 요청 방식 | GET만 | GET/POST 모두 |
| 자동 재연결 | 브라우저 내장 | 직접 구현 필요 |
| 커스텀 헤더 | 불가 | 가능 (Authorization 등) |
| 구현 복잡도 | 낮음 | 중간 |
| 라이브러리 지원 | 없음 | @microsoft/fetch-event-source |

인증 토큰을 `Authorization` 헤더로 전달해야 하는 프로젝트라면 `fetch()` 기반 구현이 사실상 필수입니다. `@microsoft/fetch-event-source`는 POST를 지원하면서도 자동 재연결을 제공하는 오픈 소스 라이브러리로, 두 방식의 장점을 결합하고 있습니다. 별도 세션 발급 없이 POST로 직접 스트림을 시작할 수 있어 구현이 단순해집니다.

### 실시간 렌더링 성능 최적화

토큰이 초당 30~50개씩 도착하면 각 토큰마다 DOM을 갱신할 때 성능 문제가 생길 수 있습니다. 특히 Markdown을 실시간 렌더링하는 경우 텍스트가 길어질수록 파싱 비용이 선형적으로 증가합니다. 두 가지 최적화 패턴이 효과적입니다.

첫째, **`requestAnimationFrame()` 기반 배치 업데이트**입니다. 토큰을 수신할 때마다 직접 DOM을 건드리지 않고, 수신된 청크를 임시 배열에 쌓아 두고 다음 렌더링 프레임에 한꺼번에 적용합니다. 이렇게 하면 초당 60프레임 이상의 업데이트가 브라우저 렌더링 사이클에 맞춰 자연스럽게 배치됩니다.

둘째, **스트리밍 중 Markdown 렌더링을 유보**합니다. 스트리밍 중에는 일반 텍스트로 표시하고, `done` 이벤트를 받은 뒤 한 번만 Markdown 파싱과 렌더링을 수행합니다. 사용자가 텍스트가 흐르는 것을 보는 동안에는 Markdown 포맷이 중요하지 않으므로, 완료 시점의 렌더링 품질과 스트리밍 중 성능 사이에서 균형을 잘 잡을 수 있습니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

LLM 스트리밍을 처음 적용하는 팀이 가장 많이 겪는 문제는 **프록시 버퍼링**과 **로드밸런서 타임아웃** 두 가지입니다. 앞에서 언급한 Nginx 버퍼링 문제 외에도, AWS Application Load Balancer는 기본적으로 유휴 연결 타임아웃이 60초로 설정되어 있어 긴 응답 생성 시 연결이 중단됩니다. ALB의 `idle_timeout` 값을 300초로 늘리거나, 서버에서 30초마다 빈 SSE 코멘트(`:\n\n`)를 전송해 연결을 유지하는 킵얼라이브(keepalive) 메커니즘을 구현해야 합니다.

클라이언트 연결 수도 고려해야 합니다. HTTP/1.1에서 브라우저는 동일 도메인에 최대 6개의 연결을 동시에 허용합니다. SSE 연결이 하나 열려 있으면 나머지 5개만 사용 가능하여, 같은 도메인의 다른 API 요청이 지연될 수 있습니다. HTTP/2를 사용하면 단일 TCP 연결로 여러 스트림을 다중화할 수 있어 이 제약에서 자유로워집니다. LLM 스트리밍 서비스를 별도 서브도메인(예: `stream.api.example.com`)으로 분리하는 것도 유효한 해결책입니다.

---

```diagram
2026-10-17-e8c9176c-06
```

운영 환경에서 ALB의 타임아웃과 Nginx의 버퍼링은 가장 빈번한 스트리밍 장애 원인입니다. 두 레이어 모두 점검이 필요합니다.

---

### 모니터링과 디버깅

스트리밍 응답의 품질을 모니터링할 때는 일반적인 API 지표와는 다른 관점이 필요합니다. 응답 시간 대신 **첫 토큰 도달 시간(Time To First Token, TTFT)**과 **토큰 생성 속도(tokens/sec)**를 핵심 지표로 측정해야 합니다. TTFT는 사용자가 체감하는 반응 속도를 직접 반영하고, 토큰 생성 속도는 전체 응답 완료까지 걸리는 시간을 결정합니다.

분산 추적(distributed tracing) 관점에서는 SSE 연결 하나가 단일 HTTP 트랜잭션으로 기록되므로, 스트림 내부의 각 청크가 어느 단계에서 지연됐는지 파악하기 어렵습니다. 애플리케이션 레벨에서 첫 청크 수신 시각, 청크 간 최대 간격, 스트림 완료 시각을 명시적으로 로그에 남겨두면 성능 병목을 진단하는 데 큰 도움이 됩니다.

비정상적으로 긴 청크 간격(10초 이상)이 반복된다면 LLM 제공사의 API 스로틀링이나 네트워크 지연을 의심해야 합니다. LLM API에 대한 재시도 로직을 구현할 때는 지수 백오프(exponential backoff)를 적용하되, 이미 스트리밍이 시작된 이후에는 재시도 대신 오류 이벤트를 클라이언트에 보내고 새 요청으로 유도하는 것이 더 안전합니다. 중간에 재시도하면 클라이언트는 이미 출력된 텍스트와 새로 시작된 텍스트를 구별하기 어렵습니다.

### 확장성과 마이그레이션 고려사항

수천 명의 사용자가 동시에 스트리밍 응답을 수신한다면 서버는 수천 개의 긴 HTTP 연결을 유지해야 합니다. 전통적인 쓰레드 기반 서버에서는 이것이 쓰레드 고갈로 이어질 수 있습니다. **Java 21의 가상 쓰레드** 또는 **Spring WebFlux의 Project Reactor**를 도입하면 이 문제를 효과적으로 해결할 수 있습니다. 가상 쓰레드는 기존 Spring MVC 코드를 크게 바꾸지 않고 적용할 수 있어, 스트리밍 서버 전환 시 낮은 마이그레이션 비용으로 높은 동시성을 얻을 수 있는 방법입니다.

멀티 인스턴스 환경에서는 SSE 연결의 스티키 세션(sticky session) 문제가 없습니다. SSE는 단방향이므로 각 요청이 어느 인스턴스에 도달하든 독립적으로 처리됩니다. 단, 서버 메모리에 LLM 대화 히스토리를 저장하고 있다면 특정 인스턴스에 히스토리가 묶이는 문제가 생깁니다. Redis 같은 분산 저장소로 대화 히스토리를 외부화하면 이 문제를 해결하고 수평 확장이 자유로워집니다.

---

```diagram
2026-10-17-e8c9176c-07
```

대화 히스토리를 Redis로 외부화하면 어느 인스턴스에서도 스트리밍 요청을 처리할 수 있어 수평 확장이 가능합니다.

---

## 맺음말

### 핵심 요약

LLM 스트리밍 응답 구현의 핵심은 세 가지 레이어가 맞물려 동작한다는 점입니다. 첫째, LLM 제공사 API의 스트리밍 모드를 활성화하고 `\n\n` 경계 기반의 누적 버퍼 파서로 청크를 안정적으로 처리합니다. 둘째, Spring Boot의 `SseEmitter`로 HTTP 스트리밍 연결을 유지하되, 가상 쓰레드 풀로 블로킹 LLM 호출을 분리하고 클라이언트 이탈 시 자원을 정리합니다. 셋째, 프론트엔드에서 `EventSource`나 `fetch()` 스트림으로 토큰을 수신하고 `requestAnimationFrame()`으로 DOM 갱신을 배치 처리합니다. 각 레이어 사이에는 프록시 버퍼링, 연결 타임아웃, 클라이언트 조기 종료라는 세 가지 함정이 있으며, 운영 환경 배포 전에 반드시 점검해야 합니다.

### 적용 판단 기준

LLM 스트리밍은 **응답 길이가 평균 200 토큰을 넘거나**, **사용자가 생성 과정을 직접 보는 것이 제품 가치와 연결되는 경우**라면 도입 효과가 뚜렷합니다. 반대로 내부 배치 처리나 API 통합처럼 사람이 직접 응답을 보지 않는 경우에는 동기적 API가 구현이 더 간단하고 오류 처리가 명확합니다. 인증이 필요하거나 POST 요청이 필수인 환경에서는 `EventSource` 대신 `fetch()` 기반 구현이나 `@microsoft/fetch-event-source`를 선택하고, 운영 환경에서는 TTFT와 토큰 생성 속도를 핵심 지표로 모니터링하는 체계를 갖추는 것이 안정적인 서비스 운영의 출발점이 됩니다.
