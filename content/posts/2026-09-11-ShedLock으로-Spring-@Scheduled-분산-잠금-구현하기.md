---
title: "ShedLock으로 Spring @Scheduled 분산 잠금 구현하기"
date: "2026-09-11"
category: "Spring"
tags: ["ShedLock으로 Spring @Scheduled 분산 잠금 구현하기", "Spring", "ShedLock", "Scheduled"]
excerpt: "수평 확장(horizontal scaling)이 보편화된 현재 서비스 환경에서 @Scheduled 애노테이션은 의외로 위험한 존재가 될 수 있습니다."
---

## 목차

1. 개요
2. ShedLock의 동작 원리
3. ShedLock 설정과 기본 구현
4. 심화 — 잠금 전략과 트레이드오프
5. 운영 환경 적용 시 고려사항
6. 맺음말

---

## 개요

### 분산 환경에서의 스케줄링 문제

수평 확장(horizontal scaling)이 보편화된 현재 서비스 환경에서 `@Scheduled` 애노테이션은 의외로 위험한 존재가 될 수 있습니다. Spring의 `@Scheduled`는 단일 JVM 프로세스 안에서는 문제없이 동작하지만, 동일한 애플리케이션이 여러 인스턴스로 동시에 실행될 때는 각 인스턴스가 독립적으로 스케줄러를 기동시켜 동일한 작업을 중복 실행하는 문제가 발생합니다. 예를 들어 매일 오전 2시에 정산 배치를 돌리는 작업이 있다면, 3개 인스턴스가 떠 있을 때 정산이 세 번 실행되는 상황을 막아야 합니다. **ShedLock**은 바로 이 문제를 해결하기 위해 설계된 분산 잠금 라이브러리입니다.

분산 환경에서 스케줄 작업을 제어하는 방법에는 여러 가지가 있습니다. Quartz Scheduler처럼 클러스터링을 기본 지원하는 전용 솔루션을 쓰거나, Kubernetes의 CronJob처럼 인프라 수준에서 단일 실행을 보장하거나, 또는 Redis나 데이터베이스를 통한 분산 잠금을 직접 구현할 수도 있습니다. 하지만 이 모든 방법에는 기존 코드베이스에 대한 상당한 침습적 변경이 수반됩니다. ShedLock은 이미 `@Scheduled`로 작성된 코드를 거의 손대지 않고, 애노테이션 하나 추가만으로 분산 잠금을 적용할 수 있다는 점에서 현업 전환 비용이 매우 낮습니다.

---

### 기존 방식의 한계

`@Scheduled`의 중복 실행 문제를 가장 먼저 떠오르는 방법으로 해결하려 하면 몇 가지 함정에 빠지기 쉽습니다. 첫 번째로, "리더 선출(leader election)" 방식을 생각해볼 수 있습니다. 특정 인스턴스를 리더로 지정하고 리더에서만 스케줄러가 동작하도록 하는 전략입니다. Spring Cloud의 `@ConditionalOnProperty`나 Kubernetes의 Lease 리소스를 이용해 구현할 수 있지만, 리더 장애 시 페일오버 로직이 복잡해지고, 리더 전환 과정에서 작업이 누락되거나 이중 실행될 가능성이 남습니다.

두 번째로, Redis의 `SETNX` 명령을 직접 사용하는 수제 분산 잠금입니다. 빠르고 단순해 보이지만, 잠금 만료 시간 설정, 잠금 보유 중 인스턴스 크래시 시 처리, 네트워크 파티션 상황에서의 일관성 등을 모두 직접 구현해야 합니다. 결국 Redlock 알고리즘까지 고려하다 보면 구현 복잡도가 급격히 높아집니다. ShedLock은 이런 엣지 케이스를 이미 내부에서 처리하고, JDBC, MongoDB, Redis, ZooKeeper 등 다양한 잠금 저장소를 교환 가능한 플러그인 방식으로 지원합니다.

