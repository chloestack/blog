---
title: "Java ThreadLocal 메모리 누수 원인과 해결 전략"
date: "2026-09-12 07:07"
publishedAt: ""
category: "Java"
tags: ["Java ThreadLocal 메모리 누수 원인과 해결 전략", "Java", "ThreadLocal"]
excerpt: "멀티스레드 프로그래밍에서 가장 까다로운 문제 중 하나는 스레드 간 상태 공유입니다. 공유 객체에 여러 스레드가 동시에 접근할 때 발생하는 경쟁 조건(race condition)과 데이터 불일치를 막기 위해 개발자들은 synchroni…"
status: "draft"
---

## 목차

1. 개요
2. ThreadLocal 동작 원리와 메모리 구조
3. 메모리 누수가 발생하는 핵심 시나리오
4. 메모리 누수 탐지와 진단 방법
5. 해결 전략과 안전한 사용 패턴
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경: ThreadLocal이 등장한 이유

멀티스레드 프로그래밍에서 가장 까다로운 문제 중 하나는 스레드 간 상태 공유입니다. 공유 객체에 여러 스레드가 동시에 접근할 때 발생하는 경쟁 조건(race condition)과 데이터 불일치를 막기 위해 개발자들은 `synchronized` 블록이나 `Lock` 인터페이스 같은 동기화 메커니즘을 사용합니다. 그러나 동기화는 성능 비용을 수반합니다. 락을 획득하고 해제하는 과정에서 스레드가 대기 상태에 빠지면 전체 처리량이 저하되고, 특히 높은 동시성이 요구되는 웹 애플리케이션 환경에서는 이 비용이 누적되어 응답 지연으로 이어질 수 있습니다.

`ThreadLocal`은 이 문제를 다른 관점에서 접근합니다. 공유 상태를 안전하게 만드는 대신 각 스레드가 독립적인 변수 사본을 갖도록 하여 처음부터 공유 자체를 피합니다. Java 1.2부터 도입된 이 개념은 이후 Spring 프레임워크의 `RequestContextHolder`, Hibernate의 세션 관리, MDC(Mapped Diagnostic Context) 기반 로깅 컨텍스트 전파 등 폭넓은 곳에서 활용되고 있습니다.

| 접근 방법 | 동작 원리 | 성능 | 적합한 상황 |
|---|---|---|---|
| `synchronized` | 락으로 직렬화 | 경합 시 저하 | 공유 상태 변경이 불가피할 때 |
| `Lock` (ReentrantLock) | 세분화된 락 제어 | 경합 시 저하 | 복잡한 락 조건이 필요할 때 |
| `ThreadLocal` | 스레드별 독립 사본 | 경합 없음 | 스레드 내 컨텍스트 전달 |
| `Atomic` 클래스 | CAS 연산 | 낮은 경합에 최적 | 단순 카운터·플래그 공유 |

---

### 기존 방식의 한계: 왜 ThreadLocal이 위험해질 수 있는가

`ThreadLocal`은 분명히 유용한 도구이지만, 현대 자바 애플리케이션이 동작하는 환경에서는 예상치 못한 위험을 내포하고 있습니다. Java SE 초기에 `ThreadLocal`이 설계될 당시의 전제는 하나의 요청이 하나의 스레드에 대응하고, 요청이 완료되면 해당 스레드도 종료된다는 것이었습니다. 이 전제 하에서는 스레드가 종료될 때 JVM이 해당 스레드의 로컬 저장소까지 함께 정리하므로 메모리 누수가 발생하지 않습니다.

그러나 오늘날의 서버 애플리케이션은 스레드 풀을 기반으로 동작합니다. Tomcat, Jetty와 같은 웹 서버는 미리 생성해 둔 스레드를 재사용하여 요청을 처리하고, 처리가 완료된 스레드는 종료되지 않고 풀로 반환됩니다. 이 구조에서 `ThreadLocal.remove()`를 명시적으로 호출하지 않으면, 다음 요청을 처리하는 스레드에 이전 요청의 데이터가 그대로 남아 있게 됩니다. 이는 단순한 메모리 낭비를 넘어 보안 취약점이 될 수 있으며, 장기 운영 시 힙 메모리를 점진적으로 잠식하는 누수로 이어집니다.

> **핵심 함정**: 스레드 풀 환경에서 스레드는 종료되지 않고 재사용됩니다. `remove()`를 호출하지 않는 한, ThreadLocal 값은 자동으로 정리되지 않습니다.

---

## ThreadLocal 동작 원리와 메모리 구조

### ThreadLocalMap의 내부 구조

`ThreadLocal`을 올바르게 이해하려면 JVM 내부에서 데이터가 어떻게 저장되는지를 먼저 파악해야 합니다. 많은 개발자들이 `ThreadLocal`을 일종의 전역 맵으로 오해하지만, 실제 구조는 정반대입니다. 데이터는 `ThreadLocal` 객체 자체가 아니라 **스레드 자신(Thread 객체)** 내부에 보관됩니다.

