---
title: "Spring Kafka @KafkaListener 컨슈머 설계 — 재시도·DLT·동시성"
date: "2026-09-21 02:46"
publishedAt: ""
category: "Spring"
tags: ["Spring Kafka", "@KafkaListener", "Dead Letter Topic", "비차단 재시도", "컨슈머 설계"]
excerpt: "메시지 기반 아키텍처에서 Kafka는 높은 처리량과 내구성을 갖춘 플랫폼으로 자리를 잡았습니다. Spring Kafka는 @KafkaListener 어노테이션 하나로 컨슈머를 정의할 수 있어 진입 장벽이 낮지만, 실제 프로젝트에서는…"
status: "draft"
---

## 목차

1. 개요
2. @KafkaListener 동작 원리와 핵심 구성 요소
3. 재시도 전략 설계 — 동기와 비동기
4. Dead Letter Topic 설계와 운영
5. 동시성 설정과 파티션 전략
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경

메시지 기반 아키텍처에서 Kafka는 높은 처리량과 내구성을 갖춘 플랫폼으로 자리를 잡았습니다. Spring Kafka는 `@KafkaListener` 어노테이션 하나로 컨슈머를 정의할 수 있어 진입 장벽이 낮지만, 실제 프로젝트에서는 단순한 소비 이상의 설계가 필요합니다. 네트워크 오류, 외부 서비스 장애, 잘못된 메시지 형식 등 다양한 이유로 메시지 처리가 실패할 수 있고, 이때 **재시도 전략**과 **Dead Letter Topic(DLT)** 설계가 서비스 안정성을 좌우합니다. 또한 컨슈머가 메시지를 얼마나 빠르게 병렬로 처리하느냐는 **동시성 설정**에 달려 있으며, 이를 잘못 구성하면 파티션 재조정이나 컨슈머 그룹 장애로 이어질 수 있습니다. 이 글은 Spring Kafka 컨슈머의 재시도·DLT·동시성을 체계적으로 설계하는 방법을 다룹니다.

### 기존 방식의 한계

초기 Spring Kafka 버전에서는 실패한 메시지를 처리하는 공식적인 메커니즘이 빈약했습니다. 개발자들은 직접 try-catch 블록 안에서 재시도 루프를 구현하거나, `SeekToCurrentErrorHandler` 같은 저수준 API를 손으로 조립해야 했습니다. 이 방식은 재시도 횟수와 간격을 하드코딩하게 만들고, DLT로의 전달 로직도 직접 관리해야 했습니다. 결과적으로 재시도 도중 컨슈머 스레드가 블로킹되어 전체 파티션 처리가 멈추는 상황이 자주 발생했습니다. Spring Kafka 2.7 이후 도입된 **Non-blocking Retry(비차단 재시도)** 와 `RetryTopicConfiguration` API는 이 문제를 구조적으로 해결합니다. 재시도 토픽을 별도로 두어 원본 파티션을 블로킹하지 않고, DLT까지의 경로를 선언적으로 정의할 수 있게 되었습니다.

---

## @KafkaListener 동작 원리와 핵심 구성 요소

### 메시지 소비 흐름

`@KafkaListener`가 붙은 메서드는 겉으로 단순해 보이지만, 내부적으로는 상당히 복잡한 추상화 계층 위에 동작합니다. Spring Kafka는 `KafkaMessageListenerContainer`(단일 스레드) 또는 `ConcurrentMessageListenerContainer`(멀티 스레드)를 생성하고, 각 컨테이너는 카프카 네이티브 `KafkaConsumer`를 래핑합니다. 리스너 메서드가 호출되기 전에 메시지는 역직렬화, 변환, 필터링 단계를 거치며, 처리 결과에 따라 오프셋 커밋 여부가 결정됩니다. 이 흐름 전체를 명확히 파악하고 있어야 재시도 전략이나 에러 핸들링을 올바른 위치에 끼워 넣을 수 있습니다.

```diagram
2026-09-21-5a4b63fa-01
```