| 방식 | 코드 변경 범위 | 잠금 일관성 | 장애 복구 | 운영 복잡도 |
|---|---|---|---|---|
| `@Scheduled` 그대로 | 없음 | ❌ 중복 실행 | 해당 없음 | 낮음 |
| 리더 선출 | 크다 | △ 전환 구간 위험 | 수동 설정 필요 | 높음 |
| Redis 직접 구현 | 중간 | △ 직접 보장 필요 | 직접 구현 | 중간 |
| Quartz 클러스터 | 크다 | ✅ | ✅ | 높음 |
| **ShedLock** | **매우 작다** | **✅** | **✅ 자동** | **낮음** |

---

## ShedLock의 동작 원리

### 잠금 메커니즘 이해

ShedLock의 핵심 원리는 단순합니다. 작업이 실행되기 전에 공유 저장소(데이터베이스 또는 캐시)에 잠금 레코드를 삽입하거나 갱신하고, 해당 레코드가 이미 존재하면서 유효 시간이 남아 있으면 현재 인스턴스는 실행을 포기합니다. 작업이 완료되면 잠금 레코드의 `locked_at`과 `lock_until` 필드를 갱신하여 다른 인스턴스가 다음 주기에 잠금을 얻을 수 있도록 합니다.

중요한 점은 ShedLock이 **잠금 기반(lock-based)** 이지 **조율 기반(coordination-based)** 이 아니라는 것입니다. 즉, 분산 합의(distributed consensus)를 추구하지 않고, 단순히 "이 시점에 잠금을 선점한 인스턴스가 실행된다"는 낙관적 선점 방식을 택합니다. 덕분에 ZooKeeper나 etcd 같은 강한 일관성 코디네이터 없이도 실용적인 수준의 중복 방지가 가능합니다. 다만 완벽한 엄밀성(strict linearizability)은 보장하지 않으므로, 절대적으로 단 한 번만 실행되어야 하는 금융 결제처럼 강한 보장이 필요한 경우에는 이 한계를 인식해야 합니다.

> 💡 **핵심 규칙**: ShedLock은 "최대 하나"(at-most-once)를 목표로 하지, "정확히 하나"(exactly-once)를 보장하지 않습니다. 잠금 만료 후 재실행은 여전히 가능합니다.

---

### 주요 구성 요소

ShedLock은 세 가지 핵심 구성 요소로 이루어져 있습니다.

첫째로 `LockProvider`입니다. 잠금 저장소와의 실제 통신을 담당하는 인터페이스로, JDBC(`JdbcTemplateLockProvider`), MongoDB(`MongoLockProvider`), Redis(`RedisLockProvider`) 등 구현체가 존재합니다. 애플리케이션은 `LockProvider` 빈만 교체하면 저장소를 바꿀 수 있어 이식성이 높습니다.

둘째로 `@SchedulerLock` 애노테이션입니다. `@Scheduled` 메서드 위에 함께 선언하며, `name`, `lockAtMostFor`, `lockAtLeastFor` 세 가지 핵심 속성을 가집니다. `name`은 잠금을 구분하는 유일 식별자, `lockAtMostFor`는 이 시간이 지나면 잠금을 강제 해제하는 안전망, `lockAtLeastFor`는 작업이 빨리 끝나도 이 시간 동안 잠금을 유지하여 시계 오차로 인한 이중 실행을 방지합니다.

셋째로 `LockingTaskExecutor`와 AOP 프록시입니다. `@EnableSchedulerLock` 애노테이션 선언 시 ShedLock은 Spring AOP를 통해 `@SchedulerLock`이 달린 메서드를 인터셉트하고, 잠금 획득 → 메서드 실행 → 잠금 해제의 생명주기를 자동 관리합니다.

| 구성 요소 | 역할 | 교체 가능 여부 |
|---|---|---|
| `LockProvider` | 저장소 연동, 잠금 CAS 연산 | ✅ (저장소별 구현체 교체) |
| `@SchedulerLock` | 잠금 이름·만료 정책 선언 | N/A (애노테이션) |
| AOP 인터셉터 | 잠금 생명주기 관리 | △ (커스텀 래퍼 가능) |
| `shedlock` 테이블 | 잠금 상태 영속 | △ (스키마 커스터마이즈 가능) |

