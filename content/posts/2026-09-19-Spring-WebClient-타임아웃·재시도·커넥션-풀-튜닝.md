---
title: "Spring WebClient 타임아웃·재시도·커넥션 풀 튜닝"
date: "2026-09-19 07:18"
publishedAt: ""
category: "Spring"
tags: ["Spring WebClient", "Reactor Netty", "커넥션 풀", "재시도 전략", "Circuit Breaker"]
excerpt: "Spring WebClient는 Spring 5부터 도입된 논블로킹 HTTP 클라이언트로, 블로킹 I/O에 기반한 RestTemplate를 대체하는 표준 선택지가 되었습니다."
status: "draft"
---

## 목차

1. 개요
2. WebClient 내부 구조와 동작 원리
3. 타임아웃 설정 심화
4. 재시도 전략 설계
5. 커넥션 풀 튜닝
6. 운영 환경 고려사항
7. 맺음말

---

## 개요

### 문제 배경

Spring WebClient는 Spring 5부터 도입된 논블로킹 HTTP 클라이언트로, 블로킹 I/O에 기반한 RestTemplate를 대체하는 표준 선택지가 되었습니다. 이벤트 루프 기반의 비동기 처리 덕분에 동일한 스레드 수로도 더 많은 동시 요청을 처리할 수 있다는 점이 핵심 강점입니다. 그러나 기본 설정만으로 외부 API를 호출하면, 응답이 지연되거나 커넥션을 맺지 못하는 상황에서 요청이 무한정 대기하거나 커넥션 풀이 고갈되는 장애가 발생하기 쉽습니다. 이 글에서는 타임아웃, 재시도, 커넥션 풀 세 가지 축을 중심으로 운영 환경에서 적용할 수 있는 튜닝 방법을 설명합니다.

### 기존 방식의 한계

RestTemplate와 `HttpComponentsClientHttpRequestFactory`를 조합하던 방식은 직관적이었습니다. 소켓 타임아웃과 연결 타임아웃을 팩토리 레벨에서 한 번에 지정하고, Spring Retry의 `RetryTemplate`을 별도로 붙이는 패턴이 보편적이었습니다. 문제는 스레드 모델에 있습니다. 블로킹 I/O에서는 동시 요청이 늘어날수록 스레드 수를 함께 늘려야 하고, 수백 개의 스레드가 생성되면 컨텍스트 전환 비용이 처리량 향상을 상쇄합니다.

WebClient는 이 문제를 이벤트 루프 기반 I/O로 해결합니다. 그러나 그 대신 타임아웃 레이어가 채널 레벨·HTTP 레벨·리액티브 파이프라인 레벨로 분리되어 있어, 설정 지점을 정확히 이해하지 않으면 의도한 대로 동작하지 않습니다. 특히 기본 커넥션 풀 설정을 그대로 쓰면 타임아웃이 있어도 풀 대기 시간 때문에 실제 동작과 어긋나는 경우가 자주 생깁니다.

```diagram
2026-09-19-f8fc1d22-01
```

RestTemplate에서 WebClient로 전환할 때 단순히 API 호출 코드만 바꾸면 설정 레이어가 누락되기 쉽고, 이것이 운영 장애의 원인이 됩니다.

---

## WebClient 내부 구조와 동작 원리

### Reactor Netty와 이벤트 루프

WebClient의 기본 HTTP 엔진은 **Reactor Netty**입니다. Reactor Netty는 Netty 위에서 Project Reactor의 `Mono`·`Flux` 타입을 자연스럽게 사용할 수 있도록 래핑한 라이브러리입니다. 내부적으로는 CPU 코어 수의 두 배만큼 이벤트 루프 스레드를 생성하고, 모든 소켓 I/O를 이 스레드에서 처리합니다. 블로킹 모델이라면 요청 하나에 스레드 하나가 묶이지만, 이벤트 루프에서는 스레드가 I/O 완료 이벤트를 기다리는 동안 다른 요청을 처리할 수 있습니다.

