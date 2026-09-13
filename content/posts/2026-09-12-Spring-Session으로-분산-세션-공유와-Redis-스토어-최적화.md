---
title: "Spring Session으로 분산 세션 공유와 Redis 스토어 최적화"
date: "2026-09-12 07:15"
publishedAt: ""
category: "Spring"
tags: ["Spring Session으로 분산 환경 세션 공유와 Redis 스토어 최적화하기", "Spring", "Session", "Redis"]
excerpt: "현대 웹 서비스는 단일 서버에서 운영되던 시대를 벗어나, 여러 인스턴스가 동시에 요청을 처리하는 분산 아키텍처로 전환하고 있습니다."
status: "draft"
---

## 목차

1. 개요
2. Spring Session의 핵심 개념과 동작 원리
3. Redis 기반 Spring Session 구현
4. Redis 스토어 성능 최적화
5. 운영 환경 적용 시 고려사항
6. 맺음말

---

## 개요

### 문제 배경: 분산 환경에서의 세션 관리

현대 웹 서비스는 단일 서버에서 운영되던 시대를 벗어나, 여러 인스턴스가 동시에 요청을 처리하는 분산 아키텍처로 전환하고 있습니다. 특히 쿠버네티스나 AWS ECS 같은 컨테이너 오케스트레이션 환경에서는 Auto Scaling에 의해 서버 인스턴스가 동적으로 늘어나고 줄어드는 것이 일상적입니다. **Spring Session**은 이처럼 복잡한 분산 환경에서 세션 데이터를 중앙화된 외부 저장소에 관리하여, 어떤 서버 인스턴스가 요청을 처리하더라도 일관된 세션 상태를 유지할 수 있게 해주는 프레임워크입니다. 이 글에서는 Spring Session의 내부 동작 원리부터 Redis 스토어 성능 최적화, 그리고 실제 프로젝트 적용 시 마주치는 함정까지 깊이 있게 살펴봅니다.

웹 애플리케이션에서 세션은 인증 상태, 사용자 기본 설정, 장바구니 데이터 등 요청 간에 유지되어야 하는 상태 정보를 담습니다. HTTP가 기본적으로 무상태(Stateless) 프로토콜이기 때문에, 서버는 클라이언트를 식별하고 이전 요청의 컨텍스트를 유지하기 위해 세션 메커니즘을 도입했습니다. 전통적인 `HttpSession`은 WAS의 메모리에 세션 데이터를 저장하는데, 이는 단일 서버 환경에서는 충분하지만 여러 서버가 병렬로 운영되는 환경에서는 근본적인 한계를 드러냅니다. 어떤 서버에 세션이 생성되었느냐에 따라 동일한 사용자라도 다른 서버에서는 인증이 풀리거나 상태 정보가 사라지는 현상이 발생합니다.

Spring Session은 서블릿 컨테이너의 기본 `HttpSession` 구현을 투명하게 교체하는 방식으로 동작합니다. 애플리케이션 코드는 기존의 `HttpSession` API를 그대로 사용하면서도, 실제 세션 데이터는 Redis, JDBC, Hazelcast, MongoDB 등 다양한 외부 저장소에 저장됩니다. 이 투명한 교체 방식 덕분에 기존 코드 변경 없이 분산 세션 관리를 도입할 수 있다는 점이 가장 큰 강점입니다.

---

### 기존 방식의 한계: 스티키 세션과 세션 복제

Spring Session 이전에도 분산 환경의 세션 문제를 해결하기 위한 방법들이 존재했습니다. 가장 흔한 두 가지 접근법인 **스티키 세션(Sticky Session)**과 **세션 복제(Session Replication)**를 살펴보면, 각 방식이 왜 현대 아키텍처에서 한계를 갖는지 이해할 수 있습니다.

스티키 세션은 로드 밸런서 레벨에서 특정 클라이언트의 요청을 항상 동일한 서버로 라우팅하는 방식입니다. 구현이 단순하고 별도의 세션 공유 인프라가 필요 없다는 장점이 있지만, 서버가 다운되거나 새 인스턴스가 추가될 때 세션이 유실되는 문제가 발생합니다. Auto Scaling 환경에서는 인스턴스가 빈번하게 교체되기 때문에 이 방식은 신뢰하기 어렵습니다. 또한 특정 서버로 요청이 집중되어 로드 밸런싱의 효과가 반감되는 부하 불균형 문제도 피할 수 없습니다. 특히 인스턴스 교체 주기가 짧은 컨테이너 기반 환경에서는 사용자가 로그인 세션을 예기치 않게 잃는 빈도가 높아져 사용자 경험을 크게 해칩니다.