---

### 데이터 흐름

ShedLock을 사용할 때 스케줄 작업의 실행 흐름은 다음과 같습니다.

```
[스케줄러 트리거]
       │
       ▼
[AOP 인터셉터 진입]
       │
       ▼
[LockProvider.lock() 호출]
  ├── 잠금 레코드 없음 → INSERT 성공 → 잠금 획득
  ├── 레코드 있고 lock_until 만료됨 → UPDATE 성공 → 잠금 획득
  └── 레코드 있고 lock_until 유효 → 획득 실패 → 실행 포기
       │
       ▼ (잠금 획득 성공)
[실제 @Scheduled 메서드 실행]
       │
       ▼
[LockProvider.unlock() 호출]
  └── lock_until = now + lockAtLeastFor (또는 now)
```

이 흐름에서 `INSERT`나 `UPDATE`는 데이터베이스의 트랜잭션 격리와 유니크 제약을 활용해 원자적으로 처리됩니다. 두 인스턴스가 동시에 잠금을 시도하더라도 데이터베이스 레벨에서 하나만 성공하도록 보장되므로 별도의 분산 합의 알고리즘 없이 중복 실행을 차단할 수 있습니다.

---

## ShedLock 설정과 기본 구현

### 의존성 및 데이터베이스 설정

ShedLock을 JDBC 환경에서 시작하려면 두 가지 의존성을 추가해야 합니다. `shedlock-spring`은 Spring 통합과 `@EnableSchedulerLock` 지원을 제공하고, `shedlock-provider-jdbc-template`은 `JdbcTemplate` 기반의 `LockProvider` 구현체를 포함합니다. 두 아티팩트 모두 `net.javacrumbs.shedlock` 그룹 아래에 있으며, 현재 안정 버전은 5.x 대입니다.

의존성 추가 후 `shedlock` 테이블을 데이터베이스에 생성해야 합니다. ShedLock은 자동으로 테이블을 생성하지 않으므로 DDL을 직접 실행해야 합니다. 이 테이블에는 `name`(잠금 이름, PK), `lock_until`(잠금 만료 시각), `locked_at`(잠금 획득 시각), `locked_by`(잠금 획득 인스턴스 식별자) 네 개의 컬럼이 필요합니다.

```sql
-- PostgreSQL / MySQL 공통 스키마
CREATE TABLE shedlock (
    name        VARCHAR(64)  NOT NULL,
    lock_until  TIMESTAMP    NOT NULL,
    locked_at   TIMESTAMP    NOT NULL,
    locked_by   VARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
```

`locked_by`에는 기본적으로 호스트명이 기록되므로, 같은 호스트에서 여러 인스턴스를 띄울 경우 인스턴스를 구분할 수 없다는 주의점이 있습니다. 이럴 때는 `LockProvider` 설정에서 `usingDbTime()` 메서드를 조합하거나, 애플리케이션 시작 시 UUID를 `locked_by`에 주입하는 커스텀 설정을 고려해야 합니다.

---

### 핵심 구현

Spring Boot 프로젝트에서 ShedLock을 활성화하는 가장 기본적인 형태의 설정입니다. `@EnableSchedulerLock`의 `defaultLockAtMostFor` 속성은 개별 `@SchedulerLock` 애노테이션에 `lockAtMostFor`를 명시하지 않았을 때 적용되는 전역 기본값입니다.

