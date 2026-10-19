---
title: "Implementing LLM Streaming Responses — Server-Sent Events and Chunk Parsing"
date: "2026-10-17 02:09"
updated: "2026-10-19 15:39"
category: "AI"
tags: ["LLM streaming", "SSE", "Spring Boot", "chunk parsing", "real-time response"]
excerpt: "Streaming LLM responses token by token: SSE chunk parsing, Spring Boot SseEmitter, front-end rendering, and three pitfalls — proxy buffering, timeouts, and early disconnects."
koSlug: "2026-10-17-LLM-스트리밍-응답-구현-—-Server-Sent-Events와-청크-파싱"
---

## Table of Contents

1. Overview
2. How Server-Sent Events Work
3. LLM Streaming API Structure and Chunk Parsing
4. Building an SSE Streaming Server with Spring Boot
5. Receiving SSE and Rendering in Real Time on the Frontend
6. Considerations for Production
7. Closing Thoughts

---

## Overview

### The Problem: LLM Responses and User Experience

One of the first challenges you hit when integrating an LLM (large language model) into an application is **response latency**. Models like GPT-4 or Claude can take anywhere from a few seconds to tens of seconds to generate a response of several hundred tokens, and with a synchronous API call the user stares at a blank screen the whole time. **Combining SSE (Server-Sent Events) with the LLM streaming API** lets text appear on screen as fast as the model produces tokens, so the user feels like the response is alive. This post covers everything from the internal mechanics of LLM streaming to Spring Boot server implementation, frontend chunk reception, and the traps you must watch out for in production.

### The Limits of the Synchronous Approach

In a traditional REST API, the client sends a request, the server assembles the full response, and returns it all at once. The same happens on the LLM backend: the HTTP response does not begin until the model finishes generating every token. This creates three concrete problems.

First, **perceived latency** feels much longer than it actually is. If generating a 500-token response takes 8 seconds, the user sees nothing for 8 seconds. In streaming mode the first token can start arriving in as little as 300 ms.

Second, **timeout risk** goes up. Proxies and load balancers typically have idle-connection timeouts of 30–60 seconds. For complex analysis or long document generation, the connection can be cut before the response is complete. In streaming mode, the connection stays alive as long as data is flowing.

Third, **server memory pressure** increases. In synchronous mode the entire response text is buffered in server memory before transmission; streaming delivers chunks immediately, so server-side memory usage is substantially lower. At scale this difference is significant.

---

```diagram
en/2026-10-17-e8c9176c-01
```

In synchronous mode, the server waits for the model to finish generating all tokens before it starts sending to the client.

---

## How Server-Sent Events Work

### HTTP Streaming and the SSE Protocol

**SSE (Server-Sent Events)** is an HTTP-based standard for sending a continuous stream of unidirectional events from server to client. Defined by the W3C, it works with nothing more than a `Content-Type: text/event-stream` header and a specific text format. No WebSocket handshake, no binary frame parsing — it reuses a plain HTTP connection as-is. SSE messages are text lines made up of `data:`, `event:`, `id:`, and `retry:` fields, with a blank line (`\n\n`) marking message boundaries.

The defining characteristic of SSE is that **the server pushes data unilaterally over a persistent open HTTP connection**. The client creates an `EventSource` object and the browser keeps the connection alive, automatically reconnecting after the time specified in the `retry` field if it drops. That auto-reconnect mechanism is something you'd have to implement yourself with WebSocket or Long Polling; here it's built into the protocol.

The reason SSE fits LLM streaming especially well is its **unidirectional nature**. The user sends a question once, and the response flows in one direction only: server to client. That pattern is exactly what SSE was designed for.

---

```diagram
en/2026-10-17-e8c9176c-02
```

SSE sends multiple messages in order over a single HTTP connection and signals stream completion with a `[DONE]` event.

---

### SSE vs. WebSocket vs. Long Polling

When implementing LLM streaming you typically pick one of three approaches. Understanding the trade-offs lets you choose based on your project's needs.

| Approach | Direction | Protocol | Auto-reconnect | Load balancer compatibility | LLM fit |
|---|---|---|---|---|---|
| SSE | Unidirectional | HTTP/1.1, HTTP/2 | Built into browser | ✅ Plain HTTP | ⭐⭐⭐ Ideal |
| WebSocket | Bidirectional | WS/WSS | Must implement yourself | ⚠️ Needs extra config | ⭐⭐ Overkill |
| Long Polling | Quasi-unidirectional | HTTP/1.1 | Must implement yourself | ✅ | ⭐ Inefficient |