세션 복제는 WAS 클러스터 내의 모든 서버가 세션 데이터를 공유하는 방식입니다. Tomcat의 DeltaManager나 BackupManager를 사용하는 이 접근법은 서버 장애 시에도 세션이 유지된다는 장점이 있습니다. 그러나 서버 수가 늘어날수록 복제 트래픽이 기하급수적으로 증가하여 네트워크 부하가 커지고, 대규모 클러스터에서는 세션 복제 자체가 성능 병목이 됩니다. 수십 개 이상의 인스턴스를 운영하는 환경에서는 사실상 적용하기 어렵고, 복제 지연(Replication Lag) 동안 특정 서버에서 세션 상태가 일관되지 않는 일시적 불일치 문제도 존재합니다.

| 방식 | 장점 | 단점 | 적합한 환경 |
|---|---|---|---|
| 스티키 세션 | 구현 단순, 별도 인프라 불필요 | 장애 시 세션 유실, 부하 불균형 | 소규모, 정적 인프라 |
| 세션 복제 | 장애 내성 있음 | 복제 트래픽 증가, 확장성 한계 | 소~중규모 클러스터 |
| Spring Session | 중앙화 관리, 완전한 확장성 | 외부 저장소 의존성 추가 | 중~대규모 분산 환경 |

---

## Spring Session의 핵심 개념과 동작 원리

### 아키텍처 구조: 세션 추상화 계층

Spring Session은 **세션 추상화 계층(Session Abstraction Layer)**을 도입하여 애플리케이션과 실제 세션 저장소 사이에 위치합니다. 핵심은 `SessionRepository` 인터페이스로, 이 인터페이스를 구현한 각 저장소별 구현체가 실제 데이터 저장·조회 로직을 처리합니다. Redis를 사용하는 경우 `RedisIndexedSessionRepository`가, JDBC를 사용하는 경우 `JdbcIndexedSessionRepository`가 이 역할을 담당합니다. 추상화 덕분에 저장소를 교체하더라도 애플리케이션 코드에는 전혀 영향이 없습니다.

서블릿 필터 체인에는 `SessionRepositoryFilter`가 등록되어, 모든 HTTP 요청이 이 필터를 거치도록 합니다. 이 필터는 서블릿 컨테이너의 `HttpServletRequest`를 `SessionRepositoryRequestWrapper`로 감싸는데, 이 래퍼 클래스가 `getSession()` 호출을 가로채어 내장 세션 대신 외부 저장소의 세션을 반환합니다. `@Autowired HttpSession`으로 세션을 주입받는 기존 코드는 아무런 변경 없이 외부 저장소를 활용하게 됩니다. 이처럼 표준 서블릿 API의 모양은 그대로 유지하면서 동작만 교체하는 설계 덕분에 마이그레이션 비용이 매우 낮습니다.

```
HTTP 요청
    │
    ▼
┌─────────────────────────────┐
│    SessionRepositoryFilter  │  ← 서블릿 필터 체인
└──────────┬──────────────────┘
           │ 요청 래핑
           ▼
┌─────────────────────────────┐
│  SessionRepositoryRequest   │  ← getSession() 인터셉트
│         Wrapper             │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│      SessionRepository      │  ← 저장소 추상화
│   (Redis / JDBC / ...)      │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│      외부 세션 저장소        │  ← Redis, RDB 등
└─────────────────────────────┘
```

세션 식별은 **`HttpSessionIdResolver`**를 통해 이루어집니다. 기본적으로 `CookieHttpSessionIdResolver`를 사용하여 `SESSION`이라는 쿠키 이름으로 세션 ID를 클라이언트에 전달합니다. REST API 환경이나 모바일 클라이언트를 위해서는 `HeaderHttpSessionIdResolver`로 교체하여 HTTP 헤더(`X-Auth-Token`)를 통해 세션 ID를 전달할 수도 있습니다. 두 방식을 동시에 사용하고 싶다면 `DelegatingHttpSessionIdResolver`를 사용하여 요청 타입에 따라 적절한 방식을 선택하도록 구성할 수도 있습니다.

---

### 주요 구성 요소: 세션 저장소와 이벤트 처리

Spring Session의 주요 컴포넌트들은 각자 명확한 역할을 담당하며, 이들이 협력하여 완전한 세션 수명 주기를 관리합니다. 각 구성 요소의 역할을 이해하면 문제 발생 시 어느 지점을 살펴봐야 하는지 빠르게 파악할 수 있습니다.