이 구조가 성능에 유리하지만, 이벤트 루프 스레드에서 블로킹 코드를 실행하면 전체 처리량이 급격히 떨어집니다. 리액티브 파이프라인 안에서 `Thread.sleep`이나 JDBC 호출처럼 스레드를 점유하는 작업을 하면, 해당 이벤트 루프 스레드가 모든 I/O를 처리하지 못하는 상황이 됩니다. 이런 작업이 필요하다면 `subscribeOn(Schedulers.boundedElastic())`을 명시해 블로킹 작업을 전용 스레드 풀로 오프로드해야 합니다. 이벤트 루프의 스레드 수와 선택자 스레드 수는 `ReactorResourceFactory`를 통해 커스터마이징할 수 있으며, JVM 프로세스 전체에서 단일 인스턴스를 공유하도록 설계되어 있습니다.

### 커넥션 풀 구조

Reactor Netty의 커넥션 풀은 `ConnectionProvider`로 추상화됩니다. 기본 구현은 `FixedChannelPool`을 기반으로 하며, 최대 커넥션 수, 대기 큐 크기, 유휴 타임아웃 등을 설정할 수 있습니다. 풀에 여유 커넥션이 없을 때 새 요청이 들어오면 대기 큐에 쌓이고, 큐도 꽉 찬 상태라면 `PoolAcquireTimeoutException`이 발생합니다. 이 예외를 처리하지 않으면 요청이 에러로 떨어지므로 재시도 로직과 함께 설계해야 합니다.

커넥션은 생성된 후 일정 시간 동안 재사용됩니다. 유휴 상태로 너무 오래 방치된 커넥션은 서버 측에서 먼저 끊을 수 있는데, 클라이언트가 이를 인지하지 못한 채 요청을 보내면 `Connection reset by peer` 오류가 발생합니다. 이를 방지하려면 `maxIdleTime`을 서버의 keep-alive timeout보다 짧게 설정하고, `evictInBackground` 옵션으로 주기적으로 유휴 커넥션을 정리해야 합니다.

### 요청-응답 라이프사이클

WebClient의 요청은 빌더 단계에서 구성되고, `retrieve()` 또는 `exchangeToMono()`를 호출하는 시점에 실행이 예약됩니다. 실제 구독이 시작되면 커넥션 풀에서 채널을 획득하고, HTTP 요청을 채널에 써서 보낸 뒤, 서버 응답이 도착하면 핸들러 체인을 통해 역직렬화가 이루어집니다. 이 전체 흐름이 이벤트 루프 내에서 비동기로 진행됩니다.

```diagram
2026-09-19-f8fc1d22-02
```

구독 시작 이후 채널 획득까지의 지연이 `pendingAcquireTimeout`에 걸리며, 채널 획득 이후 응답까지의 지연은 `responseTimeout`으로 제어됩니다. 이 두 타임아웃을 구분하지 않으면 장애 원인 분석이 어려워집니다.

---

## 타임아웃 설정 심화

### 연결 타임아웃과 읽기·쓰기 타임아웃

WebClient에서 설정할 수 있는 타임아웃은 크게 세 레이어로 나뉩니다. 첫 번째는 **채널(TCP) 레이어**의 연결 타임아웃으로, 서버의 TCP 포트에 SYN 패킷을 보낸 후 SYN-ACK를 받기까지의 최대 대기 시간입니다. `HttpClient.create().option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3000)`으로 설정합니다. 두 번째는 읽기·쓰기 타임아웃으로, 채널이 맺어진 이후 데이터 전송 중에 아무런 I/O 이벤트가 없을 때 동작하는 `ReadTimeoutHandler`와 `WriteTimeoutHandler`입니다. 세 번째는 리액티브 파이프라인 레이어의 응답 타임아웃으로, 요청을 보낸 시점부터 전체 응답 본문을 받기까지의 시간을 제한합니다.

세 타임아웃은 각각 독립적으로 동작합니다. 연결은 빠르게 맺어졌지만 서버가 응답 본문을 천천히 보내는 경우에는 연결 타임아웃이 아니라 응답 타임아웃이나 읽기 타임아웃이 동작해야 합니다. 반대로 DNS 해석 지연이나 방화벽 문제로 TCP 연결 자체가 늦어지는 경우에는 연결 타임아웃이 필요합니다. 레이어별 타임아웃을 구분하면 장애 원인을 추적할 때도 어느 단계에서 지연이 발생했는지 로그만으로 즉시 파악할 수 있습니다.