WebSocket suits bidirectional real-time communication (chat, game state sync), but applying it to a one-way data flow like LLM response streaming only adds protocol-upgrade overhead and load-balancer compatibility headaches. In many enterprise environments you need to separately configure proxies or API gateways to pass WebSocket traffic. Long Polling has the client send a request and the server delay its response until data is ready. When hundreds of chunks arrive in quick succession like they do from an LLM, each chunk triggers a new HTTP request, so connection-establishment overhead accumulates fast.

### How Chunked Transfer Encoding Actually Works

For SSE to function, the server must use HTTP `Transfer-Encoding: chunked` or HTTP/2 data frames to send the response body in pieces. In Spring Boot, `SseEmitter` or the reactive `Flux<ServerSentEvent>` handles this. When a reverse proxy like Nginx sits in front, if the proxy buffers the response the client never sees individual chunks — it receives everything at once after the full response completes.

> `proxy_buffering off` and the `X-Accel-Buffering: no` header are required Nginx settings for SSE streaming.

This is a trap that comes up constantly in practice. If streaming works fine locally but text appears all at once on the staging server, it's almost always proxy buffering. One line of config fixes it, but without knowing the cause you can spend a long time debugging.

---

## LLM Streaming API Structure and Chunk Parsing

### The Streaming Response Format from OpenAI and Claude

The major LLM providers return streaming responses in SSE format. For OpenAI, add `"stream": true` to the request body and each chunk arrives like this:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"He"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"llo"}}]}

data: [DONE]
```

The Anthropic Claude API has a similar structure but uses event types more explicitly (`event: content_block_delta`, `event: message_stop`). Both APIs share the same pattern: a JSON payload after the `data:` prefix, and a special termination signal at the end of the stream.

The important thing to understand when parsing chunks is that **a single read operation does not necessarily correspond to exactly one complete SSE message**. Depending on network conditions, multiple messages can arrive merged together (`data: ...\n\ndata: ...\n\n`), or a single message can arrive split across multiple reads. A robust parser always maintains an accumulation buffer and splits messages on `\n\n`.

---

```diagram
en/2026-10-17-e8c9176c-03
```

The chunk parser reassembles messages on `\n\n` boundaries and keeps the buffer until it receives the `[DONE]` signal.

---

### The delta Structure and Separation of Concerns

Each chunk in OpenAI streaming carries a token fragment at `choices[0].delta.content`. Concatenating these `delta` values in order gives you the final response text. After the stream completes, `choices[0].finish_reason` of `"stop"` means normal completion; `"length"` means the `max_tokens` limit was hit.

On the server side it is important to **isolate this parsing logic in a separate service layer**. LLM provider API formats can change between versions, and you may switch models later. Keeping the parser decoupled from the SSE transmission logic means an API format change only requires touching the parsing part, minimizing the blast radius. For larger projects, applying a strategy pattern or interface-based design so the OpenAI parser and the Claude parser are interchangeable is a worthwhile investment.

### Handling Stream Errors and Partial Failures

A particularly tricky situation in LLM API streaming is when **an error occurs mid-stream**. If the network drops or the LLM provider's server errors out halfway through a response, the client has already rendered part of the text. Simply closing the connection leaves the user looking at truncated text.

The recommended pattern is to notify the client via a separate `event: error` SSE event type. When the client receives this event it can preserve the text rendered so far and display an additional error message. This is a much better user experience than just dropping the connection, and it naturally connects to follow-up handling like showing a retry button on the frontend.

---

## Building an SSE Streaming Server with Spring Boot

### SseEmitter Configuration and the Threading Model

There are two main ways to implement SSE in Spring MVC: the traditional approach using `SseEmitter`, and the reactive approach using `Flux<ServerSentEvent>` from Spring WebFlux. Most LLM API client libraries are blocking or `CompletableFuture`-based, so `SseEmitter` integrates more naturally in an existing Spring MVC project.

When using `SseEmitter`, **timeout configuration is critical**. The default timeout is 30 seconds, which will expire the connection during long response generation. In production, set it to 180–300 seconds to cover your expected maximum response time with headroom, and send an explicit error event to the client if that limit is exceeded so the connection is cleaned up properly.

Because LLM API calls are blocking I/O, they must run in a separate thread pool to avoid tying up Spring's request-handling threads. Java 21 virtual threads let you handle thousands of concurrent streaming connections without worrying about thread pool size. Submit LLM calls and SSE transmission work to an `ExecutorService` created with `Executors.newVirtualThreadPerTaskExecutor()`, and the system scales without OS thread exhaustion as connection counts grow.

---

```diagram
en/2026-10-17-e8c9176c-04
```

The controller returns the `SseEmitter` immediately; the actual LLM call proceeds in a separate thread pool.

---

### The Core Implementation: SSE Controller and Chunk Transmission

To return an SSE response from a controller, specify `produces = MediaType.TEXT_EVENT_STREAM_VALUE`, return the `SseEmitter` immediately, and handle the LLM call and chunk transmission in a separate thread. The following example targets Spring Boot 3.x with an OpenAI-compatible client.

```java
@RestController
@RequestMapping("/api/chat")
public class ChatStreamController {

