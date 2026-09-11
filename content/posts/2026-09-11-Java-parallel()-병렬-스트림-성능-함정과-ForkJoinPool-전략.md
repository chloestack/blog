---
title: "Java parallel() 병렬 스트림 성능 함정과 ForkJoinPool 전략"
date: "2026-09-11 07:07"
category: "Java"
tags: ["Java Stream parallel() 병렬 처리 성능 함정과 ForkJoinPool 활용 전략", "Java", "parallel", "ForkJoinPool"]
excerpt: "Java 8의 Stream API가 등장했을 때, parallel() 메서드는 개발자들에게 병렬 처리의 민주화를 약속했습니다. .stream() 대신 .parallelStream()을 입력하거나, 스트림 중간에 ."
---

## 목차

1. 개요
2. parallel()와 ForkJoinPool 내부 동작 원리
3. 병렬 스트림이 느려지는 주요 함정
4. ForkJoinPool 커스터마이징과 격리 전략
5. 운영 환경에서의 병렬 처리 설계
6. 대안 기술 비교와 선택 기준
7. 맺음말

---

## 개요

### 문제 배경: 병렬 처리가 만능 해결책이 아닌 이유

Java 8의 Stream API가 등장했을 때, `parallel()` 메서드는 개발자들에게 병렬 처리의 민주화를 약속했습니다. `.stream()` 대신 `.parallelStream()`을 입력하거나, 스트림 중간에 `.parallel()`을 호출하는 것만으로 멀티코어 자원을 활용할 수 있다는 기대가 높았습니다. 실제로 특정 연산에서는 극적인 성능 향상을 보여주기도 했습니다. 그러나 현업 프로젝트에서 병렬 스트림을 적용한 이후 오히려 응답 시간이 증가하거나, 특정 시간대에 전체 서비스가 느려지는 현상이 보고되는 경우가 적지 않습니다.

원인을 추적하면 대부분 ForkJoinPool의 공유 스레드 풀 구조, 분할 비용, I/O 집약적 작업에서의 스레드 블로킹 등이 복합적으로 얽혀 있습니다. 이 글은 `parallel()`이 내부적으로 어떻게 동작하는지, ForkJoinPool이 어떤 메커니즘으로 작업을 분배하는지를 중심으로 실제로 발생하는 성능 함정들과 그 해결 전략을 다룹니다. `parallel()`은 도구이지, 모든 상황에 적용할 수 있는 패턴이 아닙니다.

---

### 기존 방식의 한계: 전통적인 멀티스레드 프로그래밍의 복잡성

`parallel()`이 등장하기 전, 병렬 처리는 주로 `ExecutorService`와 `Future`, 또는 `CountDownLatch`와 같은 동기화 도구를 조합해서 구현했습니다. 이 방식은 스레드 수명주기 관리, 작업 분할, 결과 집계, 예외 처리 등을 모두 개발자가 직접 코드로 표현해야 했습니다. 코드가 길어지고 오류 발생 가능성도 높아졌습니다.

`ForkJoin` 프레임워크는 이 복잡성을 내부로 숨기고, 재귀적 작업 분할(fork)과 결과 합산(join)을 자동화하는 방식으로 이 문제에 접근했습니다. `parallel()`은 이 ForkJoin 프레임워크 위에서 동작하기 때문에, 겉으로는 단순해 보이지만 내부 동작을 이해하지 못하면 예상과 다른 결과를 마주하게 됩니다. 특히 애플리케이션 서버처럼 이미 수십 개의 스레드가 동시에 실행 중인 환경에서 공유 ForkJoinPool을 무분별하게 사용하면 스레드 경합과 컨텍스트 스위칭 비용이 급증합니다.

---

## parallel()와 ForkJoinPool 내부 동작 원리

### 동작 원리: Work-Stealing 알고리즘

`parallel()` 스트림의 핵심은 `ForkJoinPool.commonPool()`입니다. JVM 프로세스당 하나의 공용 풀이 존재하며, 기본 병렬도(parallelism)는 `Runtime.getRuntime().availableProcessors() - 1`로 설정됩니다. 4코어 머신이라면 공용 풀의 스레드 수는 기본적으로 3개입니다.