`Session` 인터페이스는 Spring Session이 정의하는 세션의 추상이며, 표준 `HttpSession`보다 더 풍부한 기능을 제공합니다. 세션 생성 시각, 마지막 접근 시각, 최대 비활성 시간 등을 직접 제어할 수 있으며, 세션 속성을 `Map<String, Object>` 형태로 관리합니다. 특히 `changeSessionId()` 메서드를 통해 세션 고정(Session Fixation) 공격에 대응하는 세션 ID 재생성 기능도 내장되어 있습니다. `SessionEventPublisher`와 Spring의 `ApplicationEvent` 시스템을 통해 세션 생성, 삭제, 만료 이벤트를 감지할 수 있어, 세션 만료 시 연관된 비즈니스 로직을 자동으로 실행하는 구조를 만들 수 있습니다.

`FlushMode`는 세션 데이터가 실제로 저장소에 기록되는 시점을 결정하는 중요한 설정입니다. 기본값인 `ON_SAVE` 모드에서는 HTTP 응답이 완료되는 시점에 변경된 세션 속성을 일괄 저장합니다. `IMMEDIATE` 모드에서는 `setAttribute()`를 호출할 때마다 즉시 Redis에 반영되는데, 데이터 일관성이 극도로 중요한 결제나 예약 플로우에서 유용하지만 Redis 호출 횟수가 늘어나 레이턴시에 영향을 줄 수 있습니다.

| 컴포넌트 | 역할 | 주요 설정 포인트 |
|---|---|---|
| `SessionRepositoryFilter` | HTTP 요청 인터셉트 및 세션 래핑 | 필터 순서 (`@Order`) |
| `SessionRepository` | 세션 CRUD 처리 | 저장소 구현체 선택 |
| `HttpSessionIdResolver` | 세션 ID 전달 방식 결정 | 쿠키 vs 헤더 |
| `SessionEventPublisher` | 세션 생명주기 이벤트 발행 | Keyspace 알림 활성화 |
| `FlushMode` | 세션 저장 시점 제어 | `IMMEDIATE` vs `ON_SAVE` |

---

### 데이터 흐름: 요청부터 저장까지

실제 HTTP 요청이 처리될 때 Spring Session의 데이터 흐름을 단계별로 살펴보면, 각 컴포넌트의 역할이 명확해집니다. 클라이언트가 쿠키에 세션 ID를 담아 요청을 보내면, `SessionRepositoryFilter`가 가장 먼저 이를 감지하고 처리합니다.

첫째, `HttpSessionIdResolver`가 요청에서 세션 ID를 추출합니다. 쿠키 방식이라면 `SESSION` 쿠키에서, 헤더 방식이라면 `X-Auth-Token` 헤더에서 세션 ID를 읽습니다. 둘째, 추출한 세션 ID로 `SessionRepository`에 세션 조회를 요청합니다. Redis의 경우 `spring:session:sessions:{sessionId}` 키로 Hash 자료구조에 저장된 세션 데이터를 가져옵니다. 셋째, 조회된 세션은 `SessionRepositoryRequestWrapper` 내부에 캐싱되어, 동일 요청 내에서 여러 번 `getSession()`을 호출해도 Redis에 중복 조회가 발생하지 않도록 합니다. 이 요청 내 캐싱은 성능에 있어 중요한 최적화입니다.

요청 처리가 완료되면 응답 커밋 단계에서 세션 변경 사항이 저장소에 반영됩니다. `ON_SAVE` 모드에서는 단 한 번의 Redis 명령으로 변경된 속성들을 한꺼번에 저장합니다. 세션 쿠키가 아직 없거나 세션 ID가 바뀐 경우에는 `HttpSessionIdResolver`가 응답에 새 쿠키를 추가하거나 기존 쿠키를 갱신합니다.

> `FlushMode.ON_SAVE`가 기본값인 이유는 단일 요청 내에서 발생하는 세션 변경을 하나의 Redis 명령으로 묶어 처리하기 위함입니다. 불필요한 네트워크 왕복 횟수를 최소화하는 것이 레이턴시 최적화의 핵심입니다.

---

## Redis 기반 Spring Session 구현

### 의존성 설정과 초기 구성

Spring Session을 Redis와 함께 사용하기 위해서는 `spring-session-data-redis` 의존성이 필요합니다. Spring Boot를 사용한다면 `spring-boot-starter-data-redis`와 함께 추가하는 것이 일반적이며, Spring Boot의 자동 구성(Auto Configuration)이 대부분의 빈 설정을 처리해줍니다. 그러나 세부 동작을 이해하고 환경에 맞게 조정하는 것이 중요합니다.