`java.lang.Thread` 클래스에는 `ThreadLocal.ThreadLocalMap threadLocals`라는 패키지-프라이빗 필드가 선언되어 있습니다. `ThreadLocalMap`은 `HashMap`과 달리 내부적으로 `Entry` 배열을 사용하는 맞춤형 해시 맵입니다. 각 `Entry`는 `ThreadLocal` 인스턴스를 키로, 실제 저장하려는 값을 값으로 갖습니다. 중요한 점은 이 `Entry`의 키가 `WeakReference<ThreadLocal<?>>`로 선언되어 있다는 것입니다. 이 구조는 `ThreadLocal` 인스턴스에 대한 외부 강한 참조가 모두 사라졌을 때 GC가 해당 키를 수거할 수 있도록 허용하기 위한 설계입니다.

```
Thread 객체
└── threadLocals: ThreadLocalMap
      └── Entry[] (해시 배열)
            ├── Entry[0]: WeakRef(ThreadLocal_A) → "userId=1234"
            ├── Entry[1]: WeakRef(ThreadLocal_B) → SomeHeavyObject
            ├── Entry[2]: WeakRef(null, GC됨)   → 잔여 값 (누수!)
            └── Entry[3]: null
```

이 구조에서 키(`ThreadLocal` 인스턴스에 대한 약한 참조)와 값(실제 저장 데이터에 대한 강한 참조)의 참조 강도가 서로 다르다는 점을 반드시 기억해야 합니다. 이 비대칭이 메모리 누수의 근본 원인입니다.

---

### WeakReference와 메모리 참조 관계

약한 참조(WeakReference)는 GC가 해당 객체를 수거할 때 방해하지 않는 참조 유형입니다. 따라서 `ThreadLocal` 인스턴스에 대한 강한 참조가 모두 사라지면, GC는 `ThreadLocal` 객체 자체를 수거하고 `ThreadLocalMap` 내 해당 키를 `null`로 만듭니다. 이 시점부터 해당 `Entry`는 키가 `null`인 "죽은 항목(stale entry)"이 됩니다.

문제는 키가 `null`이 되어도 값에 대한 강한 참조는 여전히 살아 있다는 점입니다. `Thread` 객체 → `ThreadLocalMap` → `Entry` → 값(strong reference)의 참조 사슬이 끊어지지 않기 때문에 GC는 값 객체를 수거할 수 없습니다. 스레드가 살아 있는 한, 즉 스레드 풀에 의해 계속 재사용되는 한, 이 값들은 힙 메모리에 무한정 축적됩니다.

| 참조 종류 | 대상 | GC 수거 가능 여부 | 결과 |
|---|---|---|---|
| WeakReference | ThreadLocal 키 | 가능 (외부 강한 참조 소멸 시) | 키 → null (stale entry 생성) |
| Strong Reference | Entry의 값 | 불가 (Thread 살아있는 한) | 메모리 누수 |
| Strong Reference | Thread → ThreadLocalMap | 불가 (스레드 풀 유지) | 맵 전체 메모리 잠금 |
| Strong Reference | 외부 코드 → ThreadLocal | 통상 유지됨 (static 필드) | 키 GC 방지 (일반적 패턴) |

---

### 데이터 흐름: set, get, remove의 생명주기

`ThreadLocal`의 `set()`, `get()`, `remove()` 메서드가 실제로 어떻게 동작하는지 이해하면 올바른 사용 패턴을 도출하는 데 큰 도움이 됩니다. 각 메서드는 현재 스레드의 `threadLocals` 맵을 읽거나 쓰는 방식으로 작동하며, 해시 충돌은 선형 탐사(linear probing)로 해결합니다.

```
[set() 흐름]
ThreadLocal.set(value)
  → Thread.currentThread().threadLocals 획득
  → ThreadLocalMap.set(this, value) 호출
    → 기존 Entry 탐색: 있으면 값 교체, 없으면 새 Entry 생성
    → 탐색 중 stale entry 발견 시 replaceStaleEntry() (부분 정리)

[get() 흐름]
ThreadLocal.get()
  → Thread.currentThread().threadLocals 획득
  → ThreadLocalMap.getEntry(this) 호출
    → 없으면 initialValue() 호출 후 set() 및 반환

[remove() 흐름]
ThreadLocal.remove()
  → ThreadLocalMap.remove(this) 호출
    → Entry 탐색 → 키·값 모두 null로 설정
    → expungeStaleEntry() 호출 → 연쇄 stale 정리 수행
```

`ThreadLocalMap`은 `set()`이나 `get()` 시 우연히 stale entry를 발견하면 부분적으로 정리를 시도합니다. 그러나 이 정리는 보장되지 않으며 타이밍과 해시 충돌 경로에 의존적입니다. 명시적인 `remove()` 호출만이 해당 항목이 즉시, 확실하게 제거됨을 보장합니다.

---

## 메모리 누수가 발생하는 핵심 시나리오