ForkJoinPool의 핵심 특징은 **Work-Stealing** 알고리즘입니다. 각 워커 스레드는 자신만의 양방향 큐(deque)를 가지며, 작업을 큐의 앞쪽(head)에서 꺼내 처리합니다. 자신의 큐가 비었을 때는 다른 스레드의 큐 뒤쪽(tail)에서 작업을 훔쳐옵니다. 이 비대칭적 접근 방식은 스레드 간 락 경합을 최소화하면서도 유휴 스레드가 발생하지 않도록 균형을 맞춥니다.

```
[워커 스레드 1 deque]            [워커 스레드 2 deque]
HEAD → [T1][T2][T3] ← TAIL      HEAD → [T4][T5] ← TAIL
         ↑ 자신의 큐 앞쪽에서                ↑ 스레드1 큐 뒤쪽에서
         처리 시작                            작업 훔치기(steal)
```

병렬 스트림이 실행되면 스트림 소스는 `Spliterator`를 통해 분할 가능한 청크로 나뉩니다. 각 청크는 `ForkJoinTask`로 포장되어 공용 풀에 제출되고, 워커 스레드들이 이를 처리합니다. 최종 연산 결과는 재귀적으로 합산(join)됩니다. Work-Stealing은 대부분의 경우 효율적이지만, 작업 크기가 지나치게 작으면 훔치는 비용 자체가 연산 비용을 초과할 수 있습니다.

---

### 주요 구성 요소: Spliterator와 분할 전략

`Spliterator`는 스트림 소스를 분할하는 인터페이스로, `parallel()`의 실질적인 성능을 좌우하는 핵심 요소입니다. `tryAdvance()`로 하나씩 처리하거나, `trySplit()`으로 소스를 둘로 나누는 방식으로 동작합니다. 분할 효율은 자료구조에 따라 극적으로 달라지며, 이 차이가 병렬 스트림의 성패를 결정합니다.

| 자료구조 | Spliterator 유형 | 분할 효율 | 특징 및 주의점 |
|---|---|---|---|
| `ArrayList` | `ArrayListSpliterator` | ★★★★★ | O(1) 인덱스 접근, 균등 분할 가능 |
| `int[]`, `long[]` | `ArraySpliterator` | ★★★★★ | 연속 메모리, 캐시 친화적, 병렬 처리 최적 |
| `HashSet` | `HashSetSpliterator` | ★★★☆☆ | 버킷 단위 분할, 불균등 분배 가능 |
| `LinkedList` | `IteratorSpliterator` | ★☆☆☆☆ | 순차 탐색 필요, 분할 비용 O(N) |
| `Stream.generate()` | `InfiniteSupplyingSpliterator` | ★☆☆☆☆ | 크기 미정, 병렬화 거의 불가 |
| `TreeMap.entrySet()` | `EntrySpliterator` | ★★★☆☆ | 트리 구조 분할, 크기 예측 어려움 |

`LinkedList`나 `Stream.iterate()`처럼 분할이 어려운 자료구조를 병렬 스트림에 사용하면, 분할 자체가 순차 탐색을 요구하여 오히려 단일 스레드보다 느려지는 역설적 상황이 발생합니다. 병렬 처리가 필요하다면 먼저 데이터를 `ArrayList`나 배열로 변환한 뒤 처리하는 것이 더 효과적입니다.

---

### 데이터 흐름: 병렬 스트림 파이프라인 처리 과정

스트림 파이프라인이 `parallel()`과 함께 실행될 때의 처리 흐름을 이해하면, 어느 지점에서 병목이 발생하는지 파악할 수 있습니다. 분할과 합산 단계 모두 비용이 발생한다는 점을 인식해야 합니다.

```
소스(Source)
    │
    ▼
Spliterator.trySplit() × N 회
    │
    ├──► 청크 1 → [filter → map → ...] → 부분 결과 1 ─┐
    ├──► 청크 2 → [filter → map → ...] → 부분 결과 2 ─┤
    ├──► 청크 3 → [filter → map → ...] → 부분 결과 3 ─┤
    └──► 청크 4 → [filter → map → ...] → 부분 결과 4 ─┘
                                                       │
                                       Combiner(결합 연산) ← 비용 발생 지점
                                                       │
                                                   최종 결과
```

