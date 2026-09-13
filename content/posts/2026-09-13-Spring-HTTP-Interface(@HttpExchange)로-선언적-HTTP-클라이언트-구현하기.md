---
title: "Spring HTTP Interface(@HttpExchange)로 선언적 HTTP 클라이언트 구현하기"
date: "2026-09-13 07:10"
publishedAt: ""
category: "Spring"
tags: ["Spring HTTP Interface(@HttpExchange)로 선언적 HTTP 클라이언트 구현하기", "Spring", "HTTP", "Interface", "HttpExchange"]
excerpt: "마이크로서비스 아키텍처가 일반화되면서 서비스 간 HTTP 통신은 현대 Spring 애플리케이션의 핵심 과제가 되었습니다. Spring HTTP Interface는 Spring 6.0(Spring Boot 3."
status: "draft"
---

## 목차

1. 개요
2. @HttpExchange의 핵심 개념과 동작 원리
3. 기본 구현 — 인터페이스 정의부터 빈 등록까지
4. 심화 활용 — 인증·에러 처리·재시도
5. RestTemplate·WebClient와의 비교 분석
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경

마이크로서비스 아키텍처가 일반화되면서 서비스 간 HTTP 통신은 현대 Spring 애플리케이션의 핵심 과제가 되었습니다. Spring HTTP Interface는 Spring 6.0(Spring Boot 3.0)에서 공식 도입된 **선언적 HTTP 클라이언트** 방식으로, 인터페이스에 어노테이션만 선언하면 실제 HTTP 호출 로직을 프레임워크가 자동으로 생성합니다. `@HttpExchange`를 중심으로 한 이 메커니즘은 Feign Client에서 영감을 받아 Spring 생태계에 자연스럽게 녹아든 방식이며, 별도 라이브러리 없이 WebClient 기반으로 동작합니다. 이 글에서는 `@HttpExchange`의 동작 원리부터 실제 프로젝트 적용 패턴, 그리고 운영 환경에서 마주치는 트레이드오프까지 체계적으로 살펴봅니다.

### 기존 방식의 한계

Spring에서 HTTP 클라이언트를 구현하는 전통적인 방법은 크게 두 가지로 나뉩니다. `RestTemplate`은 동기 방식의 간결한 API를 제공하지만, Spring 5.0 이후 공식적으로 유지 보수 모드(maintenance mode)로 전환되어 신규 기능 추가가 없는 상태입니다. `WebClient`는 리액티브 스트림을 기반으로 하는 강력한 클라이언트지만, 메서드 체이닝 방식의 플루언트 API는 호출 코드가 길어지고 가독성이 떨어진다는 현장의 피드백이 꾸준히 있었습니다.

> **핵심 문제**: 외부 API 호출 코드가 비즈니스 로직과 뒤섞여 서비스 클래스가 비대해지고, 각 엔드포인트마다 반복적인 설정 코드가 중복됩니다.

OpenFeign은 이 문제를 인터페이스 선언만으로 해결했지만, Spring Cloud 의존성이 필요하고 내부적으로 동기 호출만 지원한다는 한계가 있었습니다. `@HttpExchange`는 이 격차를 Spring 표준 스펙으로 채우면서, 동기·비동기·리액티브 방식을 모두 지원하는 통합 솔루션을 제시합니다.

---

## @HttpExchange의 핵심 개념과 동작 원리

### 선언적 클라이언트 패턴이란

선언적 HTTP 클라이언트 패턴의 핵심은 "**어떻게 호출하느냐**" 대신 "**무엇을 호출하느냐**"를 코드로 표현하는 것입니다. 개발자는 HTTP 요청의 URL, 메서드, 헤더, 파라미터를 어노테이션으로 선언하고, 실제 네트워크 연결 관리·직렬화·역직렬화·오류 처리 같은 저수준 관심사는 프레임워크에 위임합니다. 이 방식은 인터페이스가 곧 API 계약서 역할을 하기 때문에 코드 가독성이 높아지고, 테스트 시에는 인터페이스를 Mockito나 MockServer로 대체하기 쉬워집니다.