| 타임아웃 종류 | 설정 레이어 | 발동 조건 | 예외 타입 |
|---|---|---|---|
| `CONNECT_TIMEOUT_MILLIS` | Netty 채널 옵션 | TCP 핸드셰이크 지연 | `ConnectTimeoutException` |
| `ReadTimeoutHandler` | Netty 핸들러 | 수신 데이터 무응답 | `ReadTimeoutException` |
| `responseTimeout` | WebClient 레이어 | 전체 응답 미도착 | `TimeoutException` |
| `pendingAcquireTimeout` | 커넥션 풀 | 풀 대기 초과 | `PoolAcquireTimeoutException` |

### 응답 타임아웃과 핸드셰이크 타임아웃

`responseTimeout`은 WebClient 인스턴스 레벨 또는 개별 요청 레벨 양쪽에서 설정할 수 있습니다. 인스턴스 레벨 설정은 `HttpClient.create().responseTimeout(Duration.ofSeconds(5))`로 지정하며, 특정 요청에만 다른 값을 적용하려면 `httpRequest` 콜백 안에서 `HttpClientRequest.responseTimeout`을 오버라이드합니다. 이렇게 하면 동일한 `WebClient` 빈을 공유하면서도 엔드포인트별로 SLA에 맞는 타임아웃을 적용할 수 있습니다.

HTTPS를 사용하는 경우 TLS 협상 단계가 추가됩니다. TLS 핸드셰이크 자체가 지연되면 `responseTimeout`이 아직 시작되지 않은 상태에서 시간이 소모되므로, 부하 환경에서는 TLS 세션 재사용(session resumption)을 적극적으로 활용해 협상 시간을 줄이는 것이 효과적입니다.

```diagram
2026-09-19-f8fc1d22-03
```

타임아웃 체인에서 각 단계는 독립적으로 제한되며, 가장 먼저 만료된 타임아웃이 전체 요청을 종료시킵니다.

### 타임아웃 값 결정 기준

타임아웃 값을 결정할 때 자주 나타나는 실수는 "충분히 크게 잡으면 안전하다"는 발상입니다. 응답 타임아웃이 지나치게 크면 느린 외부 API에 연결된 요청이 커넥션 풀 자원을 오래 점유하고, 그 결과 다른 정상적인 요청까지 풀 대기 큐에 쌓입니다. 반대로 너무 작으면 일시적인 지연에도 오류가 발생해 서비스 품질이 나빠집니다.

권장 접근은 연동 대상 API의 P99 응답 시간을 수집한 뒤 `responseTimeout`을 P99의 2~3배로 설정하는 것입니다. `pendingAcquireTimeout`은 `responseTimeout`보다 짧게 잡아 풀 고갈 시 빠르게 실패하도록 합니다. 아래 코드는 각 타임아웃 레이어를 명시적으로 구성하는 예시입니다.