컨슈머가 브로커에서 `poll`한 메시지는 ListenerContainer를 거쳐 비즈니스 로직으로 전달되며, 실패 시 ErrorHandler가 재시도 또는 DLT 전달 경로를 결정합니다.

### 핵심 구성 요소

`@KafkaListener`를 둘러싼 핵심 구성 요소는 크게 세 가지로 나뉩니다. 첫째, **`KafkaListenerContainerFactory`** 는 리스너 컨테이너를 생성하는 팩토리로, 동시성 수준·오프셋 커밋 모드·에러 핸들러 등 대부분의 설정이 이곳에서 결정됩니다. 둘째, **`ConsumerFactory`** 는 카프카 네이티브 컨슈머 설정(부트스트랩 서버, 역직렬화기, `max.poll.records` 등)을 담당합니다. 셋째, **`KafkaListenerEndpointRegistry`** 는 등록된 모든 리스너의 생명주기를 관리하며, 런타임에 리스너를 시작·중지할 수 있는 관리 포인트 역할을 합니다. 이 세 구성 요소는 각각 독립적으로 설정할 수 있어, 서로 다른 토픽에 서로 다른 에러 처리 정책을 적용하는 것이 가능합니다.

| 구성 요소 | 역할 | 주요 설정 |
|---|---|---|
| `KafkaListenerContainerFactory` | 컨테이너 생성 | 동시성, 에러핸들러, 커밋 모드 |
| `ConsumerFactory` | 카프카 클라이언트 설정 | 역직렬화기, 폴링 설정 |
| `KafkaListenerEndpointRegistry` | 리스너 생명주기 관리 | 런타임 시작/중지 |
| `@KafkaListener` | 리스너 메서드 바인딩 | 토픽, 그룹ID, 컨테이너팩토리 |

### 커밋 전략과 오프셋 관리

Spring Kafka는 `AckMode`를 통해 오프셋 커밋 시점을 세밀하게 제어합니다. 기본값인 `BATCH` 모드는 `poll()`로 가져온 배치 전체를 처리한 뒤 커밋하며, 이는 높은 처리량에 유리합니다. 반면 `MANUAL` 또는 `MANUAL_IMMEDIATE` 모드는 비즈니스 로직 내에서 `Acknowledgment.acknowledge()`를 명시적으로 호출해야 커밋이 이루어집니다. 재시도 전략과 결합할 때는 `AckMode` 선택이 특히 중요합니다. `BATCH` 모드에서 배치 중간에 실패가 발생하면 해당 배치 전체를 재처리해야 할 수 있기 때문입니다. 비차단 재시도를 사용할 때는 `RECORD` 모드로 설정하여 처리 단위를 단일 레코드로 좁히는 것이 예측 가능한 동작을 보장합니다. 재시도가 완료되거나 DLT로 전달된 뒤에야 오프셋을 커밋해야 메시지 손실 없이 정확히 한 번 처리에 가까운 동작을 구현할 수 있습니다.

> **핵심 규칙**: 재시도 도입 전에 반드시 `AckMode`를 검토하세요. `BATCH` 모드에서 재시도가 실패하면 해당 배치 전체가 재처리될 수 있습니다.

---

## 재시도 전략 설계 — 동기와 비동기

### 동기 재시도의 구조적 한계

Spring Retry 기반의 **동기 재시도**는 같은 스레드에서 바로 재시도를 반복합니다. 처리하기 쉬운 일시적 오류(예: 짧은 네트워크 지연)에는 효과적이지만, 재시도 간격이 길거나 반복 횟수가 많으면 컨슈머 스레드가 블로킹됩니다. Kafka 클라이언트는 `max.poll.interval.ms`(기본 5분) 내에 다음 `poll()`을 호출해야 하는데, 동기 재시도 중 이 시간을 초과하면 컨슈머가 그룹에서 제외되고 **리밸런싱**이 발생합니다. 이는 같은 파티션을 다른 컨슈머가 재처리하게 만들어 전체 처리 흐름을 교란하며, 최악의 경우 메시지가 반복적으로 처리 실패와 리밸런싱을 반복하는 루프에 빠질 수 있습니다. 또한 동기 재시도 중에는 같은 파티션의 다른 메시지를 처리할 수 없으므로 지연이 선형으로 증가합니다.