Spring은 `HttpServiceProxyFactory`를 통해 런타임에 인터페이스의 프록시 구현체를 생성합니다. 이 프록시는 메서드 호출을 가로채 어노테이션 메타데이터를 분석하고, 실제 HTTP 요청을 구성하여 등록된 클라이언트(`WebClient` 또는 `RestClient`)로 전달합니다.

```
[인터페이스 정의]
   │  @HttpExchange("/users")
   │  @GetExchange("/{id}")
   │  User findById(@PathVariable Long id);
   ▼
[HttpServiceProxyFactory]
   │  → 프록시 생성 (런타임)
   │  → 메서드 인터셉트
   │  → HttpRequestValues 구성
   ▼
[WebClient / RestClient]
   │  → 실제 HTTP GET /users/42
   ▼
[외부 서비스]
   └  응답 → 역직렬화 → User 반환
```

### 주요 어노테이션 구성

`@HttpExchange`는 클래스 또는 메서드 수준에서 사용할 수 있으며, 클래스에 선언하면 하위 모든 메서드의 공통 경로·헤더·콘텐츠 타입이 됩니다.

| 어노테이션 | HTTP 메서드 | 사용 위치 | 주요 속성 |
|---|---|---|---|
| `@HttpExchange` | 미지정(범용) | 클래스/메서드 | url, method, contentType, accept |
| `@GetExchange` | GET | 메서드 | url |
| `@PostExchange` | POST | 메서드 | url, contentType |
| `@PutExchange` | PUT | 메서드 | url |
| `@PatchExchange` | PATCH | 메서드 | url |
| `@DeleteExchange` | DELETE | 메서드 | url |

메서드 파라미터 어노테이션은 `@PathVariable`, `@RequestParam`, `@RequestHeader`, `@RequestBody`, `@CookieValue`를 그대로 활용합니다. Spring MVC에서 사용하던 어노테이션과 이름이 동일하여 학습 부담이 낮습니다.

### 내부 동작 메커니즘

`HttpServiceProxyFactory`는 내부적으로 `HttpServiceArgumentResolver` 목록을 순서대로 순회하면서 각 메서드 파라미터를 `HttpRequestValues.Builder`에 적용합니다. 이 빌더가 완성되면 등록된 `HttpExchangeAdapter`(WebClient 어댑터 또는 RestClient 어댑터)가 실제 요청 객체로 변환하여 전송합니다.

리턴 타입에 따라 처리 경로가 달라지는 점도 중요합니다. `Mono<T>`, `Flux<T>` 같은 리액티브 타입을 반환하면 논블로킹 스트림으로 처리되고, `ResponseEntity<T>`, `HttpHeaders`, 일반 객체를 반환하면 내부적으로 블로킹 구독이 발생합니다.

> **주의**: WebClient 기반에서 일반 객체를 반환 타입으로 쓰면 내부적으로 `.block()`이 호출됩니다. 리액티브 컨텍스트에서는 반드시 `Mono<T>` 또는 `Flux<T>`를 반환 타입으로 선언해야 합니다.

---

## 기본 구현 — 인터페이스 정의부터 빈 등록까지

### 의존성과 환경 설정

Spring Boot 3.x 프로젝트라면 `spring-boot-starter-webflux` 의존성 하나로 `WebClient`와 `@HttpExchange`를 함께 사용할 수 있습니다. 리액티브 스택이 부담스럽다면 Spring Boot 3.2부터 도입된 `RestClient` 어댑터를 사용하는 방법도 있습니다. `RestClient`는 동기 방식이며 `spring-boot-starter-web` 의존성만으로 사용 가능합니다. 두 어댑터 모두 같은 `@HttpExchange` 인터페이스를 재사용할 수 있으므로, 어댑터 교체가 인터페이스 코드에 영향을 주지 않습니다.

