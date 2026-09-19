---
title: "Spring WebClient Timeout, Retry, and Connection Pool Tuning"
date: "2026-09-19 07:18"
category: "Spring"
tags: ["Spring WebClient", "Reactor Netty", "connection pool", "retry strategy", "Circuit Breaker"]
excerpt: "A practical guide to tuning Spring WebClient's timeout layers, retry strategies, and connection pool settings for production reliability."
koSlug: "2026-09-19-Spring-WebClient-타임아웃·재시도·커넥션-풀-튜닝"
---

## Table of Contents

1. Overview
2. WebClient Internals and How It Works
3. Timeout Configuration In Depth
4. Retry Strategy Design
5. Connection Pool Tuning
6. Production Considerations
7. Closing Thoughts

---

## Overview

### Background

Spring WebClient is a non-blocking HTTP client introduced in Spring 5 and has become the standard replacement for the blocking I/O-based RestTemplate. Its core strength is event-loop-based asynchronous processing, which lets a fixed number of threads handle far more concurrent requests. However, calling external APIs with default settings makes it easy to run into incidents where requests wait indefinitely when responses are slow or connections cannot be established, or where the connection pool is exhausted. This post covers tuning methods applicable in production, focusing on three axes: timeouts, retries, and the connection pool.

### Limitations of the Old Approach

Combining RestTemplate with `HttpComponentsClientHttpRequestFactory` was straightforward. The common pattern was to specify socket and connect timeouts at the factory level and attach Spring Retry's `RetryTemplate` separately. The problem is the threading model. Blocking I/O requires growing the thread count proportionally with concurrent requests, and once hundreds of threads are created, context-switching overhead cancels out any throughput gains.

WebClient solves this with event-loop-based I/O. The trade-off is that the timeout layers are split across the channel level, the HTTP level, and the reactive pipeline level, so the configuration does not behave as intended unless you understand each setting point precisely. In particular, leaving the connection pool at its defaults means the pool's own acquire wait time can contradict the timeout behavior you expect.

```diagram
en/2026-09-19-f8fc1d22-01
```

When migrating from RestTemplate to WebClient, simply replacing the API call code tends to leave configuration layers missing, and that omission is a common source of production incidents.

---

## WebClient Internals and How It Works

### Reactor Netty and the Event Loop

The default HTTP engine for WebClient is **Reactor Netty**. Reactor Netty is a library that wraps Netty so that Project Reactor's `Mono` and `Flux` types can be used naturally on top of it. Internally it creates twice as many event-loop threads as CPU cores and handles all socket I/O on those threads. In a blocking model one thread is tied up per request; in an event loop a thread can process other requests while waiting for an I/O completion event.

This structure is great for throughput, but running blocking code on an event-loop thread causes overall throughput to drop sharply. Doing anything that occupies a thread inside the reactive pipeline — `Thread.sleep`, JDBC calls, and the like — prevents that event-loop thread from processing all of its I/O. If you need such work, you must explicitly offload it to a dedicated thread pool with `subscribeOn(Schedulers.boundedElastic())`. The number of event-loop threads and selector threads can be customized through `ReactorResourceFactory`, which is designed to be shared as a single instance across the entire JVM process.

### Connection Pool Structure

The Reactor Netty connection pool is abstracted by `ConnectionProvider`. The default implementation is based on `FixedChannelPool` and exposes settings for maximum connections, pending queue size, and idle timeout. When a new request arrives with no free connection in the pool, it is queued; if the queue is also full, `PoolAcquireTimeoutException` is thrown. Leaving that exception unhandled causes the request to fail with an error, so it must be designed alongside retry logic.

Connections are reused for a period after creation. A connection left idle too long can be closed server-side first; if the client tries to reuse it without noticing the closure, a `Connection reset by peer` error occurs. To prevent this, set `maxIdleTime` shorter than the server's keep-alive timeout and use the `evictInBackground` option to periodically clean up idle connections.