### 스레드 풀 환경에서의 위험

현대 자바 웹 애플리케이션에서 메모리 누수가 가장 빈번하게 발생하는 환경은 스레드 풀(Thread Pool)입니다. Tomcat의 `NioEndpoint`, Spring의 `TaskExecutor`, Java EE의 Managed Thread Factory 등은 모두 스레드를 미리 생성하고 재사용하는 전략을 채택합니다. 이 환경에서 `ThreadLocal.remove()`를 누락하면 두 가지 심각한 문제가 동시에 발생합니다.

첫째는 **데이터 오염(data pollution)** 문제입니다. 스레드 A가 첫 번째 요청을 처리하면서 `ThreadLocal`에 특정 사용자의 인증 토큰을 저장했다고 가정합니다. 요청 처리 완료 후 `remove()`를 호출하지 않으면, 스레드 A는 해당 토큰을 `threadLocals`에 보유한 채 풀로 반환됩니다. 이후 스레드 A가 두 번째 요청(전혀 다른 사용자)을 처리할 때 `ThreadLocal.get()`을 호출하면 이전 사용자의 토큰이 반환됩니다. 이는 기능 버그인 동시에 보안 사고입니다.

둘째는 **힙 메모리 누수**입니다. 각 요청이 수 킬로바이트에서 수 메가바이트에 달하는 데이터를 `ThreadLocal`에 저장한다면, 스레드 풀의 스레드 수만큼 해당 데이터가 힙에 누적됩니다. 장기 운영될수록 이 값은 점점 커지며, 결국 `OutOfMemoryError`를 유발합니다.

| 환경 | 스레드 수명 | ThreadLocal 위험도 | 대표 프레임워크 |
|---|---|---|---|
| HTTP 서블릿 스레드 풀 | 장기 재사용 | 매우 높음 | Tomcat, Netty, Jetty |
| ForkJoinPool (commonPool) | Worker 재사용 | 높음 | CompletableFuture |
| 가상 스레드 (JDK 21+) | 요청별 생성/소멸 | 낮음 (풀링 시 동일) | Spring Boot 3.2+ |
| 단발성 Thread | 작업 후 종료 | 낮음 | 배치, 초기화 코드 |
| Scheduled 주기 작업 | 스레드 재사용 | 높음 | ScheduledExecutorService |

---

### 클래스 로더 누수: 더 심각한 문제

스레드 풀보다 더 탐지하기 어려운 시나리오가 클래스 로더(ClassLoader) 누수입니다. Tomcat 같은 서블릿 컨테이너에서는 웹 애플리케이션마다 별도의 `WebAppClassLoader`를 사용합니다. 이 구조에서 컨테이너 스레드가 `ThreadLocal` 값으로 웹 앱 클래스 로더가 로드한 클래스의 인스턴스를 저장하면, 애플리케이션이 언디플로이(undeploy)되어도 클래스 로더 자체가 GC에 의해 수거될 수 없게 됩니다.

구체적인 경로는 다음과 같습니다. 컨테이너 스레드의 `ThreadLocalMap` → `Entry.value` → 웹 앱 클래스로 정의된 객체 → 해당 객체가 로드된 `WebAppClassLoader`. `ClassLoader`는 로드한 모든 `Class` 객체와 해당 정적 필드들을 강하게 참조합니다. 따라서 `ClassLoader` 하나가 누수되면 수백 개의 클래스 정의와 연관 메타데이터가 영구적으로 `Metaspace`(Java 8 이상)에 잔류하게 됩니다. 재배포가 반복될수록 `Metaspace`가 점점 채워지고, 결국 `java.lang.OutOfMemoryError: Metaspace`가 발생합니다.

> **클래스 로더 누수 경고**: Tomcat이 재배포 시 `"The web application [/myapp] created a ThreadLocal with key of type [com.example.MyClass] and a value of type [...]"` 경고를 출력한다면, 이것이 바로 클래스 로더 누수의 직접 징후입니다. 즉각적인 코드 수정이 필요합니다.

---

### 복잡한 참조 체인과 간접 누수

직접적인 누수 외에도 간접적인 참조 체인으로 인한 누수도 주의해야 합니다. `ThreadLocal`에 저장된 값이 작은 객체처럼 보여도, 그 객체가 대형 객체 그래프의 루트인 경우 실제 누수 규모는 훨씬 커집니다.

예를 들어, `ThreadLocal<Map<String, Object>>`에 요청 속성을 저장하는 패턴을 생각해 봅니다. 이 맵에 서블릿 `HttpSession`, JPA `EntityManager`, 데이터베이스 커넥션 래퍼 등이 담겨 있다면, `ThreadLocal`의 직접 값은 `Map` 객체이지만 실제로 GC에서 살아남는 객체 그래프는 수백 킬로바이트에서 수 메가바이트에 달할 수 있습니다.