환경 설정은 별도의 `@Configuration` 클래스에서 `HttpServiceProxyFactory`를 빈으로 등록하거나, 각 클라이언트 인터페이스별 빈을 직접 정의하는 방식을 주로 사용합니다. 후자가 더 명시적이고 테스트하기 쉬워 현업에서는 선호되는 패턴입니다.

| 의존성 | 어댑터 | 방식 | Spring Boot 버전 |
|---|---|---|---|
| spring-boot-starter-webflux | WebClientAdapter | 비동기/리액티브 | 3.0+ |
| spring-boot-starter-web | RestClientAdapter | 동기 | 3.2+ |
| 둘 다 | 선택 가능 | 혼합 | 3.2+ |

### 인터페이스 정의와 클라이언트 빈 등록

실제 외부 API를 호출하는 시나리오를 기준으로 구현 예시를 살펴봅니다. 아래는 공개 REST API를 대상으로 사용자 정보를 조회하고 생성하는 클라이언트 인터페이스입니다.

```java
// UserApiClient.java — 클라이언트 인터페이스 선언
@HttpExchange("/users")
public interface UserApiClient {

    @GetExchange
    List<UserResponse> findAll(@RequestParam("page") int page);

    @GetExchange("/{id}")
    UserResponse findById(@PathVariable("id") Long id);

    @PostExchange(contentType = MediaType.APPLICATION_JSON_VALUE)
    ResponseEntity<UserResponse> create(@RequestBody UserCreateRequest request);

    @DeleteExchange("/{id}")
    void deleteById(@PathVariable("id") Long id);
}

// UserClientConfig.java — 빈 등록
@Configuration
public class UserClientConfig {

    @Bean
    public UserApiClient userApiClient(WebClient.Builder builder) {
        WebClient webClient = builder
            .baseUrl("https://jsonplaceholder.typicode.com")
            .defaultHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE)
            .build();

        HttpServiceProxyFactory factory = HttpServiceProxyFactory
            .builderFor(WebClientAdapter.create(webClient))
            .build();

        return factory.createClient(UserApiClient.class);
        // 반환된 객체는 런타임 프록시이며, Spring 컨테이너가 관리합니다
    }
}
```

빈 등록 시 `WebClient.Builder`를 주입받는 것이 중요합니다. Spring Boot가 자동 구성하는 `WebClient.Builder`에는 메트릭 수집, 로깅 필터 같은 공통 설정이 이미 적용되어 있기 때문입니다. `WebClient.create()`를 직접 호출하면 이 자동 구성 혜택을 받지 못합니다.

### 요청/응답 처리 패턴

등록된 클라이언트 빈은 서비스 클래스에서 일반 Spring 빈처럼 주입받아 사용합니다. 반환 타입에 따라 동기·비동기 처리 경로가 자동으로 분기되므로, 인터페이스 메서드의 반환 타입 선언이 중요한 설계 결정입니다.

| 반환 타입 | 동작 방식 | 언제 사용하나 | 주의점 |
|---|---|---|---|
| `T` (일반 객체) | 내부적으로 block() 호출 | MVC 환경, 단순 동기 호출 | 리액티브 컨텍스트에서 사용 금지 |
| `ResponseEntity<T>` | block() + 응답 헤더 포함 | HTTP 상태 코드·헤더가 필요할 때 | 동일하게 블로킹 |
| `Mono<T>` | 논블로킹, 구독 전 실행 안 됨 | WebFlux, 비동기 처리 | 반드시 구독 필요 |
| `Flux<T>` | 스트리밍, 다건 응답 | 대용량 응답, SSE | 배압(Backpressure) 고려 필요 |
| `void` | 응답 본문 무시 | DELETE 등 본문이 없는 요청 | 오류 응답도 무시됨에 주의 |

---

## 심화 활용 — 인증·에러 처리·재시도

### 인터셉터와 인증 헤더 처리