```java
// ShedLockConfig.java
@Configuration
@EnableScheduling
@EnableSchedulerLock(defaultLockAtMostFor = "PT30M") // 기본 최대 잠금 시간: 30분
public class ShedLockConfig {

    @Bean
    public LockProvider lockProvider(DataSource dataSource) {
        return new JdbcTemplateLockProvider(
            JdbcTemplateLockProvider.Configuration.builder()
                .withJdbcTemplate(new JdbcTemplate(dataSource))
                .usingDbTime() // 애플리케이션 시계 대신 DB 시계 사용 (권장)
                .build()
        );
    }
}

// ScheduledTasks.java
@Component
@Slf4j
public class ScheduledTasks {

    @Scheduled(cron = "0 0 2 * * *") // 매일 오전 2시
    @SchedulerLock(
        name = "dailySettlementTask",   // 잠금 레코드 name 컬럼 값
        lockAtMostFor = "PT1H",          // 최대 1시간 잠금 유지
        lockAtLeastFor = "PT30S"         // 최소 30초 잠금 유지
    )
    public void runDailySettlement() {
        log.info("정산 배치 시작 - 인스턴스: {}", InetAddress.getLocalHost().getHostName());
        // 실제 정산 로직
        // 결과: 잠금 획득 인스턴스에서만 실행, 나머지는 로그 없이 건너뜀
    }
}
```

`usingDbTime()`을 사용하는 이유가 중요합니다. 여러 인스턴스 간 시스템 시계는 수 초 이상 차이날 수 있으며, 이 오차가 `lock_until` 만료 판단에 영향을 줍니다. DB 시간을 기준으로 삼으면 모든 인스턴스가 동일한 시간 기준을 공유하므로 시계 드리프트(clock drift)에 의한 이중 실행 가능성을 제거할 수 있습니다.

---

### 잠금 공급자 선택

애플리케이션이 이미 Redis를 사용한다면 별도의 DB 테이블 없이 `RedisLockProvider`를 선택하는 것이 자연스럽습니다. MongoDB 환경이라면 `MongoLockProvider`가 있습니다. 선택 시 가장 먼저 고려해야 할 것은 저장소의 내구성과 운영 부담입니다.

| 저장소 | 구현체 | 내구성 | 추가 인프라 | 권장 시나리오 |
|---|---|---|---|---|
| JDBC (RDB) | `JdbcTemplateLockProvider` | 높음 | 없음 (기존 DB) | 대부분의 Spring 앱 |
| Redis | `RedisLockProvider` | 중간 (AOF 설정에 따라) | Redis 필요 | Redis 이미 사용 중 |
| MongoDB | `MongoLockProvider` | 높음 | MongoDB 필요 | Mongo 기반 서비스 |
| ZooKeeper | `ZookeeperCuratorLockProvider` | 높음 | ZooKeeper 필요 | 강한 일관성 필요 시 |
| In-memory | `InMemoryLockProvider` | 없음 | 없음 | **테스트 전용** |

> ⚠️ **주의**: `InMemoryLockProvider`는 프로세스 재시작 시 잠금 정보가 사라집니다. 운영 환경에서는 절대 사용해서는 안 됩니다.

---

## 심화 — 잠금 전략과 트레이드오프

### lockAtMostFor와 lockAtLeastFor의 역할

이 두 속성은 ShedLock 사용에서 가장 많이 오해받는 부분입니다. `lockAtMostFor`는 **안전망(safety net)** 역할을 합니다. 잠금을 보유한 인스턴스가 작업 도중 크래시하거나 무한 루프에 빠지면 잠금을 영구적으로 점유하게 됩니다. 이를 방지하기 위해 이 시간이 지나면 잠금이 강제 해제되어 다른 인스턴스가 다음 실행 주기에 작업을 이어받을 수 있습니다. 따라서 `lockAtMostFor`는 **예상 최대 실행 시간보다 충분히 크게** 설정해야 합니다.

`lockAtLeastFor`는 반대 방향의 보호 장치입니다. 작업이 너무 빨리 완료되어 잠금을 즉시 해제했을 때, 시스템 시계 오차가 있는 다른 인스턴스가 "아직 다음 주기가 됐다"고 판단하여 같은 작업을 재실행하는 상황을 막습니다. 특히 `fixedRate`나 `fixedDelay` 방식의 고빈도 스케줄 작업에서 이 설정이 중요합니다. 매 30초마다 실행되는 작업이 3초 만에 끝난다면, `lockAtLeastFor = "PT25S"` 정도로 설정하여 다음 주기 시작 전까지 잠금을 유지해야 합니다.