```diagram
2026-09-21-5a4b63fa-02
```

동기 재시도는 재시도 간격이 누적될수록 스레드 블로킹과 리밸런싱 위험이 함께 커지는 구조적 한계를 가집니다.

### Non-blocking Retry(비차단 재시도) 설계

Spring Kafka 2.7부터 도입된 **비차단 재시도**는 실패한 메시지를 별도의 **재시도 토픽**으로 전달하여 원본 파티션의 처리를 즉시 재개합니다. 예를 들어 `orders` 토픽의 메시지가 실패하면 `orders-retry-1`, `orders-retry-2`와 같은 내부 토픽으로 메시지가 이동하고, 각 재시도 토픽의 컨슈머가 지정된 딜레이 후 재처리를 시도합니다. 이 방식은 원본 토픽의 처리 흐름을 방해하지 않으므로, 일시적 오류가 전체 파이프라인의 병목이 되는 상황을 원천 차단합니다. 재시도 토픽은 Spring Kafka가 자동으로 생성하며, `RetryTopicConfiguration` 빈 하나로 모든 경로를 선언적으로 정의할 수 있습니다.

`RetryTopicConfiguration`을 설정하는 기본 예시입니다. `RetryTopicConfigurationBuilder`를 활용하면 재시도 횟수·백오프 정책·DLT 핸들러까지 한 곳에서 일관되게 선언할 수 있습니다.

```java
@Configuration
public class KafkaRetryConfig {

    @Bean
    public RetryTopicConfiguration retryTopicConfig(
            KafkaTemplate<String, String> kafkaTemplate) {

        return RetryTopicConfigurationBuilder
            .newInstance()
            .maxAttempts(4)                           // 최초 1회 + 재시도 3회
            .exponentialBackoff(1000, 2.0, 30000)     // 1초 → 2초 → 4초 (최대 30초)
            .notRetryOn(JsonParseException.class,
                        ValidationException.class)    // 즉시 DLT 전달 예외
            .includeTopic("orders")                   // 적용 토픽 한정
            .dltHandlerMethod("orderDltHandler",
                              "handleDlt")            // DLT 핸들러 빈·메서드 지정
            .create(kafkaTemplate);
    }
}

// @KafkaListener는 별도 변경 없이 그대로 사용
@KafkaListener(topics = "orders", groupId = "order-service")
public void processOrder(OrderEvent event) {
    // 실패 시 자동으로 재시도 토픽으로 라우팅됨
    orderService.process(event);
}
```

`maxAttempts(4)`는 원본 토픽 처리 1회를 포함한 총 시도 횟수입니다. `exponentialBackoff`는 첫 재시도 1초, 두 번째 2초, 세 번째 4초로 지수적으로 증가하며, 최대 30초를 넘지 않습니다. 이 방식은 일시적인 외부 서비스 장애에서 빠르게 회복하면서도, 지속적인 오류에는 과부하를 피하는 균형을 제공합니다. `notRetryOn()` 메서드로 지정한 예외는 재시도 없이 바로 DLT로 전달되어 불필요한 반복을 줄입니다.

### 재시도 대상 예외 분류

모든 예외를 재시도 대상으로 삼으면 안 됩니다. **재시도해도 결과가 달라지지 않는 예외**, 예를 들어 역직렬화 오류, 유효성 검사 실패, 비즈니스 규칙 위반 등은 즉시 DLT로 보내는 것이 맞습니다. 반면 `ConnectException`, `SocketTimeoutException` 같은 일시적 인프라 오류는 재시도가 의미 있습니다. 예외 분류를 설계 단계에서 명확히 정의하지 않으면, 재처리 불가한 메시지가 재시도 토픽에서 무한히 맴돌면서 랙을 늘리고 알림 피로도를 높이는 결과로 이어집니다.