```
Thread
  └── ThreadLocalMap
        └── Entry.value → HashMap  ← 작아 보이지만...
              ├── "session"    → HttpSession (수십 KB 사용자 상태)
              ├── "em"         → EntityManager (1차 캐시, lazy proxy)
              └── "conn"       → ConnectionWrapper (물리 DB 커넥션 홀드)
```

참조 체인을 단순하게 유지하는 것, 즉 `ThreadLocal`에는 값 객체(Value Object)나 불변 객체만 저장하고 무거운 리소스 객체는 저장하지 않는 것이 최선의 설계 원칙입니다. 불가피하게 복잡한 객체를 저장해야 한다면 해당 `ThreadLocal`의 `remove()` 시점을 더욱 엄격하게 관리해야 합니다.

---

## 메모리 누수 탐지와 진단 방법

### JVM 힙 분석 도구 활용

`ThreadLocal` 메모리 누수를 탐지하는 첫 번째 방법은 JVM 힙 덤프 분석입니다. 힙 덤프는 특정 시점의 JVM 힙 메모리 전체를 파일로 저장한 스냅샷으로, Eclipse Memory Analyzer(MAT), JProfiler, VisualVM 등으로 분석할 수 있습니다.

MAT에서 `ThreadLocal` 누수를 분석하는 절차는 다음과 같습니다. 먼저 `java.lang.Thread` 인스턴스를 나열하고, 각 스레드의 `threadLocals` 필드를 탐색합니다. `ThreadLocalMap$Entry` 인스턴스 목록에서 키가 `null`인 stale entry를 찾거나, 값의 Retained Heap 크기가 비정상적으로 큰 항목을 식별합니다. "Leak Suspects" 분석 기능을 사용하면 메모리를 많이 점유하는 객체 그래프를 자동으로 하이라이트합니다. OQL(Object Query Language)로 `SELECT * FROM java.lang.ThreadLocal` 쿼리를 실행하면 현재 JVM에 존재하는 모든 `ThreadLocal` 인스턴스와 각각의 retained size를 일괄 확인할 수 있습니다.

| 도구 | 장점 | 단점 | 언제 쓰나 |
|---|---|---|---|
| Eclipse MAT | 강력한 자동 분석, OQL 지원, 무료 | 대형 덤프 처리 시 느림 | 사후 오프라인 분석 |
| JProfiler | 실시간 모니터링, 직관적 UI | 유료 | 지속적 프로파일링 |
| VisualVM | 무료, JDK 번들 포함 | 심층 분석 기능 부족 | 빠른 현장 확인 |
| Async-profiler | 낮은 오버헤드 | ThreadLocal 직접 분석 어려움 | CPU·메모리 핫스팟 |

힙 덤프는 `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp/heap.hprof` JVM 옵션으로 `OutOfMemoryError` 발생 시 자동 생성하거나, 운영 중에는 `jmap -dump:format=b,file=/tmp/heap.hprof <pid>` 명령으로 수동 생성합니다.

---

### 로그와 지표 기반 탐지

힙 덤프 분석은 강력하지만 이미 문제가 발생한 후의 사후 진단입니다. 운영 환경에서는 사전 탐지를 위한 지표 모니터링이 더 중요합니다. `ThreadLocal` 누수가 진행 중일 때 관찰되는 주요 JVM 지표 패턴이 있습니다.

첫째, Old Generation 힙 사용량이 GC 후에도 지속적으로 증가하는 패턴입니다. 정상적인 애플리케이션에서는 Full GC 후 Old Gen 사용량이 안정된 기준선에 수렴합니다. 누수가 있으면 GC 후에도 이 기준선 자체가 점진적으로 상승합니다. Prometheus 환경에서는 `jvm_memory_used_bytes{area="heap", id="G1 Old Gen"}` 메트릭의 주간 추세를 Grafana 대시보드로 시각화하여 추적합니다.

둘째, GC 빈도와 일시 정지 시간의 증가입니다. 힙이 점점 채워지면 GC가 더 자주 발생하고 각 GC 사이클의 소요 시간도 길어집니다. 애플리케이션의 처리량(throughput)과 응답 지연이 동시에 악화된다면 메모리 누수를 1순위로 의심해야 합니다.

> **모니터링 핵심 신호**: Old Gen 사용률의 점진적 상승 추세 + Full GC 후 메모리 회수량 감소 + GC 빈도 증가가 동시에 나타나면 메모리 누수를 의심합니다. Tomcat 환경에서는 `catalina.out`의 `ThreadLocal` 관련 SEVERE 로그도 함께 확인합니다.

---

### 재현 가능한 테스트 작성

누수를 코드 레벨에서 조기에 발견하려면 단위 테스트 또는 통합 테스트에서 재현 가능한 시나리오를 구성하는 것이 중요합니다. 스레드 풀을 직접 생성하고 여러 태스크를 수행한 뒤, 태스크 완료 후 `ThreadLocal`에 여전히 값이 남아 있는지 확인하는 검증 테스트를 작성할 수 있습니다.