    private final LlmStreamService llmStreamService;
    private final ExecutorService executor =
        Executors.newVirtualThreadPerTaskExecutor(); // Java 21 virtual threads

    @PostMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamChat(@RequestBody ChatRequest request) {
        SseEmitter emitter = new SseEmitter(300_000L); // 300-second timeout

        // Flag to cancel the LLM call when the connection drops
        AtomicBoolean cancelled = new AtomicBoolean(false);
        emitter.onCompletion(() -> cancelled.set(true));
        emitter.onTimeout(() -> cancelled.set(true));

        executor.submit(() -> {
            try {
                llmStreamService.stream(request, chunk -> {
                    if (cancelled.get()) return; // Early exit if client disconnected
                    try {
                        emitter.send(SseEmitter.event()
                            .name("token")
                            .data(chunk));          // Send token chunk
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
                        .name("error").data(e.getMessage())); // Error event
                } catch (IOException ignored) {}
                emitter.completeWithError(e);
            }
        });

        return emitter; // Returns immediately; connection stays open asynchronously
    }
}
```

`produces = MediaType.TEXT_EVENT_STREAM_VALUE` tells Spring to automatically set the `Content-Type: text/event-stream` response header. The `AtomicBoolean cancelled` flag cancels the LLM API call early when the client disconnects first. This is important for reducing LLM API costs and avoiding wasted server resources.

### Handling Disconnects and Cleaning Up Resources

One aspect of streaming implementations that gets overlooked frequently is **cleanup when the client disconnects first**. If a user closes or refreshes the page while a response is being generated, the server-side LLM API call continues by default. This wastes LLM API cost and holds server resources.

Registering `onCompletion()`, `onTimeout()`, and `onError()` callbacks on `SseEmitter` lets you detect connection state changes. Beyond the `AtomicBoolean` approach used above, if the LLM SDK provides an `AutoCloseable` stream you can call `close()` directly from those callbacks. Having clear per-connection resource ownership is what makes it possible to run large numbers of concurrent connections in production without resource leaks.

---

## Receiving SSE and Rendering in Real Time on the Frontend

### The EventSource API and Custom Event Types

The browser's `EventSource` API is the standard interface for managing SSE connections. Beyond the default `message` event, you can attach separate listeners for custom event types that the server specifies (`event: token`, `event: done`, `event: error`). Using custom event types lets you cleanly separate token streaming, completion signals, and error notifications over the same connection.

```javascript
// Create a session via POST first, then subscribe to SSE using the session ID
async function startStream(userMessage) {
    // EventSource only supports GET → issue a session ID via POST first
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
        outputEl.textContent = fullText; // Update accumulated text in real time
    });

    eventSource.addEventListener('done', () => {
        eventSource.close(); // Explicitly close on completion
    });

    eventSource.addEventListener('error', (e) => {
        outputEl.textContent += '\n[Error during response generation: ' + e.data + ']';
        eventSource.close();
    });
}
```

The pattern of creating a session via POST and then subscribing via GET is a practical workaround for `EventSource`'s GET-only constraint. Issue the session ID as a UUID and store it in Redis or similar with a short TTL.

---

```diagram
en/2026-10-17-e8c9176c-05
```

Creating the session via POST and subscribing via GET works around `EventSource`'s GET restriction while still allowing you to pass an auth header.

---

### When to Use fetch() vs. EventSource

The modern way to avoid `EventSource`'s GET restriction is to use the **`fetch()` API with `ReadableStream`**. `fetch()` supports POST requests, and reading `response.body` as a `ReadableStream` gives you chunk reception similar to SSE.

| | EventSource | fetch + ReadableStream |
|---|---|---|
| Request method | GET only | GET and POST |
| Auto-reconnect | Built into browser | Must implement yourself |
| Custom headers | Not possible | Possible (Authorization, etc.) |
| Implementation complexity | Low | Medium |
| Library support | None | @microsoft/fetch-event-source |

If your project needs to pass an auth token via the `Authorization` header, a `fetch()`-based implementation is essentially mandatory. `@microsoft/fetch-event-source` is an open-source library that supports POST while also providing auto-reconnect, combining the advantages of both approaches. It lets you start the stream directly with POST without issuing a separate session, which keeps the implementation simpler.

### Optimizing Real-Time Rendering Performance

When tokens arrive at 30–50 per second, updating the DOM on every single token can cause performance issues. This is especially true when rendering Markdown in real time — the parsing cost grows linearly as the text gets longer. Two optimization patterns work well here.

First, **`requestAnimationFrame()`-based batch updates**. Instead of touching the DOM on every received token, accumulate incoming chunks in a temporary array and apply them all at once on the next rendering frame. Updates faster than 60 frames per second are naturally batched to align with the browser's rendering cycle.

Second, **defer Markdown rendering during streaming**. Display plain text while streaming, and do a single Markdown parse and render after receiving the `done` event. Markdown formatting doesn't matter while the user is watching text flow by, so this trades streaming performance against rendering quality at completion time in a way that works well in practice.

---

## Considerations for Production

### Common Mistakes and Pitfalls

The two problems teams encounter most when first deploying LLM streaming are **proxy buffering** and **load balancer timeouts**. Beyond the Nginx buffering issue already mentioned, AWS Application Load Balancer has a default idle connection timeout of 60 seconds, which will cut a long response generation short. Either raise ALB's `idle_timeout` to 300 seconds, or implement a keepalive mechanism that sends a blank SSE comment (`:\n\n`) every 30 seconds to keep the connection alive.

Client connection limits are also worth considering. Under HTTP/1.1, browsers allow a maximum of 6 simultaneous connections to the same domain. With one SSE connection open, only 5 remain for other API requests to the same domain, which can delay them. HTTP/2 multiplexes multiple streams over a single TCP connection, which sidesteps this constraint. Routing LLM streaming to a separate subdomain (e.g., `stream.api.example.com`) is another valid solution.

---

```diagram
en/2026-10-17-e8c9176c-06
```

In production, ALB timeouts and Nginx buffering are the most frequent sources of streaming failures. Both layers need to be checked.

---

### Monitoring and Debugging

Monitoring the quality of streaming responses requires a different perspective than monitoring a standard API. Instead of response time, the metrics you need are **Time To First Token (TTFT)** and **token generation rate (tokens/sec)**. TTFT directly reflects the responsiveness the user experiences; token generation rate determines how long the full response takes to complete.

From a distributed tracing perspective, a single SSE connection shows up as one HTTP transaction, making it hard to see where inside the stream individual chunks were delayed. Explicitly logging the time of the first chunk received, the maximum gap between chunks, and the stream completion time at the application level makes a big difference when you're diagnosing performance bottlenecks.

If abnormally long inter-chunk gaps (10+ seconds) occur repeatedly, suspect LLM provider API throttling or network latency. When implementing retry logic for LLM API calls, use exponential backoff — but once streaming has already started, sending an error event to the client and directing them to submit a new request is safer than retrying mid-stream. If you retry mid-stream, the client has no way to distinguish the already-rendered text from the newly restarted text.

### Scalability and Migration Considerations

If thousands of users are receiving streaming responses concurrently, the server must maintain thousands of long-lived HTTP connections. On a traditional thread-per-connection server this can lead to thread exhaustion. **Java 21 virtual threads** or **Spring WebFlux's Project Reactor** address this effectively. Virtual threads can be adopted without major changes to existing Spring MVC code, making them a low-migration-cost path to high concurrency for streaming servers.

In a multi-instance environment, SSE connections do not have a sticky session problem. SSE is unidirectional, so each request can be handled independently regardless of which instance it lands on. However, if you store LLM conversation history in server memory, that history becomes pinned to a specific instance. Externalizing conversation history to a distributed store like Redis solves this problem and allows free horizontal scaling.

---

```diagram
en/2026-10-17-e8c9176c-07
```

Externalizing conversation history to Redis means any instance can handle a streaming request, enabling horizontal scaling.

---

## Closing Thoughts

### Summary

The key to implementing LLM streaming responses is that three layers have to work together. First, enable streaming mode on the LLM provider API and use an accumulation buffer parser that splits on `\n\n` boundaries to process chunks reliably. Second, use Spring Boot's `SseEmitter` to maintain the HTTP streaming connection, offload blocking LLM calls to a virtual thread pool, and clean up resources when clients disconnect. Third, receive tokens on the frontend with `EventSource` or a `fetch()` stream and batch DOM updates with `requestAnimationFrame()`. Between those layers are three traps — proxy buffering, connection timeouts, and early client disconnection — that you must verify before deploying to production.

### When to Use It

LLM streaming has a clear payoff when **average response length exceeds 200 tokens** or when **watching the generation happen is itself part of the product value**. Conversely, for internal batch processing or API integrations where no human is watching the response, synchronous API calls are simpler to implement and easier to handle errors in. If authentication is required or POST requests are mandatory, choose a `fetch()`-based implementation or `@microsoft/fetch-event-source` over `EventSource`. In production, setting up monitoring with TTFT and token generation rate as your primary metrics is the right starting point for stable service operations.