```
[잠금 타임라인 예시: cron 매 1분, 실행 시간 5초]

 00:00   00:05       00:30           01:00
   │       │           │               │
   ▼       ▼           ▼               ▼
  [잠금] [완료]   [lockAtLeastFor]   [다음 실행]
   │◄────────────────────►│
         잠금 유지 구간
         (lockAtLeastFor = "PT30S" 설정 시)
```

이처럼 두 속성을 적절히 조합하면 "너무 오래 잠겨 있는" 문제와 "너무 빨리 풀려 이중 실행되는" 문제를 동시에 방지할 수 있습니다.

---

### 대안 기술과 비교

ShedLock과 가장 자주 비교되는 기술은 **Quartz Scheduler**입니다. Quartz는 JDBC 기반 클러스터링을 공식 지원하며, 단 하나의 노드에서만 잡(job)이 실행되도록 보장합니다. 잡 이력 관리, 트리거 재시도, 미스파이어(misfire) 처리 같은 엔터프라이즈 기능도 포함합니다. 그러나 이를 위해 10개 이상의 전용 테이블과 복잡한 설정이 필요하며, 기존 `@Scheduled` 코드를 Quartz Job 인터페이스로 전면 재작성해야 합니다.

**Spring Batch**도 종종 언급됩니다. 배치 작업 정의, 단계(step) 관리, 재시작 지원, 파티셔닝 등 배치 특화 기능이 있지만, 마찬가지로 전용 메타데이터 테이블과 아키텍처 변경을 수반합니다. 단순히 "중복 실행 방지"가 목적이라면 과잉 설계가 됩니다.

| 기준 | ShedLock | Quartz Cluster | Spring Batch |
|---|---|---|---|
| 기존 `@Scheduled` 유지 | ✅ | ❌ 전면 재작성 | ❌ 전면 재작성 |
| 잠금 일관성 | 실용적 수준 | 강함 | 강함 |
| 미스파이어 처리 | ❌ 미지원 | ✅ | ✅ |
| 잡 이력·모니터링 | ❌ 기본 없음 | ✅ | ✅ |
| 추가 테이블 수 | 1개 | 11개 | 6~9개 |
| 도입 난이도 | 낮음 | 높음 | 매우 높음 |

---

### 언제 ShedLock을 선택할 것인가

ShedLock이 적합한 시나리오는 **기존 `@Scheduled` 기반 코드를 유지하면서 다중 인스턴스 환경으로 전환**할 때입니다. 작업이 멱등성(idempotency)을 갖추고 있거나 비즈니스 도메인에서 "정확히 한 번"의 강한 보장보다 "대체로 한 번"이 수용 가능한 경우 ShedLock은 최소 비용으로 최대 효과를 냅니다.

반면 다음 상황에서는 ShedLock 대신 강력한 솔루션을 검토해야 합니다. 첫째, 작업이 매우 짧은 간격(수 초 이하)으로 반복되면서 이중 실행이 절대 허용되지 않는 경우입니다. 둘째, 작업 실패 시 자동 재시도가 반드시 필요한 경우입니다. 셋째, 작업 실행 이력을 장기간 추적·감사해야 하는 컴플라이언스 요구사항이 있는 경우입니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

**함정 1: `lockAtMostFor`를 너무 짧게 설정하는 경우**. 처리 대상 데이터가 폭발적으로 증가하거나 외부 API 응답이 느려지면 작업 실행 시간이 평소보다 크게 늘어날 수 있습니다. `lockAtMostFor`가 이보다 짧으면 잠금이 중간에 해제되어 두 번째 인스턴스가 같은 작업에 진입하게 됩니다. 처음 설정 시 예상 최대 실행 시간의 2배 이상을 여유 있게 잡고, 실제 모니터링 데이터를 보며 조정하는 것을 권장합니다.

**함정 2: `name` 속성에 공백이나 특수문자 사용**. `shedlock` 테이블의 `name` 컬럼은 VARCHAR(64)이며 PK입니다. 이름이 64자를 초과하거나 데이터베이스가 특정 문자를 허용하지 않으면 삽입 오류가 발생하고 잠금 자체가 무력화됩니다. 이름은 항상 영문, 숫자, 언더스코어, 하이픈만 사용하고 62자 이내로 유지하는 것이 안전합니다.