| 예외 유형 | 재시도 여부 | 근거 |
|---|---|---|
| `SocketTimeoutException` | ✅ 재시도 | 일시적 네트워크 오류 |
| `ServiceUnavailableException` | ✅ 재시도 | 외부 서비스 일시 장애 |
| `JsonParseException` | ❌ DLT 직행 | 재시도해도 파싱 불가 |
| `ValidationException` | ❌ DLT 직행 | 데이터 자체의 문제 |
| `ConstraintViolationException` | ❌ DLT 직행 | DB 제약 조건 위반 |

---

## Dead Letter Topic 설계와 운영

### DLT의 역할과 설계 원칙

**Dead Letter Topic(DLT)** 은 모든 재시도가 소진된 메시지의 최종 목적지입니다. DLT는 단순히 메시지를 버리지 않고 보존하는 안전망 역할을 하지만, 그 이상의 의미가 있습니다. DLT에 쌓인 메시지는 **서비스 결함의 직접적인 증거**이며, 알림·모니터링·수동 재처리·원인 분석의 출발점이 됩니다. 따라서 DLT는 단순 보관소가 아니라 적극적으로 소비하고 관리해야 하는 토픽으로 설계해야 합니다. DLT 메시지에는 원본 토픽, 파티션, 오프셋, 마지막 예외 메시지, 재시도 횟수 같은 메타데이터가 헤더로 자동 포함되므로, 핸들러에서 이를 활용해 알림 분류나 원인별 처리를 구현할 수 있습니다. 예를 들어 `ValidationException`으로 실패한 메시지와 `ConnectException`으로 실패한 메시지는 처리 우선순위가 다르기 때문에, 예외 유형별로 분기된 후처리 로직이 있어야 운영 효율이 높아집니다.

```diagram
2026-09-21-5a4b63fa-03
```

DLT는 단순 보관이 아니라 알림·기록·재처리 분기까지 포함하는 능동적인 처리 경로로 설계해야 합니다.

### DLT 핸들러 구현

DLT 핸들러는 `@DltHandler` 어노테이션으로 지정하며, 원본 메시지 페이로드와 함께 Spring Kafka가 자동으로 추가하는 진단 헤더에 접근할 수 있습니다. 헤더에서 예외 정보와 원본 오프셋을 추출하여 모니터링 시스템에 기록하는 예시입니다.

```java
@Component
public class OrderDltHandler {

    private static final Logger log =
            LoggerFactory.getLogger(OrderDltHandler.class);

    @DltHandler
    public void handleDlt(
            OrderEvent event,
            @Header(KafkaHeaders.RECEIVED_TOPIC) String topic,
            @Header(KafkaHeaders.EXCEPTION_MESSAGE) String exMessage,
            @Header(KafkaHeaders.ORIGINAL_OFFSET) long originalOffset) {

        log.error("[DLT] 최종 처리 실패 | topic={}, offset={}, error={}",
                topic, originalOffset, exMessage);

        // 장애 기록 저장 및 알림 발송
        failureRecordService.save(
                FailureRecord.of(event, topic, originalOffset, exMessage));
        alertService.sendDltAlert(topic, exMessage);

        // 예외를 던지지 않아야 DLT 오프셋이 정상 커밋됨
    }
}
```

핸들러에서 예외를 다시 던지지 않는 것이 중요합니다. DLT 핸들러에서도 예외가 발생하면 해당 메시지는 DLT에서 무한 재시도 상태가 될 수 있습니다. DLT 핸들러는 **항상 성공으로 완료**되어야 하며, 내부 오류는 로깅이나 별도 알림으로만 처리해야 합니다. 이 규칙은 DLT 설계에서 가장 쉽게 놓치는 부분이면서, 놓쳤을 때 파악하기 어려운 장애로 이어지는 함정입니다.

### DLT 메시지 재처리 전략