`namespace` 설정은 운영 환경에서 반드시 커스터마이징해야 합니다. 동일한 Redis 인스턴스를 여러 서비스가 공유하거나, 스테이징·프로덕션 환경을 같은 Redis에서 운영하는 경우 키 충돌을 방지하기 위해 서비스명과 환경명을 포함한 고유한 네임스페이스를 설정해야 합니다. `save-mode`의 경우 `on-set-attribute`가 기본값이며, 세션 속성을 명시적으로 `setAttribute()`로 설정할 때만 변경으로 감지하여 저장합니다. 세션에 저장된 객체를 직접 변경하는 경우(예: `List`에 요소 추가 후 별도의 `setAttribute()` 없이 마무리)에는 `always` 모드를 사용하거나 수동으로 `setAttribute()`를 다시 호출해야 변경 사항이 Redis에 반영됩니다. 이 점을 놓쳐 세션 변경이 유실되는 사례가 현업에서 빈번하게 발생합니다.

```yaml
spring:
  session:
    store-type: redis
    timeout: 30m
    redis:
      namespace: myapp:session   # Redis 키 접두사 (기본값: spring:session)
      flush-mode: on-save        # on-save | immediate
      save-mode: on-set-attribute # always | on-set-attribute | on-get-attribute
  data:
    redis:
      host: ${REDIS_HOST:localhost}
      port: 6379
      password: ${REDIS_PASSWORD}
      lettuce:
        pool:
          max-active: 8          # 최대 커넥션 수
          max-idle: 8
          min-idle: 2
          max-wait: 100ms        # 커넥션 대기 최대 시간
```

`max-wait` 설정은 커넥션 풀이 모두 소진된 상태에서 새 커넥션을 기다리는 최대 시간입니다. 이 값이 너무 작으면 트래픽 급증 시 `PoolExhaustedException`이 발생하고, 너무 크면 Redis 장애가 전체 서버 스레드 대기로 전파될 수 있습니다. 서비스의 SLA와 Redis 응답 시간을 고려하여 100~300ms 사이에서 설정하는 것이 일반적입니다.

---

### 핵심 구현: 직렬화 설정과 이벤트 처리

Redis에 저장되는 세션 데이터는 직렬화(Serialization) 과정을 거칩니다. Spring Session은 기본적으로 Java 직렬화를 사용하는데, 이는 설정이 간단하지만 성능과 호환성 측면에서 여러 문제를 일으킬 수 있습니다. 실제 프로젝트에서는 대부분 JSON 기반의 직렬화로 교체하여 사용합니다.

아래 코드는 `RedisSerializer`를 `GenericJackson2JsonRedisSerializer`로 교체하고, 세션 이벤트 리스너를 함께 구성하는 예제입니다. `@EnableRedisHttpSession`을 명시적으로 사용하는 방식으로, 세션 네임스페이스와 플러시 모드를 코드 레벨에서 제어합니다.

```java
@Configuration
@EnableRedisHttpSession(
    maxInactiveIntervalInSeconds = 1800,
    redisNamespace = "${spring.session.redis.namespace:myapp:session}",
    flushMode = FlushMode.ON_SAVE,
    saveMode = SaveMode.ON_SET_ATTRIBUTE
)
public class SessionConfig {

    /**
     * Java 직렬화 대신 JSON 사용
     * - redis-cli로 세션 내용 직접 확인 가능 (디버깅 용이)
     * - 롤링 배포 시 SerialVersionUID 불일치 문제 방지
     */
    @Bean
    public RedisSerializer<Object> springSessionDefaultRedisSerializer(
            ObjectMapper objectMapper) {
        ObjectMapper sessionMapper = objectMapper.copy();
        // @class 타입 정보 포함 — 다형성 역직렬화에 필수
        sessionMapper.activateDefaultTyping(
            sessionMapper.getPolymorphicTypeValidator(),
            ObjectMapper.DefaultTyping.NON_FINAL,
            JsonTypeInfo.As.PROPERTY
        );
        return new GenericJackson2JsonRedisSerializer(sessionMapper);
        // 결과: Redis Hash 필드가 바이너리가 아닌 JSON 문자열로 저장됨
    }

    @Bean
    public HttpSessionEventPublisher httpSessionEventPublisher() {
        return new HttpSessionEventPublisher(); // 세션 만료 이벤트 Spring Context로 전파
    }
}
```

`GenericJackson2JsonRedisSerializer`를 사용할 때 `ObjectMapper`에 타입 정보(`@class` 필드)를 포함시키는 것이 필수입니다. 타입 정보 없이는 역직렬화 시 세션 속성이 `LinkedHashMap`으로 변환되어 실제 도메인 객체로 캐스팅할 수 없게 됩니다. 단, 타입 정보를 포함하면 JSON에 클래스 전체 경로가 기록되므로 패키지 리팩토링 시 기존 세션과의 호환성이 깨질 수 있습니다. 이 경우 `MixIn`을 활용하거나 배포 전 세션을 의도적으로 무효화하는 방식으로 대응할 수 있습니다.