**함정 3: 스프링 트랜잭션과의 충돌**. `@Scheduled` 메서드에 `@Transactional`이 함께 선언된 경우, ShedLock AOP 인터셉터와 Spring 트랜잭션 AOP의 실행 순서가 예상과 다를 수 있습니다. ShedLock은 트랜잭션 커밋 이전에 잠금을 획득하므로, 메서드 실행 중 트랜잭션이 롤백되더라도 ShedLock 잠금은 유지됩니다. 이는 의도된 동작이지만, 롤백 후에도 다른 인스턴스가 재시도하지 못하는 상황이 발생할 수 있으므로 트랜잭션 경계와 잠금 경계를 명확히 이해해야 합니다.

**함정 4: 배포 직후 잠금 레코드 부재로 인한 첫 실행 지연**. 신규 작업의 첫 번째 실행 때는 `shedlock` 테이블에 해당 `name`의 레코드가 없으므로 문제없이 실행됩니다. 하지만 이전 버전에서 오래된 `lockAtMostFor`가 설정된 레코드가 남아 있으면, 신규 배포 직후에 해당 잠금이 만료될 때까지 실행이 지연될 수 있습니다. 배포 스크립트에 `shedlock` 테이블의 특정 레코드를 정리하는 단계를 포함하거나, `lockAtMostFor`를 적절히 짧게 설정하는 것으로 이 문제를 완화할 수 있습니다.

---

### 모니터링과 디버깅

운영 환경에서 ShedLock 관련 문제를 진단할 때는 `shedlock` 테이블의 레코드가 첫 번째 단서입니다. `lock_until` 값이 현재 시각보다 매우 먼 미래를 가리키고 있다면, 잠금을 보유한 인스턴스가 작업 중이거나 크래시 후 잠금 해제를 못 한 상태입니다. `locked_by` 컬럼의 호스트명을 보고 해당 인스턴스의 상태를 확인한 뒤, 필요하면 레코드의 `lock_until`을 수동으로 과거 시각으로 업데이트하여 잠금을 강제 해제할 수 있습니다.

ShedLock 자체는 로그를 많이 남기지 않으므로, 로깅 수준 조정이 필요할 때는 `net.javacrumbs.shedlock` 패키지를 `DEBUG`로 설정하면 잠금 획득·해제 이벤트를 상세히 볼 수 있습니다. 아울러 `@Scheduled` 메서드 내부에 메트릭을 직접 계측하는 것도 좋습니다. Micrometer를 사용한다면 `Timer`와 `Counter`로 실행 횟수와 실행 시간을 측정하여, 특정 인스턴스에서 실행이 편중되거나 지나치게 오래 걸리는 경향을 조기에 감지할 수 있습니다.

| 증상 | 확인 위치 | 조치 |
|---|---|---|
| 모든 인스턴스에서 작업 실행 안 됨 | `shedlock` 레코드 `lock_until` | 만료 전 레코드 수동 초기화 |
| 특정 인스턴스에서만 작업 실행 | 정상 동작 (리더 선점) | 모니터링만 |
| 잠금 만료 후에도 재실행 없음 | `@Scheduled` cron 표현식 | 다음 트리거 주기 확인 |
| 이중 실행 발생 | `lockAtMostFor` 값 | 실행 시간보다 충분히 크게 조정 |
| DB 연결 실패로 잠금 못 얻음 | 애플리케이션 로그 | DB 가용성 점검, 재시도 전략 수립 |

---

### 확장 전략

인스턴스 수가 늘어날수록 `shedlock` 테이블에 대한 동시 쓰기 경합이 증가합니다. 대부분의 운영 환경에서는 수십 개의 스케줄 작업이 동시에 트리거되더라도 `shedlock` 테이블의 부하는 무시할 수 있는 수준입니다. 그러나 인스턴스가 수백 개에 달하거나 스케줄 작업 수가 수백 개를 넘어가는 대규모 환경이라면 Redis `LockProvider`가 더 나은 선택일 수 있습니다. Redis의 원자적 `SET NX` 연산은 RDB의 행 잠금보다 처리량이 훨씬 높습니다.