운영 환경에서는 DLT에 쌓인 메시지를 주기적으로 검토하고, 원인이 해소된 메시지를 원본 토픽으로 재발행하는 과정이 필요합니다. 재발행 방식은 크게 두 가지입니다. 첫 번째는 **수동 재발행**으로, 운영자가 DLT 메시지를 확인 후 카프카 CLI나 내부 관리 도구로 원본 토픽에 다시 넣는 방식입니다. 두 번째는 **자동 재발행**으로, DLT 핸들러가 특정 예외 유형이나 조건에 따라 `KafkaTemplate`으로 원본 토픽에 재발행하는 방식입니다. 자동 재발행은 무한 루프 위험이 있으므로 반드시 재발행 횟수 카운터와 상한선을 두어야 합니다. 재발행 시에는 비즈니스 레이어에 **멱등성**이 구현되어 있어야 중복 처리 문제를 피할 수 있습니다. 실제 프로젝트에서는 수동 재발행을 기본으로 하고, 명확히 일시적인 오류(예: DB 다운 후 복구)에 한해 제한된 자동 재발행을 적용하는 것이 안전합니다.

> **주의**: DLT 메시지를 원본 토픽에 재발행할 때는 비즈니스 레이어에 **중복 처리 방지 로직(멱등성)** 이 반드시 구현되어 있어야 합니다.

---

## 동시성 설정과 파티션 전략

### 동시성의 의미와 한계

`ConcurrentMessageListenerContainer`의 `concurrency` 설정은 내부적으로 여러 `KafkaMessageListenerContainer` 인스턴스를 생성합니다. 각 인스턴스는 독립적인 스레드에서 실행되며, 파티션을 할당받아 독립적으로 메시지를 소비합니다. 핵심은 **동시성 수준이 파티션 수를 초과할 수 없다**는 점입니다. 예를 들어 `orders` 토픽의 파티션이 6개이고 `concurrency`를 8로 설정해도, 실제로 활성화되는 컨슈머 스레드는 6개를 넘지 않습니다. 나머지 2개는 유휴 상태로 대기합니다. 반대로 `concurrency`가 파티션 수보다 적으면, 하나의 스레드가 여러 파티션을 처리합니다. 이 경우 특정 파티션에서 오류가 발생해 처리가 지연되면 같은 스레드가 담당하는 다른 파티션도 함께 지연됩니다.

```diagram
2026-09-21-5a4b63fa-04
```

파티션 6개에 동시성 3으로 설정하면 스레드 하나가 두 파티션을 처리하므로, 한 파티션의 지연이 같은 스레드의 다른 파티션에도 전파됩니다.

### ConcurrentKafkaListenerContainerFactory 설정

동시성과 에러 처리를 함께 고려한 팩토리 설정 예시입니다. 비차단 재시도를 사용할 때는 `RetryTopicConfiguration`이 자동으로 에러 핸들링을 주입하므로, 별도의 `DefaultErrorHandler`를 중복 설정하지 않도록 주의해야 합니다.

```java
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, String>
            kafkaListenerContainerFactory(
                    ConsumerFactory<String, String> consumerFactory) {

        var factory =
                new ConcurrentKafkaListenerContainerFactory<String, String>();

        factory.setConsumerFactory(consumerFactory);
        factory.setConcurrency(3);  // 파티션 수 이하로 설정
        factory.getContainerProperties()
               .setAckMode(ContainerProperties.AckMode.RECORD); // 레코드 단위 커밋

        // 비차단 재시도 사용 시 RetryTopicConfiguration이
        // 에러 핸들러를 자동 설정 — 별도 DefaultErrorHandler 불필요

        return factory;
    }
}
```

`AckMode.RECORD`는 레코드 하나를 처리할 때마다 오프셋을 커밋합니다. 처리량은 `BATCH`보다 낮지만, 실패 시 재처리 범위가 단일 레코드로 좁혀지므로 재시도 로직과 결합할 때 훨씬 예측 가능한 동작을 보장합니다.

### 파티션 수와 동시성의 균형