---

### 세션 직렬화 전략 비교

직렬화 전략 선택은 성능, 가독성, 호환성 간의 트레이드오프를 고려해야 합니다. 초기에는 설정 편의성 때문에 Java 직렬화를 선택하더라도, 서비스가 성장하면서 결국 교체 작업을 하게 되는 경우가 많습니다. 처음 도입 시점에 JSON 직렬화로 시작하는 것이 장기적으로 유리합니다.

**Java 직렬화**는 `Serializable` 인터페이스 구현 외에 별다른 설정이 필요 없어 초기 설정이 빠릅니다. 그러나 직렬화된 데이터가 바이너리 형태이기 때문에 `redis-cli`로 세션 내용을 직접 확인하기 어렵고, 클래스 변경 시 `serialVersionUID` 불일치로 역직렬화 실패가 발생할 수 있습니다. 롤링 배포 중 이 문제가 발생하면 일부 사용자의 세션이 강제 무효화되는 심각한 상황이 생깁니다. **JSON 직렬화(Jackson)**는 사람이 읽을 수 있는 포맷으로 저장되어 운영 환경 디버깅이 훨씬 용이하고 언어 간 호환성도 높습니다.

| 직렬화 방식 | 성능 | 데이터 크기 | 가독성 | 호환성 | 권장 환경 |
|---|---|---|---|---|---|
| Java 직렬화 | 중간 | 큼 | 불가 | 낮음 | 프로토타입 |
| JSON (Jackson) | 중간 | 중간 | 높음 | 높음 | 대부분의 환경 |
| Kryo | 높음 | 작음 | 불가 | 낮음 | 고성능 요구 |
| Protocol Buffers | 매우 높음 | 매우 작음 | 불가 | 높음 | 마이크로서비스 간 |

---

## Redis 스토어 성능 최적화

### 직렬화 성능과 세션 크기 최적화

Redis 기반 세션 관리에서 성능에 가장 직접적인 영향을 미치는 요소는 **세션 데이터의 크기**와 **직렬화·역직렬화 속도**입니다. 세션에 대용량 데이터를 저장하면 Redis 메모리를 낭비하고, 네트워크 전송 비용을 높이며, 직렬화 처리 시간을 늘려 응답 지연을 유발합니다. 세션에 저장해야 하는 정보는 최소화하는 것이 기본 원칙입니다.

사용자 인증 정보라면 전체 `UserDetails` 객체보다 사용자 ID와 권한 목록 정도만 저장하는 것이 이상적입니다. 나머지 사용자 정보는 필요할 때 데이터베이스나 캐시에서 조회하는 방식이 세션 크기를 줄이면서도 데이터 최신성을 유지할 수 있는 균형 잡힌 접근법입니다. 세션 속성으로 저장되는 커스텀 객체에 `@JsonIgnore`를 활용하여 불필요한 필드의 직렬화를 제외하는 것도 효과적입니다. Spring Security의 `Authentication` 객체를 세션에 저장하는 경우, `UserDetails` 구현체에 포함된 불필요한 컬렉션 필드들을 `@JsonIgnore`로 제외하면 세션 크기를 수 KB에서 수백 바이트로 줄일 수 있습니다.

Spring Session이 Redis에 저장하는 세션 구조를 이해하면 최적화 방향이 명확해집니다. Redis의 **Hash 자료구조**를 사용하며, 기본적으로 다음과 같은 키 패턴으로 데이터가 저장됩니다.

```
myapp:session:sessions:{sessionId}           # 세션 데이터 Hash
myapp:session:sessions:expires:{sessionId}   # 만료 처리용 String 키
myapp:session:expirations:{timestamp}        # 만료 시간 인덱스 Sorted Set
```

`myapp:session:sessions:{sessionId}` 해시에는 `creationTime`, `lastAccessedTime`, `maxInactiveInterval`, 그리고 각 세션 속성이 `sessionAttr:{key}` 형태로 저장됩니다. 속성 수가 많거나 값이 크면 이 해시의 크기가 늘어나 `HGETALL` 명령 실행 시 반환되는 데이터양이 많아집니다.

> 세션 크기를 **100KB 미만**으로 유지하는 것을 목표로 삼아야 합니다. 단일 세션이 수 MB를 초과하면 직렬화 비용이 요청 처리 시간에 눈에 띄게 반영되고, Redis 메모리 사용량도 빠르게 증가합니다.

---

### TTL과 세션 만료 전략