주목할 점은 **결합 연산(Combiner)**입니다. `collect()`, `reduce()` 같은 최종 연산은 분할된 결과를 다시 합산해야 하므로, 결합 비용이 큰 연산은 병렬화의 이득을 상쇄합니다. 예를 들어 `String` 연결 연산을 병렬 스트림에서 수행하면, 각 스레드의 `StringBuilder`를 다시 합치는 과정에서 추가적인 복사 비용이 발생하여 순차 처리보다 느려질 수 있습니다.

---

## 병렬 스트림이 느려지는 주요 함정

### 공유 ForkJoinPool 오염 문제

`parallel()` 스트림이 기본적으로 사용하는 `ForkJoinPool.commonPool()`은 JVM 내 **모든 병렬 스트림이 공유**합니다. Spring Boot 기반 애플리케이션을 예로 들면, HTTP 요청을 처리하는 Tomcat 스레드가 `parallelStream()`을 호출할 때마다 공용 풀을 점유합니다. 동시 요청이 100개라면, 100개의 요청이 모두 같은 풀을 두고 경쟁하게 됩니다.

이 상황은 특히 I/O 집약적 작업에서 치명적입니다. 공용 풀의 워커 스레드가 외부 API 호출이나 데이터베이스 쿼리 대기 중에 블로킹되면, CPU 집약적 연산을 처리할 스레드가 사라집니다. 결국 전체 서비스의 응답 시간이 급격히 늘어나는 현상이 관찰됩니다. 이를 **공용 풀 오염(Common Pool Pollution)**이라고 부르며, 운영 환경에서 장애로 이어지는 가장 흔한 원인 중 하나입니다.

> **⚠️ 핵심 규칙**: I/O 블로킹 작업은 절대 `ForkJoinPool.commonPool()`에서 실행하지 말 것. I/O와 CPU 연산은 반드시 별도의 스레드 풀로 격리해야 합니다.

---

### 작업 크기와 분할 비용의 트레이드오프

병렬화로 이득을 얻으려면 각 작업 단위가 분할 비용과 스레드 전환 오버헤드를 충분히 상쇄할 만큼 계산 집약적이어야 합니다. 일반적으로 데이터 건수가 적거나(수천 건 이하), 연산 자체가 단순한 경우에는 순차 스트림이 병렬 스트림보다 빠릅니다. 이 교차점은 데이터 특성과 하드웨어에 따라 달라지므로 반드시 직접 측정으로 확인해야 합니다.

| 시나리오 | 권장 방식 | 근거 및 주의점 |
|---|---|---|
| 1만 건 미만 단순 필터링 | 순차 스트림 | 분할·조합 오버헤드 > 병렬화 이득 |
| 100만 건 이상 수치 연산 | 병렬 스트림 | 충분한 작업량으로 오버헤드 상쇄 |
| 외부 API·DB 호출 포함 | 별도 ExecutorService | I/O 블로킹으로 스레드 낭비 |
| 순서 유지가 필요한 처리 | 순차 스트림 | `forEachOrdered()` 사용 시 동기화 비용 발생 |
| `ArrayList` 기반 단순 집계 | 병렬 스트림 | Spliterator 분할 효율 최고, 가장 이상적 |
| `LinkedList` 기반 처리 | 순차 스트림 | 분할 자체가 O(N) 탐색 필요 |

실제 프로젝트에서는 반드시 JMH(Java Microbenchmark Harness)로 순차·병렬 버전을 직접 측정한 후 결정해야 합니다. 직관만으로 판단하면 오히려 성능을 저하시키는 경우가 많습니다.

---

### 상태 공유와 가변 객체의 위험

병렬 스트림에서 외부 가변 상태를 공유하면 데이터 경합(data race)이 발생합니다. `forEach()`에서 외부 리스트에 직접 추가하거나, 공유 카운터를 `int` 변수로 증가시키는 패턴은 병렬 환경에서 결과를 보장할 수 없습니다. 이 문제는 테스트 환경에서는 드물게 재현되다가, 부하가 높은 운영 환경에서 간헐적으로 발생하는 탓에 원인을 찾기가 매우 어렵습니다.

아래 코드는 가변 상태를 잘못 사용하는 전형적인 패턴과 올바른 대안을 함께 보여줍니다. `Collectors.toList()`는 내부적으로 각 스레드별 부분 컨테이너를 생성한 뒤 최종 합산하는 방식으로 스레드 안전성을 보장합니다.