### Request-Response Lifecycle

A WebClient request is assembled in the builder phase; execution is scheduled when you call `retrieve()` or `exchangeToMono()`. Once the subscription starts, a channel is acquired from the connection pool, the HTTP request is written to the channel, and when the server response arrives it is deserialized through the handler chain. This entire flow proceeds asynchronously inside the event loop.

```diagram
en/2026-09-19-f8fc1d22-02
```

The delay from subscription start to channel acquisition is governed by `pendingAcquireTimeout`; the delay from channel acquisition to response is controlled by `responseTimeout`. Conflating these two timeouts makes it hard to trace the root cause of an incident.

---

## Timeout Configuration In Depth

### Connect Timeout and Read/Write Timeouts

Timeouts configurable in WebClient fall into three broad layers. The first is the **channel (TCP) layer** connect timeout: the maximum time to wait for a SYN-ACK after sending a SYN packet to the server's TCP port. Set it with `HttpClient.create().option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)`. The second layer covers read and write timeouts — `ReadTimeoutHandler` and `WriteTimeoutHandler` — which fire after the channel is established when no I/O event occurs during data transfer. The third layer is the reactive pipeline's response timeout, which limits the total time from sending the request to receiving the entire response body.

The three timeouts operate independently. If the connection is established quickly but the server delivers the response body slowly, the connect timeout should not fire — the response timeout or read timeout should. Conversely, if TCP connection itself is delayed by DNS resolution lag or a firewall issue, the connect timeout is what you need. Separating timeouts by layer also means you can identify which stage introduced the delay from the log entry alone, which speeds up incident response.

| Timeout | Configuration layer | Trigger | Exception type |
|---|---|---|---|
| `CONNECT_TIMEOUT_MILLIS` | Netty channel option | TCP handshake delay | `ConnectTimeoutException` |
| `ReadTimeoutHandler` | Netty handler | No incoming data | `ReadTimeoutException` |
| `responseTimeout` | WebClient layer | Full response not received | `TimeoutException` |
| `pendingAcquireTimeout` | Connection pool | Pool wait exceeded | `PoolAcquireTimeoutException` |

### Response Timeout and Handshake Timeout

`responseTimeout` can be set at the instance level or overridden per individual request. The instance-level setting is `HttpClient.create().responseTimeout(Duration.ofSeconds(5))`; to apply a different value to a specific request, override `HttpClientRequest.responseTimeout` inside an `httpRequest` callback. This lets you share a single `WebClient` bean while applying an endpoint-specific timeout that matches each endpoint's SLA.

When using HTTPS, a TLS negotiation step is added. If the TLS handshake itself is slow, time is consumed before `responseTimeout` even starts, so aggressively leveraging TLS session resumption in high-load environments is an effective way to reduce negotiation time.

```diagram
en/2026-09-19-f8fc1d22-03
```

Each stage in the timeout chain is limited independently; the first timeout to expire terminates the entire request.

### Deciding Timeout Values

A common mistake when choosing timeout values is thinking "bigger is safer." An excessively large response timeout lets requests tied to slow external APIs hold connection pool resources for a long time, causing other healthy requests to pile up in the pending queue. Too small, and transient delays produce errors that degrade service quality.

The recommended approach is to collect P99 response times for the target API and set `responseTimeout` to 2–3× the P99. Set `pendingAcquireTimeout` shorter than `responseTimeout` so the system fails fast during pool exhaustion. The code below shows an example of explicitly configuring each timeout layer.