실제 외부 API 호출에서는 JWT Bearer 토큰, API Key, OAuth2 액세스 토큰 같은 인증 정보를 모든 요청 헤더에 포함해야 합니다. `@HttpExchange` 인터페이스에서 인증 헤더를 다루는 방법은 크게 세 가지입니다.

첫 번째는 `@RequestHeader`를 메서드 파라미터로 선언하는 방식입니다. 간단하지만 모든 메서드에 파라미터가 추가되어 인터페이스가 지저분해집니다. 두 번째는 `WebClient.Builder`의 `defaultHeader()`로 고정 헤더를 등록하는 방식입니다. API Key처럼 고정된 값에 적합하지만, 만료가 있는 토큰에는 사용할 수 없습니다. 세 번째이자 권장 방식은 `ExchangeFilterFunction`으로 동적 인증 헤더를 처리하는 것입니다.

```java
// 동적 토큰 처리를 위한 ExchangeFilterFunction
@Bean
public WebClient webClientWithAuth(WebClient.Builder builder,
                                    TokenProvider tokenProvider) {
    ExchangeFilterFunction authFilter = ExchangeFilterFunction
        .ofRequestProcessor(request -> {
            String token = tokenProvider.getAccessToken(); // 매 요청마다 토큰 조회
            ClientRequest authenticated = ClientRequest.from(request)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .build();
            return Mono.just(authenticated);
            // 토큰이 만료된 경우 여기서 갱신 로직을 추가할 수 있습니다
        });

    return builder
        .baseUrl("https://api.example.com")
        .filter(authFilter)
        .build();
}
```

이 방식은 토큰 갱신 로직을 한 곳에 집중시키고 인터페이스를 인증 관심사에서 분리합니다. OAuth2 환경에서는 `ServerOAuth2AuthorizedClientExchangeFilterFunction`을 활용하면 토큰 갱신까지 자동으로 처리할 수 있습니다.

### 에러 응답 처리 전략

`@HttpExchange`는 기본적으로 4xx, 5xx 응답을 `WebClientResponseException` 계열 예외로 변환합니다. 그러나 외부 API가 반환하는 에러 응답 본문에는 상세한 오류 코드와 메시지가 담겨 있는 경우가 많고, 이를 파싱하여 도메인 예외로 변환하는 것이 일반적인 설계입니다.

`WebClient.Builder`에 `defaultStatusHandler()`를 등록하거나, `onStatus()` 연산자를 통해 상태 코드별 예외 변환 로직을 적용합니다. 이 처리는 `ExchangeFilterFunction`과 동일하게 `WebClient` 수준에서 적용되므로, 인터페이스 메서드마다 예외 처리 코드를 반복하지 않아도 됩니다.

```
[외부 API 응답]
     │
     ├─ 200 OK          → 정상 역직렬화
     ├─ 400 Bad Request → ClientErrorException (요청 파라미터 오류)
     ├─ 401/403         → AuthenticationException (인증/인가 실패)
     ├─ 404 Not Found   → ResourceNotFoundException (리소스 없음)
     ├─ 429             → RateLimitException (요청 한도 초과)
     └─ 5xx             → ExternalServiceException (외부 서비스 장애)
```

에러 응답 처리 시 가장 흔히 놓치는 부분은 **에러 응답 본문 소비**입니다. `WebClientResponseException`에서 `getResponseBodyAs(ErrorResponse.class)`를 호출하면 에러 본문을 원하는 타입으로 역직렬화할 수 있습니다. 본문을 소비하지 않으면 커넥션 풀 누수로 이어질 수 있으므로 반드시 에러 응답 본문을 읽거나 명시적으로 폐기해야 합니다.

### 재시도와 타임아웃 설정