```java
// HttpClient에 연결·읽기·응답 타임아웃을 레이어별로 설정합니다.
HttpClient httpClient = HttpClient.create()
    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3_000)   // TCP 연결 최대 3초
    .responseTimeout(Duration.ofSeconds(10))                // 응답 본문 수신까지 10초
    .doOnConnected(conn -> conn
        .addHandlerLast(new ReadTimeoutHandler(10, TimeUnit.SECONDS))   // 무응답 감지
        .addHandlerLast(new WriteTimeoutHandler(5, TimeUnit.SECONDS))   // 송신 지연 감지
    );

WebClient webClient = WebClient.builder()
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

레이어별 타임아웃을 분리하면 예외 타입만으로 어느 단계에서 지연이 발생했는지 즉시 파악할 수 있어 장애 대응 속도가 빨라집니다.

---

## 재시도 전략 설계

### retryWhen과 Retry 스펙

WebClient의 재시도는 Project Reactor의 `retryWhen(Retry spec)` 연산자로 표현합니다. 고정 횟수 재시도는 `Retry.max(3)`이 가장 간단하지만, 연속 재시도는 서버 부하를 증폭시키는 위험이 있습니다. 대신 `Retry.backoff(3, Duration.ofMillis(200))`을 사용하면 지수 백오프 방식으로 재시도 간격이 점진적으로 늘어납니다. `.jitter(0.5)` 옵션을 추가하면 여러 클라이언트가 동시에 재시도하는 상황에서 동기화로 인한 재부하(thundering herd) 문제를 줄일 수 있습니다.

`Retry.backoff`는 기본적으로 모든 예외에 대해 재시도를 시도합니다. 이는 멱등성이 없는 POST 요청에도 재시도가 적용될 수 있어 예상치 못한 부작용을 만들 수 있습니다. `.filter(e -> isRetryable(e))` 조건을 반드시 추가해야 하며, 일반적으로 `ConnectTimeoutException`, `ReadTimeoutException`, 5xx 상태 코드에 대해서는 재시도하고, 4xx 클라이언트 오류나 비즈니스 오류에는 재시도하지 않습니다. 최대 재시도 횟수(`maxAttempts`)와 최대 백오프 간격(`maxBackoff`)을 명시하지 않으면 잘못된 경우 무한에 가까운 대기 시간이 생길 수 있으므로 항상 상한선을 설정해야 합니다.

### 멱등성 기반 재시도 조건

재시도가 안전한지 판단하는 기준은 **멱등성**입니다. GET, HEAD, OPTIONS, PUT, DELETE는 멱등성을 가지는 HTTP 메서드이므로 재시도해도 서버 상태가 바뀌지 않습니다. 반면 POST는 멱등성이 없어 재시도마다 새로운 리소스가 생성될 수 있습니다. PATCH는 설계에 따라 멱등성이 달라지므로 API 명세를 확인해야 합니다. 외부 결제 API나 주문 생성처럼 데이터 변경이 수반되는 POST 엔드포인트에 재시도를 잘못 적용하면 중복 데이터가 생성되는 심각한 문제로 이어집니다.

재시도와 타임아웃을 함께 사용할 때는 전체 재시도 소요 시간이 상위 서비스의 타임아웃을 초과하지 않도록 설계해야 합니다. 3회 재시도에 최대 백오프가 2초라면 최악의 경우 약 6초 이상 소요될 수 있는데, 상위 서비스의 타임아웃이 5초라면 재시도 도중 상위 요청이 먼저 종료되는 상황이 됩니다.

```diagram
2026-09-19-f8fc1d22-04
```

재시도 가능 여부와 멱등성이 모두 충족될 때만 백오프 재시도를 진행하며, 조건이 하나라도 맞지 않으면 즉시 실패로 전환합니다.

### Circuit Breaker와의 연계

재시도 단독으로는 한계가 있습니다. 외부 서비스 자체가 장시간 다운된 경우 재시도를 계속해도 성공 가능성이 낮고, 클라이언트 리소스만 낭비됩니다. 이 상황에서 Circuit Breaker 패턴이 보완 역할을 합니다. Resilience4j를 WebClient와 연계하면 일정 비율 이상 오류가 발생했을 때 차단 상태(Open)로 전환하고, 설정된 대기 시간 이후 일부 요청만 허용하는 반열림(Half-Open) 상태를 거쳐 복구를 확인합니다.

재시도와 Circuit Breaker를 함께 사용할 때는 실행 순서를 명확히 해야 합니다. Circuit Breaker를 바깥에 배치하면 회로가 열린 즉시 재시도 없이 차단합니다. 반대로 재시도가 바깥에 있으면, 회로가 열려 있을 때도 재시도가 Circuit Breaker 호출을 반복해 리소스를 낭비합니다. 일반적으로 Circuit Breaker를 바깥에 두는 방식이 리소스 낭비를 줄이는 데 유리하며, Resilience4j의 `ExchangeFilterFunction`을 통해 WebClient 필터 체인에 비침투적으로 삽입할 수 있습니다.

```java
// Resilience4j Circuit Breaker를 WebClient 필터로 삽입합니다.
CircuitBreaker cb = CircuitBreaker.ofDefaults("externalApi");