또한 Kubernetes 환경에서는 HPA(Horizontal Pod Autoscaler)에 의한 자동 스케일아웃 시 신규 파드가 동일한 스케줄을 즉시 시작하려 할 수 있습니다. ShedLock은 이 경우에도 정상적으로 동작하지만, `lockAtLeastFor`를 적절히 설정하지 않으면 스케일아웃 직후 잠금 경합이 일시적으로 늘어날 수 있습니다. 파드 시작 시 `@Scheduled` 초기 트리거가 동시에 발생하지 않도록 `initialDelay`를 무작위화하는 전략도 함께 고려할 만합니다.

---

## 맺음말

### 핵심 요약

ShedLock은 Spring의 `@Scheduled` 기반 스케줄링 코드를 최소한의 변경으로 분산 환경에서 안전하게 운영하게 해주는 실용적인 라이브러리입니다. 공유 저장소를 이용한 낙관적 선점 잠금 방식으로 중복 실행을 방지하며, `LockProvider` 교체만으로 JDBC, Redis, MongoDB 등 다양한 저장소를 지원합니다. `lockAtMostFor`와 `lockAtLeastFor` 두 속성을 올바르게 설정하는 것이 안정적인 운영의 핵심이며, `usingDbTime()` 옵션으로 인스턴스 간 시계 오차 문제를 제거하는 것이 권장됩니다.

### 적용 판단 기준

ShedLock 적용을 고려하는 가장 좋은 시점은 단일 인스턴스로 운영되던 서비스를 다중 인스턴스로 전환할 때, 혹은 Kubernetes 기반으로 이전하면서 파드 수 제어를 자동화할 때입니다. 이미 `@Scheduled`로 잘 동작하는 코드가 있고, 엔터프라이즈 배치 기능(재시도, 파티셔닝, 이력 관리)까지는 필요 없다면 ShedLock이 Quartz 대비 도입 비용을 수십 배 줄여줍니다. 단, 작업의 성격이 강한 멱등성을 필요로 하지 않거나, 정확히 한 번 실행 보장이 비즈니스 크리티컬하다면 더 강한 보장을 제공하는 솔루션과 병행 검토를 권장합니다.

### 다음 단계

ShedLock을 적용한 뒤 자연스럽게 이어지는 주제는 **배치 작업의 멱등성 설계**입니다. ShedLock이 중복 실행 가능성을 줄여주더라도, 작업 자체가 멱등하게 설계되어 있어야 진정으로 안전합니다. 처리 상태를 데이터베이스에 기록하고 이미 처리된 항목은 건너뛰는 체크포인트 패턴, 또는 Spring Batch의 JobExecution 모델을 참고하면 더 견고한 구조를 만들 수 있습니다.

규모가 더 커지거나 복잡한 요구사항이 생겼을 때는 **Quartz Scheduler의 클러스터 모드**나, 인프라 수준에서 실행 보장을 제공하는 **Kubernetes CronJob**, 또는 비동기 작업 큐 기반의 **Celery(Python)나 Sidekiq(Ruby) 유사 패턴의 Spring + Redis 큐** 방식으로 마이그레이션하는 경로를 검토할 수 있습니다.

공식 문서: [ShedLock GitHub Repository](https://github.com/lukas-krecan/ShedLock)

---

**출처**

1. [lukas-krecan/ShedLock](https://github.com/lukas-krecan/ShedLock) — 공식 저장소. 프로바이더별 설정과 주의사항.
2. [Spring Framework, Task Execution and Scheduling](https://docs.spring.io/spring-framework/reference/integration/scheduling.html) — `@Scheduled`의 실행 모델.
3. [Spring Boot, Task Execution and Scheduling](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html) — 스케줄러 스레드 풀 설정.
4. [Redis, Distributed Locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/) — 잠금의 안전성 한계를 이해하는 데 필요한 배경.