운영 환경에서 동시성 설정을 결정할 때는 세 가지 요소를 함께 고려해야 합니다. 첫째, **메시지 처리 시간**입니다. 각 메시지 처리에 100ms가 걸리고 초당 1000개를 처리해야 한다면, 최소 100개의 병렬 처리가 필요합니다. 이는 파티션 수와 컨슈머 인스턴스 수의 곱으로 충당해야 합니다. 둘째, **외부 의존성**입니다. 데이터베이스 커넥션 풀이나 외부 API 호출 한계가 동시성 상한을 제한합니다. 스레드를 늘려도 DB 커넥션이 부족하면 오히려 경합이 발생합니다. 셋째, **리밸런싱 비용**입니다. 동시성이 높을수록 컨슈머 그룹 멤버가 많아지고, 그 중 하나가 실패하면 리밸런싱 영향 범위도 커집니다.

| 파티션 수 | 인스턴스 수 | concurrency | 실제 활성 스레드 | 비고 |
|---|---|---|---|---|
| 6 | 1 | 6 | 6 | 단일 인스턴스 최적 |
| 6 | 2 | 3 | 3×2=6 | 수평 확장 시 파티션 균등 분배 |
| 6 | 3 | 2 | 2×3=6 | 인스턴스 장애 시 나머지가 흡수 |
| 6 | 1 | 10 | 6 | 초과 설정, 4스레드 유휴 낭비 |

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

비차단 재시도를 처음 도입할 때 가장 흔한 실수는 **재시도 토픽 자동 생성 실패를 감지하지 못하는 경우**입니다. Spring Kafka는 기본적으로 재시도 토픽을 자동으로 생성하지만, 카프카 브로커의 `auto.create.topics.enable=false` 설정이나 ACL 제한이 있으면 실패합니다. 이때는 `RetryTopicConfigurationBuilder`에서 `autoCreateTopics(false)`를 명시하고, Terraform이나 Helm 차트로 미리 토픽을 프로비저닝하는 것이 안전합니다. 재시도 토픽 생성 실패는 애플리케이션 시작 시점에 명확한 예외를 발생시키지 않는 경우가 있어, 조용히 재시도 기능 전체가 비활성화될 수 있습니다.

또 하나의 함정은 **`@KafkaListener`에 `containerFactory`를 명시하지 않고 여러 팩토리를 혼용하는 경우**입니다. `RetryTopicConfiguration`은 특정 팩토리와 연계되며, 잘못된 팩토리로 생성된 리스너는 재시도 설정이 적용되지 않아 에러가 조용히 누락됩니다. 여러 토픽에 서로 다른 재시도 정책을 적용한다면 팩토리 이름을 명시적으로 구분하고 `@KafkaListener(containerFactory = "retryFactory")`처럼 연결을 명확히 해야 합니다.

```diagram
2026-09-21-5a4b63fa-05
```

`containerFactory`를 명시하지 않으면 기본 팩토리가 사용되어 재시도 설정이 조용히 무시되는 위험이 있습니다.

### 모니터링과 디버깅

운영 환경에서 컨슈머 상태를 추적할 때 가장 중요한 지표는 **컨슈머 그룹 랙(lag)** 입니다. 랙은 해당 파티션의 최신 오프셋과 컨슈머가 현재 읽은 오프셋의 차이로, 처리 속도가 수신 속도를 따라가지 못할 때 증가합니다. Prometheus와 Micrometer를 연동하면 Spring Kafka가 `kafka.consumer.fetch-manager.records-lag-max` 같은 메트릭을 자동으로 노출합니다. 재시도 토픽과 DLT에 대해서도 별도의 컨슈머 그룹으로 랙을 추적해야 합니다. DLT 랙이 꾸준히 증가한다면 특정 유형의 메시지가 반복적으로 처리 불가 상태임을 의미하며, 즉각적인 조사가 필요합니다.

| 지표 | 이상 징후 | 대응 방향 |
|---|---|---|
| `records-lag-max` 지속 증가 | 처리 속도 부족 | 동시성 또는 파티션 수 증가 |
| DLT 토픽 랙 증가 | 처리 불가 메시지 누적 | 원인 예외 분석, 재처리 계획 |
| 재시도 토픽 랙 과다 | 백오프 딜레이 비효율 | 재시도 횟수·딜레이 재설정 |
| `poll-interval-exceeded` 로그 | max.poll.interval.ms 초과 | 처리 로직 최적화 또는 설정값 증가 |