외부 API 호출에서 일시적인 네트워크 오류나 5xx 응답은 재시도(Retry)로 복구할 수 있는 경우가 많습니다. `WebClient` 기반에서는 Reactor의 `retryWhen()`을 활용하되, `@HttpExchange` 인터페이스에서는 직접 연산자를 체이닝할 수 없으므로 서비스 레이어에서 Reactor 연산자를 적용하거나, Resilience4j를 통해 인터페이스 빈에 AOP로 재시도 정책을 주입하는 패턴을 사용합니다.

| 전략 | 구현 방법 | 장점 | 단점 |
|---|---|---|---|
| Reactor retryWhen | 서비스 레이어에서 Mono.retryWhen() | 세밀한 제어 가능 | 인터페이스 재사용성 저하 |
| Resilience4j @Retry | AOP 기반, 어노테이션 선언 | 인터페이스 비침투적 | Resilience4j 의존성 필요 |
| Spring Retry | @Retryable + @EnableRetry | 동기 방식 친화적 | 비동기 환경에서 동작 방식 주의 필요 |
| WebClient filter | ExchangeFilterFunction 내부 구현 | 투명하게 모든 요청에 적용 | 복잡한 재시도 로직 구현 어려움 |

타임아웃은 반드시 두 단계에서 설정해야 합니다. `WebClient`의 기반이 되는 Reactor Netty 수준에서 `connectTimeout`과 `readTimeout`을 설정하고, 리액티브 파이프라인에서 `timeout(Duration)` 연산자로 응답 대기 시간을 제한합니다. 두 설정이 모두 없으면 외부 서비스 장애 시 스레드 또는 커넥션이 무기한 대기 상태가 됩니다.

---

## RestTemplate·WebClient와의 비교 분석

### 성능 특성과 리액티브 지원

`@HttpExchange`는 새로운 HTTP 클라이언트가 아니라 기존 클라이언트(`WebClient` 또는 `RestClient`) 위에 선언적 레이어를 추가한 추상화입니다. 따라서 성능 특성은 사용하는 어댑터에 따라 결정됩니다. WebClient 어댑터를 사용하는 경우 Reactor Netty 기반의 이벤트 루프 모델로 동작하여 높은 동시성 환경에서 스레드 효율이 뛰어납니다. RestClient 어댑터는 Apache HttpClient 5나 JDK HttpClient 위에서 동기 방식으로 동작합니다.

```
처리량 (동시 요청 100개 기준, 대략적 경향)

RestTemplate (스레드풀 블로킹)
  ████████░░░░░░░░░░░░  처리량 낮음, 스레드 소모 높음

RestClient (@HttpExchange 동기)
  ████████░░░░░░░░░░░░  RestTemplate과 유사

WebClient (논블로킹)
  ██████████████████░░  처리량 높음, 스레드 효율 우수

@HttpExchange + WebClient
  ██████████████████░░  WebClient와 동일 (추상화 오버헤드 미미)
```

벤치마크 수치는 실제 프로젝트의 네트워크 지연, 페이로드 크기, JVM 설정에 따라 크게 달라지므로 절대적인 수치보다는 경향으로 이해하는 것이 적절합니다. `@HttpExchange`가 추가하는 리플렉션 기반 프록시 오버헤드는 실측 환경에서 무시할 수 있는 수준(< 1%)입니다.

### 적용 시나리오별 선택 기준

세 가지 방식 중 어떤 것을 선택할지는 팀의 기술 스택, 애플리케이션 특성, 외부 API 수에 따라 달라집니다.

| 시나리오 | 권장 방식 | 이유 |
|---|---|---|
| Spring MVC + 단순 외부 API 1-2개 | @HttpExchange + RestClient | 동기 방식 친화적, 코드 간결 |
| Spring MVC + 다수 외부 API | @HttpExchange + RestClient | 인터페이스별 API 계약 명확화 |
| Spring WebFlux + 고동시성 | @HttpExchange + WebClient | 논블로킹 일관성 유지 |
| 레거시 코드베이스 유지 보수 | RestTemplate | 변경 범위 최소화 |
| 복잡한 WebClient 체이닝 로직 | WebClient 직접 사용 | 세밀한 연산자 제어 필요 |
| Spring Cloud 마이크로서비스 | @HttpExchange 또는 OpenFeign | 서비스 디스커버리 통합 용이성 |