```java
import java.util.*;
import java.util.stream.*;
import java.util.concurrent.atomic.AtomicInteger;

public class ParallelStreamStatePitfall {

    // ❌ 잘못된 예: 비스레드-안전 컬렉션에 직접 추가
    static List<Integer> unsafeCollect(List<Integer> source) {
        List<Integer> result = new ArrayList<>();
        source.parallelStream()
              .filter(n -> n % 2 == 0)
              .forEach(result::add); // 데이터 경합 → 누락·중복·예외 발생
        return result;
    }

    // ✅ 올바른 예: collect()로 스레드 안전 집계
    static List<Integer> safeCollect(List<Integer> source) {
        return source.parallelStream()
                     .filter(n -> n % 2 == 0)
                     .collect(Collectors.toList()); // 스레드별 부분 컨테이너 생성 후 합산
        // 결과: 순서는 보장되지 않으나 모든 원소 정확히 포함
    }

    // ✅ 단순 카운팅: count() 종단 연산 활용
    static long safeCount(List<Integer> source) {
        return source.parallelStream()
                     .filter(n -> n % 2 == 0)
                     .count(); // AtomicLong 기반으로 병렬 안전, 가장 간결
    }
}
```

`AtomicInteger`나 `LongAdder` 같은 원자적 연산 클래스를 사용하는 것도 안전하지만, 단순한 집계라면 스트림의 종단 연산(`count()`, `sum()`, `collect()`)을 우선적으로 활용하는 것이 가장 간결하고 의도가 명확합니다. `LongAdder`는 `AtomicLong`보다 경합이 심한 환경에서 더 나은 성능을 보이므로, 매우 빈번한 증가 연산이 필요할 때 고려할 만합니다.

---

## ForkJoinPool 커스터마이징과 격리 전략

### 전용 ForkJoinPool 생성

공용 풀 오염 문제를 해결하는 가장 효과적인 방법은 병렬 스트림용 전용 `ForkJoinPool`을 생성하고, 그 풀의 컨텍스트에서 스트림을 실행하는 것입니다. `ForkJoinPool.submit()`에 람다로 스트림 처리를 전달하면, 해당 스트림은 공용 풀 대신 지정된 풀에서 실행됩니다. 이 방식은 공개된 공식 API는 아니지만, `ForkJoinPool`의 내부 구현 방식에 의해 실질적으로 동작이 보장됩니다.

```java
import java.util.List;
import java.util.concurrent.ForkJoinPool;
import java.util.stream.Collectors;

public class IsolatedForkJoinPoolExample {

    // CPU 집약적 작업용 전용 풀 (애플리케이션 생명주기와 함께 관리)
    private static final ForkJoinPool CPU_POOL =
        new ForkJoinPool(Runtime.getRuntime().availableProcessors());

    public static List<Double> processHeavyComputation(List<Integer> data) throws Exception {
        return CPU_POOL.submit(() ->
            data.parallelStream()
                .map(n -> Math.pow(n, 2) + Math.sqrt(n) + Math.log(n + 1)) // CPU 집약 연산
                .filter(v -> v > 100.0)
                .collect(Collectors.toList())
        ).get();
        // 결과: 조건을 만족하는 Double 값 목록 반환
        //       공용 풀이 아닌 CPU_POOL 워커 스레드에서만 실행됨
    }

    // 스프링 빈으로 관리 시 반드시 @PreDestroy 또는 shutdown hook 등록
    public static void shutdown() {
        CPU_POOL.shutdown();
    }
}
```

전용 풀을 생성할 때는 스레드 수 설정이 중요합니다. CPU 집약적 작업은 `availableProcessors()`와 동일하게, I/O 혼합 작업은 더 높은 값으로 설정하는 것이 일반적입니다. 단, 전용 풀은 정적 변수나 스프링 빈으로 관리하여 요청마다 새로 생성하는 일을 반드시 피해야 합니다. 풀 생성 비용 자체가 상당하여, 요청마다 생성하면 성능 개선이 아닌 저하를 초래합니다.

---

### 병렬도 튜닝과 JVM 플래그