```java
// ThreadLocal 누수 시뮬레이션 및 검증 테스트
public class ThreadLocalLeakTest {

    // static 필드로 선언: ThreadLocal 인스턴스가 GC되지 않는 정상 패턴
    private static final ThreadLocal<byte[]> LEAK_PRONE = new ThreadLocal<>();

    @Test
    void threadPoolShouldNotRetainValuesAcrossRequests() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(1);

        // 1단계: 스레드에 큰 데이터 저장 (remove 없이 — 누수 시나리오)
        pool.submit(() -> {
            LEAK_PRONE.set(new byte[1024 * 1024]); // 1MB 할당
            // 의도적으로 remove() 생략 → 누수 유발
        }).get(); // 완료 대기

        // 2단계: 동일 스레드에서 값 잔류 여부 확인
        Future<Boolean> leaked = pool.submit(
            () -> LEAK_PRONE.get() != null // true = 누수 발생
        );

        // 이 단언이 실패하면 누수 확인됨
        assertFalse(leaked.get(), "이전 요청 데이터가 스레드에 잔류함 — 누수!");

        pool.shutdown();
    }
}
// 결과: assertFalse 실패 → LEAK_PRONE.get() != null (1MB 잔류 확인)
// 핵심: remove() 추가 시 get()이 null을 반환하여 단언 통과
```

이 테스트는 스레드 풀에서 스레드가 재사용될 때 `ThreadLocal` 값이 유지됨을 직접 확인합니다. `remove()`를 호출하지 않으면 두 번째 태스크에서 이전 값이 그대로 조회되어 단언이 실패하고, 이것이 누수의 증거가 됩니다. CI/CD 파이프라인에 이런 테스트를 포함하면 누수 가능성 있는 코드 변경을 배포 전 단계에서 차단할 수 있습니다.

---

## 해결 전략과 안전한 사용 패턴

### remove() 호출 패턴: try-finally와 Interceptor 기반

`ThreadLocal` 메모리 누수의 가장 직접적인 해결책은 사용이 끝난 후 반드시 `remove()`를 호출하는 것입니다. 그러나 이를 개발자 개인의 주의에만 맡기면 언젠가 누락이 발생합니다. 따라서 코드 구조적으로 `remove()`가 항상 호출되도록 강제하는 패턴이 필요합니다.

가장 신뢰할 수 있는 방법은 `try-finally` 블록을 사용하는 것입니다. `set()` 이후 `finally` 블록에서 `remove()`를 호출하면 예외가 발생하더라도 정리가 보장됩니다. 웹 애플리케이션에서는 `HandlerInterceptor`의 `afterCompletion()` 메서드나 서블릿 `Filter`의 `doFilter()` 마지막 단계에서 `remove()`를 호출하는 패턴이 특히 효과적입니다. 컨트롤러에서 예외가 발생하거나 비즈니스 로직이 복잡하게 분기되어도 `afterCompletion()`은 반드시 호출되기 때문입니다.

```java
// 안전한 ThreadLocal 사용 패턴 — 생명주기를 단일 클래스에 집중
public final class RequestContext {

    private static final ThreadLocal<RequestContextData> CONTEXT =
        ThreadLocal.withInitial(() -> null); // initialValue 명시

    private RequestContext() {} // 인스턴스화 금지

    public static void initialize(RequestContextData data) {
        CONTEXT.set(data);
    }

    public static Optional<RequestContextData> current() {
        return Optional.ofNullable(CONTEXT.get());
    }

    public static void clear() {
        CONTEXT.remove(); // 항상 이 메서드로만 정리
    }

    // 함수형 래퍼: Callable 실행 후 자동 정리 보장
    public static <T> T withContext(RequestContextData data,
                                     Callable<T> task) throws Exception {
        initialize(data);
        try {
            return task.call();
        } finally {
            clear(); // 예외 발생 여부와 관계없이 항상 실행됨
        }
    }
}

// Spring HandlerInterceptor를 통한 요청 단위 자동 정리
@Component
public class RequestContextInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest req,
                              HttpServletResponse res, Object handler) {
        RequestContext.initialize(RequestContextData.from(req));
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest req,
                                 HttpServletResponse res,
                                 Object handler, Exception ex) {
        RequestContext.clear(); // 컨트롤러 예외와 관계없이 항상 실행
    }
}
// 결과: 모든 HTTP 요청 완료 시 ThreadLocal 자동 정리 보장
// 핵심: preHandle → 비즈니스 로직 → afterCompletion(clear) 흐름 고정
```

이 패턴의 핵심은 `ThreadLocal`의 생명주기 관리를 단일 클래스에 집중시키고, 외부에서는 정리 메서드 호출을 잊기 어려운 구조로 만드는 것입니다. `withContext()` 래퍼 메서드는 비즈니스 로직 내부에서 임시로 컨텍스트를 설정해야 할 때 유용하며, 람다나 `Callable`로 감싼 코드 블록이 완료되면 자동으로 `clear()`를 호출합니다. `InterceptorRegistry`에 인터셉터를 등록하는 것만으로 웹 레이어 전체에 적용되므로 중복 코드 없이 정책을 일관되게 적용할 수 있습니다.