OpenFeign과의 비교도 중요합니다. OpenFeign은 Spring Cloud와의 통합이 뛰어나고 생태계가 성숙되어 있지만, Spring Cloud 의존성이 필요합니다. `@HttpExchange`는 Spring 표준 스펙으로 추가 의존성 없이 사용 가능하고 WebFlux와 자연스럽게 통합됩니다. 신규 프로젝트라면 `@HttpExchange`를 우선 검토하고, Spring Cloud를 이미 도입했거나 OpenFeign의 고급 기능(커스텀 인코더/디코더, 로드 밸런서 통합 등)이 필요한 경우 OpenFeign을 유지하는 것이 합리적입니다.

### 어떤 상황에서 선택할 것인가

`@HttpExchange`가 빛을 발하는 환경은 **여러 외부 API를 호출하는 서비스**입니다. API 엔드포인트가 인터페이스 메서드로 명시적으로 표현되어 있어 코드 리뷰 시 변경 범위를 파악하기 쉽고, `@SpringBootTest`에서 `@MockBean`으로 인터페이스를 교체하여 외부 의존성 없이 단위 테스트를 작성할 수 있습니다. 반면 요청 파이프라인을 세밀하게 제어해야 하거나, 멀티파트 스트리밍처럼 복잡한 요청 구성이 필요한 경우에는 `WebClient`를 직접 사용하는 편이 낫습니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

`@HttpExchange`를 처음 적용할 때 가장 자주 마주치는 문제 중 하나는 **커넥션 풀 설정 누락**입니다. `WebClient`의 기반이 되는 Reactor Netty는 기본 커넥션 풀 크기가 500개로 설정되어 있습니다. 외부 API의 최대 연결 수 제한보다 클라이언트 풀 크기가 크면 서버 측에서 연결을 거부하거나 타임아웃이 발생합니다. `ConnectionProvider`를 명시적으로 설정하여 풀 크기, 최대 대기 시간, 연결 유지 정책을 조정해야 합니다.

두 번째 함정은 **리액티브 컨텍스트에서의 블로킹 반환 타입 사용**입니다. WebFlux 환경에서 `@HttpExchange` 메서드의 반환 타입을 `Mono<T>` 대신 `T`로 선언하면 이벤트 루프 스레드에서 `.block()`이 호출되어 `BlockingOperationError`가 발생하거나 데드락 상황이 생깁니다.

세 번째는 **직렬화 설정 불일치**입니다. `WebClient`에 커스텀 `ObjectMapper`를 적용하지 않으면 Spring Boot 자동 구성의 `ObjectMapper`와 다른 설정(날짜 형식, 네이밍 전략 등)이 사용될 수 있습니다.

> **자주 발견되는 실수**: `WebClient.create()`를 직접 사용하면 Spring Boot의 자동 구성(메트릭, 트레이싱, 커스텀 직렬화)이 적용되지 않습니다. 반드시 `WebClient.Builder`를 주입받아 사용하세요.

### 모니터링과 디버깅

운영 환경에서 `@HttpExchange` 호출을 모니터링하려면 아래 지표를 반드시 수집해야 합니다.

| 지표 | 수집 방법 | 임계값 설정 기준 |
|---|---|---|
| 요청 응답 시간(p99) | Micrometer + WebClient 메트릭 | 외부 API SLA 기준 80% |
| 커넥션 풀 사용률 | Reactor Netty 메트릭 | 80% 초과 시 풀 크기 재검토 |
| 4xx/5xx 비율 | `http.client.requests` 태그 필터 | 1% 초과 시 알림 |
| 재시도 횟수 | Resilience4j 메트릭 | 재시도 성공률로 외부 서비스 안정성 판단 |
| 타임아웃 발생 횟수 | `TimeoutException` 카운터 | 지속 증가 시 타임아웃 값 재조정 |