시스템 프로퍼티를 통해 공용 ForkJoinPool의 기본 병렬도를 조정할 수 있습니다. JVM 시작 옵션으로 `-Djava.util.concurrent.ForkJoinPool.common.parallelism=N`을 설정하면 JVM 전역에 적용됩니다. 이 설정은 운영 환경의 실제 CPU 코어 수와 서비스 특성에 맞게 결정해야 하며, 컨테이너 환경에서는 특히 주의가 필요합니다.

| 환경 | 권장 parallelism | 이유 및 주의점 |
|---|---|---|
| 단일 서비스 전용 물리 서버 | `CPU 코어 수 - 1` | 기본값, 순수 CPU 계산 작업에 최적 |
| 쿠버네티스 파드 (2코어 제한) | 1 | 코어 수 - 1이 최소 1 이상이어야 효과 존재 |
| 혼합 I/O + CPU 서비스 | 커스텀 풀로 격리 | 공용 풀 오염 방지가 우선 |
| Reactive 기반 서비스 | 사용 자제 | 이벤트 루프 스레드와 경합 발생 |
| 배치 처리 전용 워커 | `CPU 코어 수` | 다른 서비스 없이 자원 독점 가능 |

특히 도커나 쿠버네티스 환경에서는 `availableProcessors()`가 컨테이너 CPU 제한이 아닌 **호스트 머신의 전체 코어 수**를 반환하는 경우가 있습니다. Java 10 이전 버전에서 이 버그가 실제로 존재했으며, 2코어로 제한된 컨테이너에서 48코어 서버의 전체 코어 수를 반환해 스레드 풀이 비정상적으로 커지는 문제가 발생했습니다. Java 11 이상의 컨테이너 인식 기능(`-XX:+UseContainerSupport`, 기본 활성화)을 활용하거나, 명시적으로 parallelism을 설정하는 것이 안전합니다.

---

### 작업 훔치기와 재귀 분할 제어

ForkJoinPool의 Work-Stealing은 워커 스레드의 유휴 상태를 최소화하는 데 탁월하지만, 지나치게 작은 단위로 작업이 분할되면 오히려 오버헤드가 커집니다. `RecursiveTask`나 `RecursiveAction`을 직접 구현할 때는 **임계값(threshold)**을 설정하여 일정 크기 이하의 작업은 순차 처리하도록 제어합니다.

```
작업 분할 전략 (Threshold = 1000)

[0 ~ 8000] → fork
  ├─ [0 ~ 4000] → fork
  │    ├─ [0 ~ 2000] → fork
  │    │    ├─ [0 ~ 1000]    → 순차 처리 ← 임계값 이하
  │    │    └─ [1001 ~ 2000] → 순차 처리 ← 임계값 이하
  │    └─ [2001 ~ 4000] → fork
  │         ├─ [2001 ~ 3000] → 순차 처리
  │         └─ [3001 ~ 4000] → 순차 처리
  └─ [4001 ~ 8000] → (동일하게 분할)
```

임계값이 너무 작으면 fork/join 비용이 실제 연산 비용을 초과하고, 너무 크면 병렬화의 이점이 줄어듭니다. 현업에서는 JMH를 활용한 벤치마크를 통해 데이터 특성에 맞는 임계값을 실험적으로 결정하는 것이 바람직합니다. 일반적으로 단순 수치 연산의 경우 1,000~10,000 사이에서 최적점이 형성되는 경향이 있습니다.

---

## 운영 환경에서의 병렬 처리 설계

### 흔한 실수와 함정: ThreadLocal 컨텍스트 손실

병렬 스트림 사용 시 가장 많이 놓치는 문제 중 하나는 **ThreadLocal 컨텍스트 손실**입니다. 스프링 시큐리티의 `SecurityContextHolder`, MDC(Mapped Diagnostic Context) 로깅, 트랜잭션 컨텍스트 등은 모두 `ThreadLocal`에 저장됩니다. 병렬 스트림의 워커 스레드는 호출 스레드와 다른 스레드이므로, 이 컨텍스트가 자동으로 전달되지 않습니다.

예를 들어 스프링 시큐리티 컨텍스트를 참조하는 권한 검사 로직이 병렬 스트림 내부에 있으면, 워커 스레드에서는 인증 정보가 `null`로 보여 `NullPointerException`이나 보안 예외가 발생합니다. 이 버그는 개발 환경에서는 스레드 수가 적어 재현이 드물고, 운영 환경에서 부하 증가 시 갑작스럽게 나타나는 경향이 있어 원인 분석이 쉽지 않습니다.