ExchangeFilterFunction cbFilter = (request, next) ->
    Mono.defer(() -> next.exchange(request))
        .transformDeferred(CircuitBreakerOperator.of(cb));

WebClient webClient = WebClient.builder()
    .filter(cbFilter)
    .build();

// retryWhen은 별도 구독 시점에 적용 — Circuit Breaker 안쪽에서 동작
Mono<String> result = webClient.get()
    .uri("/api/resource")
    .retrieve()
    .bodyToMono(String.class)
    .retryWhen(Retry.backoff(3, Duration.ofMillis(200))
        .jitter(0.5)
        .filter(e -> e instanceof ConnectTimeoutException
                  || e instanceof ReadTimeoutException));
```

Circuit Breaker가 필터 체인 바깥을 감싸므로, 회로가 열리면 재시도 시도 자체를 차단해 불필요한 호출을 막습니다.

---

## 커넥션 풀 튜닝

### 풀 사이즈와 큐 전략

`ConnectionProvider`의 기본 최대 커넥션 수는 500입니다. 이 값이 항상 적절한 것은 아닙니다. 연동 대상 서버의 최대 허용 동시 커넥션 수와 클라이언트 서버의 메모리 상황을 함께 고려해야 합니다. 커넥션 하나는 Netty 채널 객체와 읽기·쓰기 버퍼, 핸들러 파이프라인을 포함하기 때문에 수백 개의 커넥션이 쌓이면 수백 MB의 힙 외부(off-heap) 메모리를 소비할 수 있습니다. 부하 테스트를 통해 실제 최대 동시 요청 수를 측정한 뒤, 그 값의 10~20% 여유를 두고 설정하는 것이 실용적입니다.

대기 큐(`pendingAcquireMaxCount`) 크기도 중요합니다. 기본값은 `-1`, 즉 무제한입니다. 큐가 무제한이면 커넥션이 부족한 상황에서 요청들이 큐에 쌓이다가 `pendingAcquireTimeout`에 걸려 다량의 에러가 터지고, 메모리 압박까지 발생할 수 있습니다. 큐 크기를 최대 커넥션의 2배 정도로 제한하면 트래픽 스파이크 시 빠르게 실패해 상위 레이어에서 처리할 수 있습니다.

| 설정 항목 | 기본값 | 조정 방향 | 주의점 |
|---|---|---|---|
| `maxConnections` | 500 | 실측 동시 요청의 1.2배 | 서버 허용치 초과 금지 |
| `pendingAcquireMaxCount` | -1 (무제한) | maxConnections의 2배 | 무제한이면 OOM 위험 |
| `pendingAcquireTimeout` | 45초 | responseTimeout보다 짧게 | 너무 짧으면 스파이크 시 오류 |
| `maxIdleTime` | 없음 | 서버 keep-alive의 80% | 너무 짧으면 커넥션 낭비 |
| `maxLifeTime` | 없음 | 수 분 단위 권장 | 오래된 커넥션 재사용 방지 |

### Eviction과 리소스 누수

커넥션 풀에서 가장 골치 아픈 문제 중 하나는 **서버 측 연결 종료를 클라이언트가 인지하지 못하는 경우**입니다. 대부분의 HTTP 서버는 `keep-alive timeout`이 지나면 연결을 닫습니다. Nginx의 기본값은 75초이고, Spring Boot 내장 Tomcat의 기본값은 60초입니다. 클라이언트 풀의 `maxIdleTime`을 이보다 길게 설정하면, 서버가 이미 닫은 커넥션을 클라이언트가 재사용하려 시도하고 `Connection reset by peer` 오류가 발생합니다.

`evictInBackground(Duration.ofSeconds(30))`을 설정하면 백그라운드 스레드가 주기적으로 유효하지 않은 커넥션을 풀에서 제거합니다. 이 기능을 켜면 `maxIdleTime` 초과 커넥션이 자동으로 정리되어 리소스 누수를 방지할 수 있습니다. eviction 주기가 짧을수록 스레드 활동이 늘어나므로 30~60초 범위가 적당합니다. `maxLifeTime`을 함께 설정하면 오래된 커넥션을 주기적으로 교체해 TLS 인증서 갱신이나 로드밸런서 연결 분산에도 효과적입니다.

```diagram
2026-09-19-f8fc1d22-05
```

유휴 시간과 최대 수명을 함께 설정해야 서버 측 종료 전에 커넥션이 자동으로 교체됩니다.

### 성능 측정과 모니터링

커넥션 풀 상태는 Reactor Netty의 메트릭을 통해 확인할 수 있습니다. `ConnectionProvider.builder("my-pool").metrics(true).build()`를 설정하면 Micrometer로 메트릭이 노출됩니다. 주요 지표는 `reactor.netty.connection.provider.active.connections`(현재 사용 중인 커넥션), `reactor.netty.connection.provider.idle.connections`(대기 커넥션), `reactor.netty.connection.provider.pending.connections`(풀 대기 요청 수)입니다. active 커넥션이 `maxConnections`에 가까워지고 pending이 높아지면 풀 크기를 늘리거나 연동 대상 API의 응답 시간을 개선해야 합니다.

```java
// API별로 독립된 커넥션 풀과 메트릭을 구성합니다.
ConnectionProvider provider = ConnectionProvider.builder("payment-api")
    .maxConnections(100)
    .pendingAcquireMaxCount(200)
    .pendingAcquireTimeout(Duration.ofSeconds(8))
    .maxIdleTime(Duration.ofSeconds(45))
    .maxLifeTime(Duration.ofMinutes(5))
    .evictInBackground(Duration.ofSeconds(30))
    .metrics(true)              // Micrometer 메트릭 활성화
    .build();