---

### InheritableThreadLocal과 TransmittableThreadLocal

멀티스레드 환경에서 부모 스레드의 컨텍스트를 자식 스레드에게 전파해야 하는 경우, 단순 `ThreadLocal`은 스레드 간 값 공유를 지원하지 않습니다. 이를 위해 Java 표준 라이브러리는 `InheritableThreadLocal`을 제공합니다. 새로운 스레드가 생성될 때(`Thread` 생성자 내부) 부모 스레드의 `inheritableThreadLocals` 맵을 복사하여 자식 스레드에게 전달합니다.

그러나 `InheritableThreadLocal`은 스레드 풀 환경에서 한계를 보입니다. 스레드 풀의 워커 스레드는 풀 초기화 시점에 단 한 번 생성됩니다. 이후 제출되는 태스크가 새로운 컨텍스트를 가지고 있어도, 워커 스레드는 생성 당시(풀 초기화 시점)의 컨텍스트만 상속받기 때문에 태스크 제출 시점의 최신 컨텍스트를 자동으로 받지 못합니다.

이 문제를 해결하기 위해 알리바바의 오픈소스 라이브러리인 **TTL(TransmittableThreadLocal)** 이 널리 활용됩니다. TTL은 `Runnable`이나 `Callable`을 래핑하여 태스크 제출 시점의 스레드 로컬 값을 캡처하고, 워커 스레드에서 태스크가 실행될 때 해당 값을 복원합니다. 실행이 완료되면 워커 스레드의 상태를 원래대로 되돌려 오염을 방지합니다.

| 구분 | ThreadLocal | InheritableThreadLocal | TTL |
|---|---|---|---|
| 스레드 간 전파 | 불가 | 스레드 생성 시만 | 태스크 제출 시점 |
| 스레드 풀 지원 | 해당 없음 | 미지원 | 완전 지원 |
| 성능 오버헤드 | 없음 | 낮음 | 낮음~중간 |
| 메모리 누수 위험 | 높음 | 높음 | 중간 (관리 필요) |
| 주요 사용 사례 | 단일 스레드 컨텍스트 | 단순 스레드 상속 | 비동기 컨텍스트 전파 |

---

### 대안 기술과의 비교: ScopedValue와 Virtual Thread

JDK 20부터 Preview로 도입된 **Scoped Values**(JEP 446, JDK 21 두 번째 Preview, JDK 23 GA)는 `ThreadLocal`의 설계 문제를 원천적으로 해결하려는 시도입니다. `ScopedValue`는 값이 불변(immutable)이며, 명시적인 스코프(scope) 내에서만 접근 가능합니다. 스코프를 벗어나는 순간 자동으로 이전 값으로 복원되므로 `remove()` 호출을 잊을 여지가 없습니다.

`ScopedValue`는 컨텍스트를 읽기 전용으로 전파하는 용도에 이상적입니다. 요청 추적 ID, 사용자 ID, 테넌트 정보처럼 요청 처리 내내 변경 없이 참조만 하는 데이터에 잘 어울립니다. 반면 값을 누적하거나 변경해야 하는 경우, 또는 기존 `ThreadLocal` 기반 라이브러리(Spring Security, Hibernate 등)와의 통합이 필요한 경우에는 여전히 `ThreadLocal`이 필요합니다.

| 비교 항목 | ThreadLocal | ScopedValue (JDK 21+) |
|---|---|---|
| 값 변경 가능 여부 | 가능 | 불가 (불변) |
| 자동 정리 | 없음 (명시적 remove 필요) | 스코프 종료 시 자동 |
| 메모리 누수 위험 | 높음 | 없음 |
| Virtual Thread 지원 | 가능 (주의 필요) | 최적화됨 |
| 기존 라이브러리 호환 | 광범위 | 별도 마이그레이션 필요 |
| 생산 적용 안정성 | 매우 안정적 | JDK 23 GA (신중 검토 필요) |

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

`ThreadLocal`을 사용하는 코드에서 현업 개발자들이 가장 자주 마주치는 실수들이 있습니다. 첫째, **static이 아닌 인스턴스 변수로 선언하는 경우**입니다. `ThreadLocal`은 일반적으로 `static final` 필드로 선언해야 합니다. 인스턴스 변수로 선언하면 해당 인스턴스가 GC될 때 `ThreadLocal` 인스턴스도 수거되어 키가 `null`이 됩니다. 문제는 값에 대한 강한 참조가 여전히 남아 있다는 점이며, 동시에 여러 `ThreadLocal` 인스턴스가 생성·소멸하는 상황에서는 stale entry가 급속도로 쌓입니다.