디버깅 시에는 `WebClient`의 필터에 요청/응답 로거를 추가하거나, `reactor.netty.http.client` 로거를 `DEBUG` 레벨로 설정하면 실제 주고받는 HTTP 페이로드를 확인할 수 있습니다. 단, 운영 환경에서 응답 본문 전체를 로깅하면 민감 정보 노출과 로그 용량 급증 문제가 생기므로, 헤더만 로깅하거나 마스킹 처리를 적용해야 합니다.

### 확장/마이그레이션 전략

기존 `RestTemplate` 코드를 `@HttpExchange`로 전환할 때는 **점진적 교체** 전략이 위험을 낮춥니다. 우선 신규 외부 API 연동은 모두 `@HttpExchange`로 구현하고, 기존 `RestTemplate` 코드는 인터페이스 추출 → 어댑터 교체 순서로 단계적으로 전환합니다. 이 방식은 두 코드가 공존하는 기간이 길어지지만 각 단계에서 기능 검증이 가능합니다.

서비스 수가 늘어나 여러 `@HttpExchange` 인터페이스가 생기면, 각 외부 서비스별로 설정 클래스를 분리하고 베이스 URL, 타임아웃, 재시도 정책을 독립적으로 관리합니다. 하나의 `WebClient`를 모든 클라이언트가 공유하면 타임아웃 조정 시 의도치 않은 부수 효과가 발생할 수 있습니다.

```
[권장 패키지 구조]

infrastructure/
  ├── client/
  │   ├── user/
  │   │   ├── UserApiClient.java       (인터페이스)
  │   │   ├── UserClientConfig.java    (빈 등록 + WebClient 설정)
  │   │   └── dto/                     (요청/응답 DTO)
  │   ├── payment/
  │   │   ├── PaymentApiClient.java
  │   │   └── PaymentClientConfig.java
  │   └── notification/
  │       ├── NotificationApiClient.java
  │       └── NotificationClientConfig.java
```

이 구조는 외부 API별로 설정을 격리하여 변경 영향 범위를 최소화합니다. 또한 각 클라이언트 인터페이스와 DTO가 같은 패키지에 위치하므로 응집도가 높고, 외부 API 스펙 변경 시 수정해야 할 파일이 명확합니다.

---

## 맺음말

### 핵심 요약

Spring HTTP Interface(`@HttpExchange`)는 인터페이스 선언만으로 HTTP 클라이언트를 구성하는 선언적 방식입니다. `WebClient` 또는 `RestClient`를 기반으로 동작하며, 동기·비동기·리액티브 방식을 반환 타입 선언만으로 전환할 수 있습니다. 별도 의존성 없이 Spring 표준 스펙으로 사용 가능하다는 점이 OpenFeign 대비 가장 큰 장점입니다. 인터페이스가 API 계약서 역할을 하기 때문에 테스트 대체가 쉽고, 코드 리뷰 시 변경 범위 파악이 명확합니다.

### 적용 판단 기준

`@HttpExchange`를 도입하기에 가장 적합한 시점은 다음과 같습니다. **세 개 이상의 외부 API를 호출**하거나 각 API 엔드포인트가 여러 메서드로 나뉘는 경우, 또는 외부 API 호출 코드의 테스트 커버리지를 높이고 싶은 경우에 효과가 뚜렷합니다. 반면 외부 API가 단 하나이고 복잡한 요청 파이프라인이 필요한 경우라면 `WebClient`를 직접 사용하는 편이 불필요한 추상화 레이어를 피할 수 있습니다.

Spring Boot 3.0 이상 환경을 사용하고 있다면 신규 외부 API 연동에는 `@HttpExchange`를 우선 검토하는 것을 권장합니다. 기존 `RestTemplate` 코드는 당장 교체하기보다 새 기능 추가 시 점진적으로 전환하는 방식이 리스크를 줄일 수 있습니다.