세션 만료 전략은 보안과 성능 두 측면 모두에 영향을 미칩니다. Spring Session은 Redis의 TTL 메커니즘과 자체 만료 관리 로직을 함께 사용하는 이중 만료 체계를 채택합니다. 이 구조를 이해해야 예상치 못한 세션 조기 만료나 Redis 메모리 누수 문제를 예방할 수 있습니다.

`spring:session:sessions:{sessionId}` 키에는 실제 `maxInactiveInterval`보다 **5분 더 긴 TTL**이 설정됩니다. 이는 Redis가 TTL 만료를 정확히 처리하지 못하는 경우를 대비한 버퍼입니다. 실제 만료 판단은 `lastAccessedTime`과 `maxInactiveInterval`을 비교하는 Spring Session 자체 로직이 담당합니다. `spring:session:expirations:{timestamp}` Set에는 특정 시간에 만료되어야 하는 세션 ID들이 저장되며, Spring Session은 이를 참조하여 만료 세션을 정리합니다.

세션 만료 이벤트(`SessionExpiredEvent`)를 수신하려면 Redis의 `notify-keyspace-events` 설정에 키 만료 알림이 활성화되어 있어야 합니다. 이 설정이 없으면 세션이 만료되더라도 Spring Application Context에 이벤트가 발행되지 않아, 세션 만료 시 실행해야 하는 비즈니스 로직이 동작하지 않습니다. 클라우드 관리형 Redis(AWS ElastiCache, Azure Cache for Redis 등)에서는 이 설정이 기본적으로 비활성화된 경우가 많으므로 반드시 확인해야 합니다.

| 세션 만료 방식 | 트리거 시점 | 장점 | 주의사항 |
|---|---|---|---|
| Redis TTL 만료 | Redis 내부 TTL 만료 시 | 자동 처리 | 실제 만료보다 5분 늦게 삭제됨 |
| 자체 만료 로직 | 요청 처리 시 접근 시간 비교 | 정확한 만료 판단 | 주기적 정리 작업 필요 |
| Keyspace 알림 | Redis 키 삭제 이벤트 발생 시 | 만료 이벤트 처리 가능 | Redis `notify-keyspace-events` 설정 필요 |

---

### 커넥션 풀과 Redis 고가용성 구성

Spring Session with Redis는 Lettuce 또는 Jedis 클라이언트를 통해 Redis와 통신합니다. Spring Boot에서는 기본적으로 **Lettuce**를 사용하는데, Lettuce는 **비동기·비차단(Non-blocking) 방식**으로 동작하고 단일 커넥션을 스레드 안전하게 공유할 수 있어 높은 동시성 환경에서 유리합니다. Jedis는 동기 방식으로 동작하며 커넥션당 하나의 스레드를 점유하기 때문에, 멀티스레드 환경에서는 반드시 커넥션 풀이 필요합니다.

실제 운영 환경에서는 Redis 단일 인스턴스 대신 **Redis Sentinel**이나 **Redis Cluster** 구성을 사용하는 것이 표준입니다. Sentinel은 마스터-슬레이브 구성에서 자동 장애 조치(Failover)를 제공하며, Cluster는 데이터를 16384개의 슬롯으로 분산하여 수평 확장을 지원합니다. Spring Session은 두 구성 모두를 지원하지만, Redis Cluster에서는 세션 만료 관련 Keyspace 알림 처리 방식에 차이가 있어 별도 설정이 필요할 수 있습니다. 특히 `spring:session:expirations:*` 키는 모든 슬롯에 분산되지 않고 특정 슬롯에 집중될 수 있으므로, 클러스터 구성 시 키 해시 태그를 검토해야 합니다.

| Redis 구성 | 가용성 | 확장성 | Spring Session 지원 | 주의점 |
|---|---|---|---|---|
| 단일 인스턴스 | 낮음 | 없음 | 완전 지원 | 운영 환경 부적합 |
| Redis Sentinel | 높음 | 제한적 | 완전 지원 | Failover 시 일시적 지연 |
| Redis Cluster | 높음 | 높음 | 지원 (일부 제약) | Keyspace 알림·슬롯 분산 주의 |

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

Spring Session을 처음 도입할 때 가장 빈번하게 발생하는 문제 중 하나는 **세션 속성으로 직렬화 불가능한 객체를 저장**하는 경우입니다. JSON 직렬화를 사용하더라도, Jackson이 기본적으로 처리하지 못하는 타입(예: `HttpServletRequest`, JPA Lazy-Loaded 프록시 객체, Hibernate 엔티티)을 세션에 저장하면 직렬화 예외가 발생합니다. 특히 Spring Security와 함께 사용할 때 `Authentication` 객체에 포함된 커스텀 `UserDetails` 구현체가 Jackson으로 직렬화 가능한지 반드시 검증해야 합니다. 단위 테스트에서 `ObjectMapper`를 사용해 직렬화 가능 여부를 사전에 확인하는 것을 권장합니다.