| 컨텍스트 유형 | 병렬 스트림에서의 문제 | 해결 방법 |
|---|---|---|
| `SecurityContextHolder` | 워커 스레드에서 인증 정보 `null` | `DelegatingSecurityContextExecutor` 활용 |
| MDC 로깅 컨텍스트 | 로그에 요청 ID·트레이스 ID 누락 | 람다 진입 시 `MDC.put()` 명시적 복사 |
| 스프링 트랜잭션 컨텍스트 | 트랜잭션 범위 벗어나 커밋·롤백 오작동 | 병렬 스트림 내 DB 접근 자체를 금지 |
| 사용자 정의 ThreadLocal | 비즈니스 컨텍스트 누락 | `InheritableThreadLocal` 사용 검토 |

`InheritableThreadLocal`은 부모 스레드의 값을 자식 스레드에 자동 복사하지만, ForkJoinPool의 워커 스레드는 풀이 생성될 때 만들어지므로 이 메커니즘도 완벽히 동작하지 않는 경우가 있습니다. 컨텍스트 전파가 중요한 코드 경로에서는 병렬 스트림 사용을 피하거나, 명시적인 컨텍스트 전달 래퍼를 작성하는 것이 더 안전합니다.

---

### 모니터링과 디버깅: 운영 중 관찰 지표

운영 중인 서비스에서 병렬 스트림의 문제를 조기에 감지하려면 ForkJoinPool의 상태 지표를 모니터링해야 합니다. `ForkJoinPool` 인스턴스는 여러 상태 조회 메서드를 제공하며, Micrometer나 Prometheus를 활용해 주기적으로 수집하고 대시보드에 시각화할 수 있습니다.

```
ForkJoinPool 모니터링 지표 요약

getActiveThreadCount()   → 현재 작업 중인 워커 스레드 수
getQueuedTaskCount()     → 대기 중인 작업 큐 깊이
getStealCount()          → 누적 Work-Stealing 횟수 (증가 속도 관찰)
getPoolSize()            → 전체 워커 스레드 수 (parallelism과 비교)
getRunningThreadCount()  → 블로킹 없이 실행 중인 스레드 수

이상 징후 패턴:
  queuedTaskCount 지속 증가  → 처리 속도 < 제출 속도 (풀 증설 검토)
  activeCount ≈ poolSize     → 풀 포화 상태 (병목 직전)
  runningCount << activeCount → 스레드 블로킹 의심 (I/O 진단 필요)
```

`getQueuedTaskCount()`가 지속적으로 증가한다면 풀의 처리 용량을 초과한 작업이 쌓이고 있다는 신호입니다. 이 경우 병렬도를 높이거나, 작업을 다른 실행 메커니즘으로 전환하는 것을 검토해야 합니다. `getStealCount()`의 증가 속도가 급격히 높아진다면 작업 분할 단위가 지나치게 작아 오버헤드가 발생하는 상황일 수 있습니다.

---

### 확장과 마이그레이션: 수평 확장 환경의 고려사항

단일 인스턴스 환경에서 잘 동작하던 병렬 스트림 코드가 수평 확장 후 갑자기 문제를 일으키는 경우가 있습니다. 4코어 서버에서 16개의 병렬 스트림 작업을 처리하도록 설계된 코드가, 2코어 컨테이너 10개로 분산된 환경에서는 각 컨테이너당 1~2개의 워커 스레드만 가지게 됩니다. 결국 병렬화 이득이 사라지고, 오히려 직렬 처리보다 오버헤드만 추가되는 상황이 됩니다.

수평 확장을 전제로 한 아키텍처라면, 대용량 데이터 처리는 병렬 스트림 대신 메시지 큐(Kafka, RabbitMQ) 기반의 비동기 분산 처리나 배치 프레임워크(Spring Batch)로 설계하는 편이 장기적으로 더 유연합니다. 병렬 스트림은 **단일 JVM 내에서 CPU 자원을 최대한 활용하는 도구**이지, 분산 시스템의 확장성 문제를 해결하는 도구가 아닙니다.

---

## 대안 기술 비교와 선택 기준

### CompletableFuture, 가상 스레드와의 비교