디버깅 초기에는 `logging.level.org.springframework.kafka=DEBUG`를 설정하여 리스너 컨테이너의 상세 동작을 확인하는 것을 권장합니다. 특히 비차단 재시도 도입 직후에는 재시도 토픽 라우팅이 예상대로 동작하는지 로그로 먼저 검증해야, 설정 오류를 트래픽이 증가하기 전에 잡을 수 있습니다.

### 확장과 마이그레이션

서비스 트래픽이 증가할 때 컨슈머를 수평으로 확장하는 가장 안전한 방법은 **같은 컨슈머 그룹 ID를 사용하는 인스턴스를 추가**하는 것입니다. 파티션이 남아 있다면 새 인스턴스가 자동으로 파티션을 할당받습니다. 그러나 이 과정에서 **리밸런싱이 발생하여 짧은 처리 중단**이 생깁니다. Kafka 2.4+에서 도입된 **Cooperative Sticky Assignor**를 사용하면 리밸런싱 중에도 불필요한 파티션 이동을 최소화하여 처리 중단 시간을 줄일 수 있습니다. `partition.assignment.strategy=org.apache.kafka.clients.consumer.CooperativeStickyAssignor`로 설정하면 기존 Eager 방식 대비 처리 중단 시간을 크게 단축할 수 있습니다.

기존 동기 재시도 설정에서 비차단 재시도로 마이그레이션하는 경우, 재시도 토픽 이름 패턴(`<원본토픽>-retry-<n>`)이 기존 운영 토픽과 충돌하는지 먼저 확인해야 합니다. `RetryTopicConfigurationBuilder`의 `retryTopicSuffix()` 메서드로 접미사를 커스터마이징하면 충돌을 방지할 수 있습니다.

```diagram
2026-09-21-5a4b63fa-06
```

마이그레이션은 파티션 충분 여부 확인 → 비차단 재시도 설정 추가 → 재시도 토픽 생성 확인 → 기존 핸들러 비활성화 순서로 진행합니다.

---

## 맺음말

### 핵심 요약

`@KafkaListener` 컨슈머 설계에서 가장 중요한 세 축은 **재시도 전략**, **DLT 관리**, **동시성 설정**입니다. 비차단 재시도는 동기 재시도의 스레드 블로킹 문제를 구조적으로 제거하며, Spring Kafka 2.7 이후 환경에서는 `RetryTopicConfiguration`을 통해 선언적으로 적용할 수 있습니다. DLT는 단순 보관소가 아니라 서비스 결함 신호를 받아 알림·기록·재처리 분기를 수행하는 능동적 경로로 설계해야 하며, DLT 핸들러는 반드시 예외 없이 완료되도록 구현해야 합니다. 동시성은 파티션 수, 처리 시간, 외부 의존성의 세 요소를 동시에 고려해야 하며, 단순히 높이는 것이 능사가 아닙니다. 또한 재시도 토픽 자동 생성 여부, `AckMode` 선택, `containerFactory` 명시 같은 설정 세부 사항을 빠뜨리면 에러가 조용히 누락되는 운영 사고로 이어질 수 있습니다.

### 적용 판단 기준

비차단 재시도 도입이 가장 효과적인 상황은 **외부 서비스 의존성이 높고 일시적 장애가 빈번한 환경**입니다. 결제 처리, 이메일 발송, 외부 API 연동처럼 순간적인 오류가 발생해도 메시지를 잃어서는 안 되는 경우에 DLT와 비차단 재시도 조합이 필수입니다. 반면 메시지 처리가 완전히 멱등하고 실패 시 단순 무시해도 비즈니스 문제가 없는 경우에는 복잡한 재시도 설정보다 단순한 로깅과 알림이 더 적합할 수 있습니다. 동시성 설정은 항상 부하 테스트 결과를 기반으로 결정하되, 파티션 수보다 많게 설정하는 것은 자원 낭비이므로 피해야 합니다. 재시도와 DLT 설계는 장애가 발생한 후에 추가하는 것이 아니라, 컨슈머를 처음 설계할 때부터 포함해야 하는 요소입니다.