```java
// Set connect, read, and response timeouts on HttpClient by layer.
HttpClient httpClient = HttpClient.create()
    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3_000)   // TCP connect: max 3 s
    .responseTimeout(Duration.ofSeconds(10))                // response body: 10 s
    .doOnConnected(conn -> conn
        .addHandlerLast(new ReadTimeoutHandler(10, TimeUnit.SECONDS))   // detect no incoming data
        .addHandlerLast(new WriteTimeoutHandler(5, TimeUnit.SECONDS))   // detect send stalls
    );

WebClient webClient = WebClient.builder()
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

Separating timeouts by layer lets you identify which stage introduced the delay from the exception type alone, which accelerates incident response.

---

## Retry Strategy Design

### retryWhen and the Retry Spec

Retries in WebClient are expressed with Project Reactor's `retryWhen(Retry spec)` operator. `Retry.max(3)` is the simplest fixed-count retry, but consecutive retries risk amplifying server load. `Retry.backoff(3, Duration.ofMillis(200))` instead uses exponential backoff so the interval grows progressively. Adding `.jitter(0.5)` reduces thundering-herd problems that arise when multiple clients retry simultaneously.

`Retry.backoff` retries on all exceptions by default. This can apply retries to non-idempotent POST requests and produce unexpected side effects. A `.filter(e -> isRetryable(e))` condition is mandatory. As a general rule, retry on `ConnectTimeoutException`, `ReadTimeoutException`, and 5xx status codes; do not retry on 4xx client errors or business-level errors. Always set an upper bound for `maxAttempts` and `maxBackoff`; without them you can end up with near-infinite wait times in pathological cases.

### Retry Conditions Based on Idempotency

The criterion for deciding whether a retry is safe is **idempotency**. GET, HEAD, OPTIONS, PUT, and DELETE are idempotent HTTP methods, so retrying them does not change server state. POST is not idempotent; each retry may create a new resource. PATCH's idempotency depends on the design, so check the API spec. Incorrectly applying retries to POST endpoints that mutate data — external payment APIs, order creation, and so on — leads to serious problems like duplicate records.

When using retries together with timeouts, design the flow so the total elapsed time across all retry attempts does not exceed the upstream service's timeout. Three retries with a maximum backoff of 2 seconds can take more than 6 seconds in the worst case; if the upstream timeout is 5 seconds, the upstream request terminates before the retries finish.

```diagram
2026-09-19-f8fc1d22-04
```

Backoff retries proceed only when both the retry condition and idempotency are satisfied; if either condition fails, the request immediately moves to a failure state.

### Integration with Circuit Breaker

Retries alone have limits. When an external service is down for an extended period, retrying repeatedly has little chance of success and only wastes client resources. The Circuit Breaker pattern supplements this. Integrating Resilience4j with WebClient makes the circuit transition to Open when the error rate exceeds a threshold, then to Half-Open — allowing only a few requests through — after a configured wait time to confirm recovery.

When using retries and a Circuit Breaker together, the execution order must be clear. Placing the Circuit Breaker on the outside means it blocks retries immediately once the circuit opens. Placing retries on the outside means retries keep calling through the Circuit Breaker even when the circuit is open, wasting resources. Having the Circuit Breaker on the outside is generally better for reducing waste, and Resilience4j's `ExchangeFilterFunction` lets you insert it non-intrusively into the WebClient filter chain.

```java
// Insert a Resilience4j Circuit Breaker as a WebClient filter.
CircuitBreaker cb = CircuitBreaker.ofDefaults("externalApi");

ExchangeFilterFunction cbFilter = (request, next) ->
    Mono.defer(() -> next.exchange(request))
        .transformDeferred(CircuitBreakerOperator.of(cb));

WebClient webClient = WebClient.builder()
    .filter(cbFilter)
    .build();

// retryWhen is applied at subscription time — operates inside the Circuit Breaker
Mono<String> result = webClient.get()
    .uri("/api/resource")
    .retrieve()
    .bodyToMono(String.class)
    .retryWhen(Retry.backoff(3, Duration.ofMillis(200))
        .jitter(0.5)
        .filter(e -> e instanceof ConnectTimeoutException
                  || e instanceof ReadTimeoutException));