둘째, **null 체크 없이 초기값을 가정하는 경우**입니다. `ThreadLocal.get()`은 `initialValue()`를 오버라이드하지 않으면 `null`을 반환합니다. 스레드 풀에서 재사용된 스레드의 경우 이전 요청이 저장한 값이 반환될 수도 있어 예상치 못한 데이터 오염이 발생합니다. 항상 `ThreadLocal.withInitial(() -> defaultValue)` 형태로 초기값을 명시하거나, `get()` 결과를 `Optional`로 감싸는 것이 안전합니다.

셋째, **비동기 코드에서의 컨텍스트 유실**입니다. `CompletableFuture`, `@Async`, Reactor나 RxJava 같은 리액티브 스트림에서는 코드가 다른 스레드에서 실행되므로 `ThreadLocal` 값이 자동으로 전달되지 않습니다. 이를 모르고 비동기 핸들러에서 `ThreadLocal.get()`을 호출하면 `null`이 반환되거나 워커 스레드의 잔류 값이 반환됩니다.

| 실수 유형 | 증상 | 해결 방법 |
|---|---|---|
| static이 아닌 선언 | stale entry 과다, 메모리 증가 | static final로 선언 변경 |
| remove() 누락 | 데이터 오염, 메모리 누수 | try-finally 또는 Interceptor |
| 비동기 컨텍스트 유실 | null 반환, 잘못된 값 반환 | TTL 또는 명시적 파라미터 전달 |
| 무거운 객체 저장 | 누수 규모 폭발적 확대 | 값 객체(VO)나 불변 객체만 저장 |
| initialValue 미정의 | NPE 또는 예상치 못한 기존 값 | withInitial() 명시 |
| 클래스 로더 참조 저장 | Metaspace 고갈, 재배포 실패 | 컨테이너 공통 타입만 저장 |

---

### 모니터링과 디버깅: 운영 환경에서 관찰해야 할 지표

`ThreadLocal` 누수를 운영 환경에서 사전에 감지하려면 JVM 메모리 지표와 GC 로그를 지속적으로 추적해야 합니다. Micrometer와 Prometheus를 사용하는 Spring Boot 환경이라면, `jvm.memory.used` (Old Gen 기준) 메트릭의 주간 추세를 Grafana 대시보드로 시각화합니다. 정상적인 애플리케이션은 Old Gen 사용량이 GC 후 일정 수준에서 수렴하는 톱니 모양 패턴을 보입니다. 이 수렴 수준이 시간에 따라 지속적으로 상승하면 누수를 의심합니다.

GC 로그는 `-Xlog:gc*:file=/var/log/app/gc.log:time,uptime:filecount=5,filesize=20m` 옵션으로 활성화합니다. GCViewer나 GCEasy 도구로 분석하면 힙 사용 패턴과 GC 효율을 시각적으로 파악할 수 있습니다. 특히 Full GC 직후 힙 점유율이 이전 Full GC 직후보다 지속적으로 높아지는 패턴이 메모리 누수의 전형적 신호입니다.

```
정상 패턴 (GC 후 수렴):
힙  │  /\/\/\/\/\/\/\/\/\
사용│ /  기준선 유지      
량  │/____________________→ 시간

누수 패턴 (GC 후 상승):
힙  │           /\  /\
사용│      /\  /  \/  기준선 상승
량  │  /\ /  \/
    │ /  기준선
    │/___________________→ 시간
```

---

### 확장/마이그레이션: JDK 버전 업그레이드 시 체크리스트

JDK 21로 마이그레이션하면서 가상 스레드를 도입할 때 `ThreadLocal` 관련 주의사항이 있습니다. 가상 스레드는 기본적으로 `ThreadLocal`을 지원하지만, 수백만 개의 가상 스레드 각각이 `ThreadLocal` 값의 독립적인 사본을 가질 수 있어 메모리 사용량이 예상보다 크게 증가할 수 있습니다. 가상 스레드 환경에서 메모리 효율을 높이려면 `ScopedValue`로의 점진적 마이그레이션을 고려해야 합니다.

코드베이스 전체에서 `ThreadLocal` 사용 현황을 파악하는 것부터 시작합니다. 각 사용처에서 `remove()`가 제대로 호출되고 있는지, 비동기 코드에서 컨텍스트 전파가 올바르게 처리되고 있는지 검토합니다. ArchUnit을 활용하면 `ThreadLocal` 사용 패턴을 아키텍처 레벨에서 강제하여 신규 코드에서의 잘못된 사용을 빌드 시점에 차단할 수도 있습니다.

| 단계 | 작업 내용 | 도구 |
|---|---|---|
| 1. 현황 파악 | `grep -rn "ThreadLocal" src/` 전수 조사 | grep, IDE 검색 |
| 2. 위험 분류 | remove 누락, static 여부, 비동기 사용 분류 | 코드 리뷰 |
| 3. 테스트 추가 | 누수 시나리오 재현 테스트 작성 | JUnit 5 |
| 4. 정적 분석 | SpotBugs, ArchUnit 규칙 추가 | CI 파이프라인 |
| 5. 모니터링 | Old Gen 추세 대시보드 구성 | Grafana + Prometheus |
| 6. 점진적 마이그레이션 | 읽기 전용 컨텍스트는 ScopedValue로 교체 | JDK 21+ |