**JPA 지연 로딩(Lazy Loading) 문제**는 더욱 교묘합니다. 엔티티를 세션에 저장할 때는 정상적으로 저장되지만, 이후 세션에서 꺼낼 때는 이미 JPA 영속성 컨텍스트가 종료되어 있어 지연 로딩이 동작하지 않습니다. `LazyInitializationException`이 발생하거나, Jackson 직렬화 중에 지연 로딩이 트리거되어 예상치 못한 데이터베이스 쿼리가 실행되기도 합니다. 세션에는 반드시 엔티티 전체가 아닌 순수한 DTO나 ID 값만 저장하는 것이 안전하며, 이는 세션 크기를 줄이는 효과도 함께 가져옵니다.

또 다른 흔한 실수는 **`@EnableRedisHttpSession`과 Spring Boot 자동 구성을 혼용**하는 경우입니다. `@EnableRedisHttpSession` 어노테이션을 선언하면 Spring Boot의 세션 자동 구성이 비활성화되며, `application.yml`의 `spring.session.*` 설정이 적용되지 않습니다. 두 방식을 혼용하면 의도하지 않은 기본값이 적용되어 세션 타임아웃이나 네임스페이스가 예상과 다르게 동작할 수 있습니다.

> `@EnableRedisHttpSession`을 선언하는 순간, `application.yml`의 세션 관련 자동 구성은 모두 무력화됩니다. 커스텀 설정이 필요하다면 `@EnableRedisHttpSession`의 속성만 사용하거나, 자동 구성을 그대로 두고 `@Bean`으로 필요한 컴포넌트만 재정의하는 방법 중 하나를 일관되게 선택하세요.

---

### 모니터링과 디버깅

운영 환경에서 Spring Session의 상태를 효과적으로 모니터링하려면 Redis 메트릭과 애플리케이션 레벨 지표를 함께 수집해야 합니다. **Micrometer**와 Spring Boot Actuator를 통해 세션 관련 메트릭을 수집하고 Prometheus·Grafana로 시각화하는 것이 효과적인 접근법입니다. 특히 `lettuce.command.completion` 타이머는 Redis 명령 처리 시간을 추적하여 Redis 성능 이슈를 조기에 감지하는 데 유용합니다.

활성 세션 수를 모니터링하려면 `redis-cli` 명령이나 Spring Actuator의 `/actuator/sessions` 엔드포인트를 활용할 수 있습니다. 세션 수가 예상보다 빠르게 증가한다면 세션 만료가 제대로 동작하지 않거나, 비정상적인 클라이언트가 대량의 세션을 생성하는 상황일 수 있습니다. Redis의 `INFO keyspace` 명령으로 세션 관련 키 수를 주기적으로 확인하는 것이 좋습니다.

실제 운영 중 세션 직렬화 문제가 발생하면, `redis-cli`로 직접 세션 데이터를 확인하는 것이 가장 빠른 디버깅 방법입니다. JSON 직렬화를 사용하면 `HGETALL myapp:session:sessions:{sessionId}` 명령으로 세션 내용을 사람이 읽을 수 있는 형태로 확인할 수 있습니다. 세션 속성 값에 예상치 못한 `@class` 정보가 없거나 타입 불일치가 발생한다면, `ObjectMapper` 설정을 다시 점검해야 합니다.

| 모니터링 항목 | 수집 방법 | 이상 징후 | 대응 방안 |
|---|---|---|---|
| 활성 세션 수 | Redis `INFO keyspace`, Actuator | 급격한 증가 | 세션 TTL 점검, 비정상 클라이언트 차단 |
| Redis 메모리 | `redis_mem_used_bytes` | 지속적 증가 | 세션 크기 최적화, TTL 재설정 |
| 직렬화 오류 | 애플리케이션 로그 (ERROR 레벨) | 예외 발생 빈도 증가 | 직렬화 전략 검토, `@JsonIgnore` 추가 |
| 커넥션 풀 대기 | `lettuce.command.completion` | 99th percentile 급증 | 풀 크기 조정, Redis 처리량 점검 |
| 세션 만료 이벤트 | `SessionExpiredEvent` 수신 여부 | 이벤트 미발행 | Redis Keyspace 알림 설정 확인 |

---

### Redis 장애 시 페일오버와 회복 전략

Redis 장애는 세션 데이터 손실이나 서비스 전체 장애로 이어질 수 있는 위험한 상황입니다. Spring Session은 Redis 연결 실패 시 기본적으로 예외를 던지며, 적절한 예외 처리 없이는 모든 HTTP 요청이 500 에러를 반환하게 됩니다. 이에 대한 회복 전략을 사전에 준비해야 서비스 가용성을 유지할 수 있습니다.