`parallel()` 스트림과 `CompletableFuture`는 모두 비동기·병렬 처리를 지원하지만, 설계 목적과 적합한 시나리오가 명확히 다릅니다. `parallel()` 스트림은 동기적 파이프라인 내에서 CPU 집약적 데이터 변환을 병렬화하는 데 적합합니다. `CompletableFuture`는 비동기 I/O, 외부 API 호출, 의존 관계가 있는 작업 체인을 표현하는 데 더 자연스럽습니다.

| 기준 | `parallel()` Stream | `CompletableFuture` | Virtual Threads (JDK 21+) |
|---|---|---|---|
| 주 사용 목적 | CPU 집약 데이터 변환 | 비동기 I/O, 작업 체인 | I/O 블로킹 대규모 병렬화 |
| 스레드 모델 | ForkJoinPool 공용 풀 | 지정 Executor 또는 FJP | JVM 관리 경량 스레드 |
| I/O 작업 | 적합하지 않음 | 적합 (비동기 콜백) | 매우 적합 (블로킹 OK) |
| 에러 처리 | 예외 전파 복잡 | `exceptionally()` 체인 | try-catch 직관적 사용 |
| 순서 보장 | `forEachOrdered()` 필요 | 명시적 의존 관계 표현 | 코드 순서 그대로 |
| 학습 곡선 | 낮음 (스트림 API 익숙) | 중간 (콜백 체인 복잡) | 낮음 (동기 코드처럼 작성) |

Java 21에서 정식 출시된 **가상 스레드(Virtual Threads)**는 I/O 블로킹 시 플랫폼 스레드를 반환하고 다른 작업을 처리하는 방식으로, 기존 코드 스타일 그대로 대규모 동시성을 구현합니다. I/O 집약적인 병렬 처리라면 `parallel()` 스트림보다 가상 스레드를 우선 검토하는 것이 권장됩니다.

---

### Reactor/WebFlux와 병렬 스트림의 경계

리액티브 프레임워크인 Project Reactor나 Spring WebFlux는 논블로킹 I/O와 배압(backpressure) 처리를 위한 완전히 다른 패러다임을 제공합니다. 병렬 스트림은 블로킹 환경의 배치 처리나 CPU 연산에 적합하고, Reactor는 높은 동시성이 요구되는 논블로킹 서비스에 적합합니다. 두 기술을 혼용할 때는 특히 주의가 필요합니다.

WebFlux 기반 서비스에서 `parallelStream()`을 호출하면, 이벤트 루프 스레드에서 ForkJoinPool 작업을 제출하는 상황이 발생할 수 있습니다. 이벤트 루프 스레드가 ForkJoin 작업 완료를 기다리며 블로킹되면 전체 이벤트 루프가 멈추는 심각한 장애로 이어집니다. Reactor 환경에서 CPU 집약적 작업을 병렬화하려면 `Schedulers.parallel()`을 활용하거나, `publishOn()`으로 명시적으로 별도 스케줄러로 전환해야 합니다.

> **선택 기준 요약**: 100만 건 이상의 수치 계산·데이터 변환은 `parallel()` 스트림, 수천 건의 외부 API 병렬 호출은 `CompletableFuture` 또는 가상 스레드, 초당 수만 건의 이벤트 스트림 처리는 Project Reactor를 선택하십시오.

---

### 어떤 상황에서 parallel()을 선택할 것인가

`parallel()` 스트림이 실질적인 성능 이득을 제공하는 조건은 명확합니다. 데이터 건수가 충분히 많고(최소 수십만 건 이상), 연산이 CPU를 집약적으로 사용하며, 자료구조가 효율적으로 분할 가능하고(ArrayList, 배열), 작업 간 상태 공유가 없을 때 효과가 극대화됩니다.

| 조건 | 충족 여부 확인 방법 | 불충족 시 대안 |
|---|---|---|
| 데이터 건수 충분 | JMH로 N 기준 교차점 측정 | 순차 스트림 사용 |
| CPU 집약 연산 | 프로파일러로 CPU 사용률 확인 | CompletableFuture / 가상 스레드 |
| 효율적 분할 가능 | 자료구조 타입 확인 | ArrayList로 변환 후 처리 |
| 상태 공유 없음 | 코드 리뷰로 외부 변수 접근 확인 | collect() 또는 reduce() 활용 |
| 전용 풀 격리 | 커스텀 ForkJoinPool 여부 확인 | 전용 풀 생성 |