```

Because the Circuit Breaker wraps the outside of the filter chain, when the circuit opens it blocks the retry attempts themselves, preventing unnecessary calls.

---

## Connection Pool Tuning

### Pool Size and Queue Strategy

The default maximum connection count for `ConnectionProvider` is 500. That value is not always appropriate. You need to consider both the target server's maximum allowed concurrent connections and the client server's memory situation. Each connection holds a Netty channel object, read/write buffers, and a handler pipeline, so hundreds of connections can consume hundreds of megabytes of off-heap memory. A practical approach is to measure actual peak concurrency through load testing and set the pool size about 10–20% above that figure.

The pending queue size (`pendingAcquireMaxCount`) also matters. The default is `-1`, meaning unlimited. An unlimited queue means requests pile up when connections are scarce, then burst into large numbers of errors when they hit `pendingAcquireTimeout`, causing memory pressure too. Capping the queue at roughly twice `maxConnections` makes the system fail fast during traffic spikes so the upstream layer can handle it.

| Setting | Default | Tuning direction | Notes |
|---|---|---|---|
| `maxConnections` | 500 | 1.2× measured peak concurrency | Must not exceed server limit |
| `pendingAcquireMaxCount` | -1 (unlimited) | 2× maxConnections | Unlimited risks OOM |
| `pendingAcquireTimeout` | 45 s | Shorter than responseTimeout | Too short causes spike errors |
| `maxIdleTime` | none | 80% of server keep-alive | Too short wastes connections |
| `maxLifeTime` | none | Recommended in minutes | Prevents reuse of stale connections |

### Eviction and Resource Leaks

One of the most troublesome connection pool problems is **the client not noticing when the server closes a connection**. Most HTTP servers close connections after their `keep-alive timeout` expires. Nginx defaults to 75 seconds; Spring Boot's embedded Tomcat defaults to 60 seconds. If the client pool's `maxIdleTime` is set longer than those values, the client tries to reuse a connection the server has already closed, resulting in a `Connection reset by peer` error.

Setting `evictInBackground(Duration.ofSeconds(30))` causes a background thread to periodically remove invalid connections from the pool. With this enabled, connections that exceed `maxIdleTime` are cleaned up automatically, preventing resource leaks. A shorter eviction interval increases background thread activity, so 30–60 seconds is a reasonable range. Setting `maxLifeTime` alongside this periodically replaces old connections, which is also effective for TLS certificate renewals and load-balancer connection distribution.

```diagram
en/2026-09-19-f8fc1d22-05
```

Both idle time and maximum lifetime must be configured together for connections to be automatically replaced before the server closes them.

### Performance Measurement and Monitoring

Connection pool state can be monitored through Reactor Netty's metrics. Setting `ConnectionProvider.builder("my-pool").metrics(true).build()` exposes metrics via Micrometer. Key indicators are `reactor.netty.connection.provider.active.connections` (connections currently in use), `reactor.netty.connection.provider.idle.connections` (waiting connections), and `reactor.netty.connection.provider.pending.connections` (requests waiting for a pool slot). If active connections approach `maxConnections` while pending climbs, you need to either increase the pool size or improve the target API's response time.

```java
// Configure an independent connection pool and metrics per API.
ConnectionProvider provider = ConnectionProvider.builder("payment-api")
    .maxConnections(100)
    .pendingAcquireMaxCount(200)
    .pendingAcquireTimeout(Duration.ofSeconds(8))
    .maxIdleTime(Duration.ofSeconds(45))
    .maxLifeTime(Duration.ofMinutes(5))
    .evictInBackground(Duration.ofSeconds(30))
    .metrics(true)              // enable Micrometer metrics
    .build();

HttpClient httpClient = HttpClient.create(provider)
    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3_000)
    .responseTimeout(Duration.ofSeconds(10));

WebClient paymentClient = WebClient.builder()
    .baseUrl("https://payment.example.internal")
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

Separating `ConnectionProvider` per API means a payment API slowdown cannot affect another API's connection pool, achieving fault isolation.

---

## Production Considerations

### Common Mistakes and Pitfalls