**Circuit Breaker 패턴**을 적용하면 Redis 장애 상황에서 세션 기능을 일시적으로 비활성화하고 기본 메모리 세션으로 폴백(Fallback)하는 전략이 가능합니다. Resilience4j를 사용하여 Redis 호출을 감싸고, 장애 임계점에 도달하면 자동으로 폴백 로직을 실행할 수 있습니다. 다만 폴백 과정에서 기존 Redis 세션은 접근 불가 상태가 되므로, 사용자는 재인증이 필요합니다. 이 점을 사용자에게 안내하는 UI/메시지를 미리 준비하는 것이 중요합니다.

Redis Sentinel 구성에서는 마스터 노드 장애 시 Sentinel이 자동으로 슬레이브를 마스터로 승격시킵니다. 이 과정에서 수 초에서 수십 초의 짧은 불가용 구간이 발생하는데, Lettuce 클라이언트는 Sentinel 알림을 받아 자동으로 새 마스터에 재연결합니다. 재연결 과정에서 발생하는 일시적 세션 조회 실패에 대한 재시도 로직 혹은 사용자 안내 메시지를 준비해 두면 운영 안정성을 높일 수 있습니다. 또한 **Redis 지속성(Persistence)** 설정(AOF 또는 RDB)을 활성화하면 Redis 재시작 후에도 세션 데이터를 복구할 수 있습니다.

> Redis 장애 대비 전략의 핵심은 **Redis Sentinel**로 고가용성 확보, **Circuit Breaker**로 장애 전파 차단, **그레이스풀 폴백**으로 사용자 경험 보호 이 세 가지를 조합하는 것입니다. 각 전략을 독립적으로 적용하는 것보다 조합할 때 효과가 극대화됩니다.

---

## 맺음말

### 핵심 요약

Spring Session은 분산 환경에서의 세션 관리 문제를 우아하게 해결하는 검증된 솔루션입니다. 스티키 세션이나 세션 복제 방식의 근본적인 한계를 극복하면서도, 기존 `HttpSession` API와의 완전한 하위 호환성을 유지한다는 점이 핵심 강점입니다. `SessionRepositoryFilter`를 통한 투명한 세션 교체, Redis를 비롯한 다양한 저장소 지원, 그리고 세션 수명 주기 이벤트 처리까지 세션 관리에 필요한 대부분의 기능을 제공합니다.

성능 최적화 측면에서는 JSON 기반 직렬화 채택, 세션 크기 최소화(100KB 미만 목표), 적절한 TTL 설정, 그리고 Lettuce 커넥션 풀 튜닝이 핵심입니다. 특히 세션에 불필요하게 큰 객체나 JPA 엔티티 전체를 저장하지 않는 것이 가장 기본적이면서도 효과적인 최적화입니다. 운영 환경에서는 Redis 고가용성 구성, 세션 만료 이벤트 모니터링, Redis 장애 대비 Circuit Breaker 패턴을 병행하여 예측 가능한 안정적 운영 환경을 구축해야 합니다.

---

### 적용 판단 기준

Spring Session의 도입을 고려할 때 아래 기준이 의사결정에 도움이 됩니다. 두 개 이상의 서버 인스턴스가 동시에 운영되거나, 컨테이너 기반으로 Auto Scaling이 활성화된 환경이라면 Spring Session 도입이 강하게 권장됩니다. 반면 항상 단일 인스턴스로 운영되고 확장 계획이 없는 소규모 서비스라면, Redis 의존성을 추가하는 복잡도 증가 대비 이득이 크지 않을 수 있습니다.

| 적용 고려 요소 | 적용 권장 | 재검토 권장 |
|---|---|---|
| 서버 인스턴스 수 | 2개 이상 동시 운영 | 단일 인스턴스 |
| Auto Scaling 여부 | 활성화됨 | 미사용 |
| 기존 Redis 인프라 | 이미 운영 중 | 신규 구축 필요 |
| 세션 데이터 특성 | 단순 인증 정보, 소규모 DTO | 대용량 바이너리, 복잡한 객체 그래프 |
| 요구 가용성 | 99.9% 이상 SLA | 상대적으로 낮은 가용성 요건 |

---

참고 자료:
- [Spring Session 공식 문서](https://docs.spring.io/spring-session/reference/)
- [Spring Session Data Redis 설정](https://docs.spring.io/spring-session/reference/guides/boot-redis.html)
- [Redis Keyspace Notifications](https://redis.io/docs/latest/develop/use/keyspace-notifications/)