---

## 맺음말

### 핵심 요약

`ThreadLocal`은 스레드별 독립적인 컨텍스트 저장을 가능하게 하는 강력한 도구입니다. 내부적으로 `ThreadLocalMap`은 키를 `WeakReference`로, 값을 강한 참조로 유지하는 구조를 사용합니다. 이 비대칭 참조 구조가 스레드 풀 환경에서 `remove()`가 호출되지 않을 때 메모리 누수를 일으키는 근본 원인입니다. 클래스 로더 누수는 이보다 더 심각한 형태로, 서블릿 컨테이너 환경에서 재배포 시 `Metaspace` 고갈로 이어질 수 있습니다.

누수를 방지하는 핵심 전략은 세 가지로 요약됩니다. 첫째, `try-finally` 블록이나 `HandlerInterceptor.afterCompletion()`을 통해 구조적으로 `remove()`를 보장합니다. 둘째, 비동기 컨텍스트 전파가 필요하다면 TTL과 같은 검증된 라이브러리를 활용합니다. 셋째, `ThreadLocal`에는 가능한 한 가볍고 불변인 값 객체만 저장하여 간접 누수의 규모를 제한합니다.

---

### 적용 판단 기준: ThreadLocal이 적합한 상황과 아닌 상황

`ThreadLocal`이 적합한 상황은 명확합니다. 로그 추적 ID(MDC), 인증 컨텍스트처럼 요청 전체에 걸쳐 공유되어야 하지만 다른 스레드와는 격리되어야 하는 소형 불변 데이터를 전달할 때입니다. Spring Security의 `SecurityContextHolder`, 트랜잭션 컨텍스트 관리, `SimpleDateFormat`처럼 스레드 안전하지 않은 객체의 스레드별 재사용 등이 전형적인 정당한 사용 사례입니다.

반면 `ThreadLocal`이 부적합한 상황도 있습니다. 비동기 처리 흐름이 복잡하게 얽혀 있는 경우, 무거운 리소스 객체나 대형 데이터 구조를 저장하려는 경우, JDK 21+ 환경에서 가상 스레드를 수백만 개 규모로 활용하는 경우가 해당됩니다.

| 기준 | ThreadLocal 적합 | 대안 고려 |
|---|---|---|
| 값 불변성 | 불변 데이터 전파 | 가변 상태 → 명시적 파라미터 |
| 스레드 수명 | 풀 스레드 (remove 보장 시) | 가상 스레드 수백만 개 → ScopedValue |
| 컨텍스트 범위 | 요청 단위 격리 | 서비스 전반 공유 → 의존성 주입 |
| 비동기 전파 필요 | TTL로 보완 가능 | 복잡한 체인 → Reactor Context |
| 라이브러리 통합 | 기존 프레임워크 연계 | 신규 프로젝트 → ScopedValue 검토 |

---

### 다음 단계: 심화 학습 방향

`ThreadLocal`을 더 깊이 이해하고 싶다면 OpenJDK 소스 코드에서 `java.lang.ThreadLocal` 클래스, 특히 `ThreadLocalMap`의 `expungeStaleEntry()` 메서드를 직접 분석하는 것을 권장합니다. 이 메서드가 stale entry를 어떤 조건과 타이밍에 정리하는지 이해하면 왜 명시적 `remove()`가 필수인지 납득하게 됩니다.

비동기 컨텍스트 전파에 관심이 있다면 알리바바 TTL 프로젝트(https://github.com/alibaba/transmittable-thread-local)의 구현 원리와 Spring의 `TaskDecorator` 인터페이스를 통한 컨텍스트 전파 방법을 함께 살펴보시기 바랍니다. JDK 21 이상을 사용하고 있다면 JEP 446(Scoped Values, https://openjdk.org/jeps/446)과 JEP 453(Structured Concurrency, https://openjdk.org/jeps/453)을 조합하여 이해하면 현대 자바 동시성 프로그래밍의 흐름을 한 단계 깊이 파악할 수 있습니다.

| 심화 주제 | 핵심 학습 내용 | 참고 자료 |
|---|---|---|
| ThreadLocalMap 내부 | expungeStaleEntry, replaceStaleEntry 로직 | OpenJDK 소스 |
| TTL 원리 | 태스크 제출 시점 캡처·복원 메커니즘 | GitHub alibaba/TTL |
| Scoped Values | 불변 컨텍스트 전파, 가상 스레드 최적화 | JEP 446 |
| Structured Concurrency | 구조적 동시성 + ScopedValue 결합 패턴 | JEP 453 |
| Metaspace 분석 | 클래스 로더 누수 진단, MAT 활용법 | Eclipse MAT 공식 문서 |

[관련글:Java Virtual Thread 적용]
[관련글:Spring Security ThreadLocal]

---