HttpClient httpClient = HttpClient.create(provider)
    .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 3_000)
    .responseTimeout(Duration.ofSeconds(10));

WebClient paymentClient = WebClient.builder()
    .baseUrl("https://payment.example.internal")
    .clientConnector(new ReactorClientHttpConnector(httpClient))
    .build();
```

API별로 `ConnectionProvider`를 분리하면 결제 API 지연이 다른 API 커넥션 풀에 영향을 주지 않아 장애 격리 효과를 얻을 수 있습니다.

---

## 운영 환경 고려사항

### 흔한 실수와 함정

가장 자주 발생하는 실수는 `WebClient` 인스턴스를 요청마다 새로 생성하는 것입니다. `WebClient.builder().build()`를 호출할 때마다 내부적으로 새 `HttpClient`와 새 `ConnectionProvider`가 생성됩니다. 즉, 커넥션 풀이 요청마다 초기화되어 커넥션 재사용이 전혀 이루어지지 않습니다. `WebClient` 인스턴스는 스레드 안전하도록 설계되어 있으므로 빈(Bean)으로 등록해 싱글턴으로 사용해야 합니다. 특정 요청에만 헤더를 추가하는 등의 변형이 필요하다면 `webClient.mutate().defaultHeader(...).build()`를 통해 기존 풀을 재사용하는 파생 인스턴스를 만드는 방식을 써야 합니다.

두 번째 함정은 `.block()` 사용 시 이벤트 루프 스레드에서 호출하는 것입니다. WebFlux 요청 핸들러 내에서 `.block()`을 호출하면 이벤트 루프가 교착 상태에 빠지거나 `BlockingOperationError` 경고가 발생합니다. 테스트 코드나 배치 처리 등 `.block()`이 반드시 필요한 경우라면 `Schedulers.boundedElastic()` 스케줄러로 오프로드해야 합니다. 세 번째 함정은 재시도 대상에 역직렬화 오류(`JsonProcessingException`)를 포함시키는 것입니다. 이 오류는 서버를 다시 호출해도 해결되지 않으므로 재시도 필터에서 반드시 제외해야 합니다.

```diagram
2026-09-19-f8fc1d22-06
```

세 가지 함정 중 하나라도 해당되면 예상치 못한 성능 저하나 장애로 이어집니다.

### 메트릭 수집과 디버깅

운영 환경에서 타임아웃과 재시도가 제대로 동작하는지 확인하려면 로그와 메트릭을 함께 봐야 합니다. `HttpClient.create().wiretap("reactor.netty.http.client.HttpClient", LogLevel.DEBUG, AdvancedByteBufFormat.TEXTUAL)`을 설정하면 요청·응답 원문을 로그로 출력할 수 있습니다. 그러나 이 설정은 모든 I/O를 텍스트로 직렬화하기 때문에 운영 환경에서는 성능 영향이 크며, 장애 진단 시에만 일시적으로 켜야 합니다.

평상시에는 Micrometer를 통한 메트릭 수집이 훨씬 효율적입니다. `spring-boot-actuator`와 `micrometer-registry-prometheus`를 추가하면 `/actuator/prometheus` 엔드포인트에서 커넥션 풀 상태, 요청 지연 시간, 오류율을 확인할 수 있습니다. `http.client.requests` 메트릭의 P95·P99 분포를 Grafana 대시보드에 표시하면 타임아웃 임계값이 적절한지 지속적으로 검증할 수 있습니다. 타임아웃 발생률이 0.1% 미만이면 설정이 안정적이라고 볼 수 있으며, 그 이상이면 타임아웃 값이나 서버 응답 성능을 재검토해야 합니다.

### 확장과 마이그레이션 전략

여러 외부 API를 호출하는 서비스라면 API별로 별도의 `ConnectionProvider`와 `HttpClient`를 구성하는 것을 권장합니다. 하나의 풀을 공유하면 특정 API의 지연이 다른 API 호출까지 영향을 미칩니다. API별 `WebClient` 빈을 `@Qualifier`로 분리하면 풀 고갈의 파급 범위를 제한하고 API별 메트릭도 독립적으로 수집할 수 있습니다.

RestTemplate에서 WebClient로 마이그레이션할 때는 단계별 접근이 효과적입니다. 먼저 기존 RestTemplate 호출 주변에 `Mono.fromCallable(() -> restTemplate.getForObject(...)).subscribeOn(Schedulers.boundedElastic())`을 감싸서 블로킹 호출을 리액티브 파이프라인에 편입시킵니다. 이후 안정적으로 통합 테스트를 통과하면 WebClient로 교체합니다. 한 번에 전체를 교체하면 타임아웃·재시도 동작의 차이를 운영에서 처음 발견하는 위험이 있습니다. 마이그레이션 중에는 두 클라이언트를 병행 운영하면서 오류율과 응답 시간을 비교하는 것이 안전합니다.

---

## 맺음말

### 핵심 요약

Spring WebClient의 안정적인 운영은 타임아웃, 재시도, 커넥션 풀 세 영역의 올바른 조합에서 시작됩니다. 타임아웃은 채널 레이어·HTTP 레이어·리액티브 파이프라인 레이어 세 단계로 분리되어 있으며, 각 단계를 독립적으로 설정해야 장애 원인을 신속하게 파악할 수 있습니다. 재시도는 멱등성 검사와 백오프 전략이 필수이며, Circuit Breaker를 바깥에 배치해 서비스 전체 안정성을 보호해야 합니다. 커넥션 풀은 서버의 keep-alive timeout과 연계해 `maxIdleTime`을 적절히 설정하고, `evictInBackground`로 유효하지 않은 커넥션을 주기적으로 정리하는 것이 핵심입니다.

### 적용 판단 기준

WebClient 튜닝이 필요한 시점은 분명합니다. 외부 API 응답 지연이 서비스 전체 응답 시간에 영향을 줄 때, 커넥션 풀 고갈 경고(`PoolAcquireTimeoutException`)가 발생할 때, 간헐적 연결 오류로 인해 수동 재요청이 빈번할 때가 그 신호입니다. 단순한 내부 마이크로서비스 호출에 복잡한 재시도·Circuit Breaker 체계가 반드시 필요한 것은 아닙니다. 외부 서드파티 API, SLA가 낮은 레거시 시스템, 네트워크가 불안정한 환경과 통신하는 컴포넌트일수록 이 글에서 다룬 튜닝의 효과가 큽니다. 설정 변경 후에는 반드시 부하 테스트를 통해 타임아웃 발생률과 커넥션 풀 사용률을 검증해야 하며, 운영 지표를 지속적으로 관찰하는 습관이 장기적인 안정성을 만들어 줍니다.