The most frequent mistake is creating a new `WebClient` instance per request. Every call to `WebClient.builder().build()` internally creates a new `HttpClient` and a new `ConnectionProvider`. The connection pool is therefore re-initialized with every request and connections are never reused. `WebClient` is designed to be thread-safe, so register it as a bean and use it as a singleton. If you need a variant with extra headers for a specific request, use `webClient.mutate().defaultHeader(...).build()` to create a derived instance that reuses the existing pool.

The second pitfall is calling `.block()` from an event-loop thread. Calling `.block()` inside a WebFlux request handler can deadlock the event loop or trigger a `BlockingOperationError` warning. When `.block()` is unavoidable — in test code or batch processing — offload it via the `Schedulers.boundedElastic()` scheduler. The third pitfall is including deserialization errors (`JsonProcessingException`) in the retry target. These errors will not be resolved by calling the server again, so they must be explicitly excluded from the retry filter.

```diagram
en/2026-09-19-f8fc1d22-06
```

Any one of these three pitfalls leads to unexpected performance degradation or incidents.

### Metrics Collection and Debugging

In production, verifying that timeouts and retries behave correctly requires looking at both logs and metrics together. Setting `HttpClient.create().wiretap("reactor.netty.http.client.HttpClient", LogLevel.DEBUG, AdvancedByteBufFormat.TEXTUAL)` lets you output raw request and response content to logs. However, because this serializes all I/O to text, the performance impact in production is significant; enable it only temporarily during incident diagnosis.

For day-to-day observation, metrics collection through Micrometer is far more efficient. Adding `spring-boot-actuator` and `micrometer-registry-prometheus` exposes connection pool state, request latency, and error rates at the `/actuator/prometheus` endpoint. Displaying the P95 and P99 distribution of the `http.client.requests` metric on a Grafana dashboard lets you continuously validate whether timeout thresholds are appropriate. A timeout occurrence rate below 0.1% indicates the configuration is stable; above that, revisit the timeout values or the server's response performance.

### Scaling and Migration Strategy

For services that call multiple external APIs, it is recommended to configure a separate `ConnectionProvider` and `HttpClient` per API. Sharing a single pool means a slowdown in one API affects calls to other APIs. Separating the `WebClient` beans per API with `@Qualifier` limits the blast radius of pool exhaustion and enables independent metrics collection per API.

When migrating from RestTemplate to WebClient, a phased approach works well. First, wrap existing RestTemplate calls with `Mono.fromCallable(() -> restTemplate.getForObject(...)).subscribeOn(Schedulers.boundedElastic())` to bring blocking calls into the reactive pipeline. Once integration tests pass stably, replace with WebClient. Replacing everything at once risks discovering differences in timeout and retry behavior for the first time in production. During migration, running both clients in parallel and comparing error rates and response times is the safer approach.

---

## Closing Thoughts

### Key Summary

Stable production operation of Spring WebClient starts with the right combination of timeouts, retries, and connection pool settings. Timeouts are split across three stages — the channel layer, the HTTP layer, and the reactive pipeline layer — and each must be configured independently to identify the root cause of an incident quickly. Retries require idempotency checks and a backoff strategy, and placing the Circuit Breaker on the outside protects overall service stability. For the connection pool, the core practices are setting `maxIdleTime` in coordination with the server's keep-alive timeout and periodically clearing invalid connections with `evictInBackground`.

### When to Apply These Tunings

The right time to tune WebClient is clear. The signals are: external API response latency affecting overall service response time; `PoolAcquireTimeoutException` warnings about connection pool exhaustion; frequent manual retries due to intermittent connection errors. Simple internal microservice calls do not necessarily need a complex retry and Circuit Breaker setup. The tuning described here has the greatest impact on components that communicate with external third-party APIs, legacy systems with low SLAs, or services operating in unstable network environments. After any configuration change, always validate timeout occurrence rates and connection pool utilization through load testing, and maintain the habit of continuously observing production metrics — that is what builds long-term stability.