---

## 맺음말

### 핵심 요약

이 글에서 다룬 내용을 정리하면 다음과 같습니다. `parallel()` 스트림은 내부적으로 ForkJoinPool의 Work-Stealing 알고리즘을 활용하여 작업을 분산 처리합니다. 그러나 공용 풀 공유, I/O 블로킹, 분할 비용이 큰 자료구조, 가변 상태 공유, ThreadLocal 컨텍스트 손실 등의 문제로 인해 기대와 달리 성능이 저하되거나 장애로 이어지는 경우가 자주 발생합니다.

| 함정 | 주요 증상 | 권장 해결 전략 |
|---|---|---|
| 공용 풀 오염 | 전체 서비스 응답 지연, 부하 증가 시 악화 | 전용 ForkJoinPool 생성 및 격리 |
| I/O 블로킹 | 워커 스레드 고갈, 처리 큐 무한 증가 | CompletableFuture 또는 가상 스레드 전환 |
| 분할 불가 자료구조 | 순차 처리보다 느린 결과 | ArrayList·배열로 변환 후 처리 |
| 가변 상태 공유 | 결과 불일치, ConcurrentModificationException | `collect()`, `count()` 종단 연산 사용 |
| ThreadLocal 손실 | 인증 오류, 로그 ID 누락 | 명시적 컨텍스트 복사 또는 병렬 처리 회피 |
| 컨테이너 코어 수 오인식 | 과도한 스레드 생성 | `-Djava.util.concurrent.ForkJoinPool.common.parallelism` 명시 |

---

### 적용 판단 기준

병렬 스트림을 실제 프로젝트에 도입하기 전에 아래 체크리스트를 먼저 확인하십시오. 모든 항목에 "예"라고 답할 수 있을 때 비로소 `parallel()`이 유효한 선택이 됩니다.

1. 데이터 건수가 수십만 건 이상인가?
2. 연산이 CPU를 집약적으로 사용하며 I/O가 포함되지 않는가?
3. `ArrayList`나 배열처럼 효율적으로 분할 가능한 자료구조인가?
4. 작업 간 공유 상태가 없거나 원자적 연산으로 보호되어 있는가?
5. 전용 ForkJoinPool을 사용하여 공용 풀 오염을 방지했는가?
6. JMH 또는 직접 측정으로 순차 대비 성능 향상을 수치로 확인했는가?

이 여섯 가지 조건 중 하나라도 충족하지 못한다면, 순차 스트림이나 다른 동시성 도구가 더 안전한 선택일 가능성이 높습니다.

---

### 다음 단계

병렬 스트림과 ForkJoinPool을 더 깊이 이해하려면 `RecursiveTask`와 `RecursiveAction`을 직접 구현해보는 것을 권장합니다. 복잡한 병렬 작업 분기와 합산을 명시적으로 제어하면서 ForkJoin 프레임워크의 내부 동작을 체험할 수 있습니다. 또한 Java 21의 가상 스레드는 기존 블로킹 코드를 거의 변경 없이 높은 동시성으로 전환할 수 있는 강력한 도구이므로, JDK 21 이상 환경이라면 적극적으로 검토할 것을 권장합니다.

성능 측정 도구로는 [JMH(Java Microbenchmark Harness)](https://github.com/openjdk/jmh)를 활용하십시오. 병렬 스트림이 실제로 이득을 주는지, 어느 데이터 크기에서 교차점이 발생하는지를 정량적으로 확인할 수 있습니다. 공식 레퍼런스로는 [OpenJDK ForkJoinPool API 문서](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ForkJoinPool.html)와 [Java Stream 패키지 사양](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/stream/package-summary.html)을 참고하십시오.

---

**출처**

1. [OpenJDK, ForkJoinPool API 문서](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ForkJoinPool.html) — 공용 풀의 기본 병렬도와 동작 규칙.
2. [java.util.stream 패키지 사양](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/stream/package-summary.html) — 병렬 스트림의 순서 보장, 부작용, 결합성 요구사항.
3. [JMH (Java Microbenchmark Harness)](https://github.com/openjdk/jmh) — 본문의 교차점을 직접 재려면 필요한 도구.
