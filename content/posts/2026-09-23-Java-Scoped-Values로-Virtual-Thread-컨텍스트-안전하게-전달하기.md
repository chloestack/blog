---
title: "Java Scoped Values로 Virtual Thread 컨텍스트 안전하게 전달하기"
date: "2026-09-23 02:37"
publishedAt: ""
category: "Java"
tags: ["Scoped Values", "Virtual Thread", "Java 동시성", "ThreadLocal", "구조적 동시성"]
excerpt: "Java 21에서 정식 출시된 Virtual Thread는 \"플랫폼 스레드 한 개당 요청 하나\"라는 기존 모델을 완전히 바꾸었습니다."
status: "draft"
---

## 목차

1. 개요
2. ThreadLocal의 구조적 한계
3. Scoped Values 동작 원리
4. Scoped Values 적용법
5. ThreadLocal과 Scoped Values 심층 비교
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경: 수십만 스레드가 공유하는 컨텍스트

Java 21에서 정식 출시된 Virtual Thread는 "플랫폼 스레드 한 개당 요청 하나"라는 기존 모델을 완전히 바꾸었습니다. JVM이 경량 스레드를 캐리어 스레드(OS 스레드) 위에 올렸다 내렸다 하면서 수십만 개의 Virtual Thread를 동시에 처리할 수 있게 되었습니다. 그런데 문제는 컨텍스트 전달에 있었습니다. 요청자 ID, 인증 토큰, 트레이싱 정보처럼 한 요청 처리 흐름 전체에 걸쳐 공유해야 하는 데이터를 어디에 두어야 할지가 불명확해진 것입니다. 기존에는 `ThreadLocal`이 사실상 유일한 선택지였지만, Virtual Thread 환경에서는 이 방식이 메모리, 안전성, 성능 여러 면에서 문제를 일으킵니다. Java 24에서 JEP 487로 정식화된 **Scoped Values**는 이 문제를 근본적으로 다른 방식으로 해결합니다. 스레드에 값을 "소유"시키는 대신, 특정 스코프 안에서만 유효한 불변 바인딩을 만들어 계층적으로 전달합니다. 이 글에서는 Scoped Values의 동작 원리부터 실제 프로젝트 적용 방법, ThreadLocal과의 트레이드오프, 운영 환경에서 주의할 점까지 깊이 있게 살펴봅니다.

### 기존 방식의 한계: ThreadLocal이 버티던 자리

`ThreadLocal`은 Java 1.2부터 존재한 오래된 API입니다. 각 스레드가 독립적인 값을 가질 수 있도록 스레드 내부에 `ThreadLocalMap`을 두고 키-값 쌍으로 데이터를 저장합니다. 서블릿 기반 웹 프레임워크에서 요청 컨텍스트를 스레드에 묶어 두는 데 광범위하게 사용되었고, Spring의 `RequestContextHolder`, SLF4J의 MDC(Mapped Diagnostic Context) 등 수많은 라이브러리가 이 구조에 의존합니다. "스레드당 하나의 요청"이라는 가정이 성립하는 전통적인 블로킹 모델에서는 무리 없이 작동했지만, 그 가정이 무너지는 Virtual Thread 환경에서는 구조적 허점이 수면 위로 드러납니다. 값의 수명을 개발자가 직접 관리해야 하고, 대량 복사로 메모리를 낭비하며, 불변성이 없어 추적이 어렵다는 문제들이 Virtual Thread 대규모 사용 시 증폭됩니다.

---

## ThreadLocal의 구조적 한계

### 메모리 구조와 누수 위험

`ThreadLocal`은 스레드 자체에 `ThreadLocalMap`이라는 내부 해시맵을 붙여 값을 저장합니다. 이 맵의 키는 `ThreadLocal` 인스턴스 자체를 약한 참조(WeakReference)로 가리키고, 값은 강한 참조(strong reference)로 저장됩니다. 따라서 `ThreadLocal` 객체가 GC에 수집되어 키가 사라져도 값은 맵 안에 남아 메모리 누수가 발생합니다. 스레드 풀 환경에서는 스레드 자체가 재활용되기 때문에, 이전 요청에서 `set()`으로 저장한 값이 다음 요청으로 그대로 흘러들어 가는 데이터 오염 문제도 생깁니다. 이를 막으려면 `try-finally` 블록에서 반드시 `remove()`를 호출해야 하지만, 이 호출이 빠지는 경우가 현장에서 반복적으로 발생합니다.

```diagram
2026-09-23-742bf48b-01
```

키가 사라져도 값이 남는 구조 탓에, 스레드 풀에서 `remove()` 없이 재활용되는 스레드는 이전 요청의 잔류 데이터를 다음 요청에 노출시킬 수 있습니다.

---

### Virtual Thread와 ThreadLocal의 충돌

Virtual Thread는 플랫폼 스레드와 달리 생성 비용이 매우 낮아 요청 한 건당 Virtual Thread 하나를 만드는 것이 권장 패턴입니다. 이 경우 `ThreadLocal`에 대규모 데이터를 저장하면 Virtual Thread 수만큼 복사본이 생겨 메모리가 급격히 증가합니다. 더 심각한 문제는 `InheritableThreadLocal`입니다. 부모 스레드에서 자식 스레드를 생성할 때 부모의 `ThreadLocalMap` 전체를 복사하기 때문에, Virtual Thread를 대량 생성하는 환경에서는 이 복사 비용이 누적되어 성능 병목이 됩니다. 복사된 맵을 자식 스레드가 독립적으로 수정하면 원본과 사본 간의 일관성도 유지하기 어렵고, 값의 변경 흐름을 추적하는 것도 사실상 불가능해집니다.

```diagram
2026-09-23-742bf48b-02
```

Virtual Thread가 많아질수록 `InheritableThreadLocal` 복사 비용이 선형으로 누적되어, 대규모 동시성 환경에서 심각한 메모리 낭비와 생성 지연을 초래합니다.

---

### 핀닝 문제와 캐리어 스레드 점유

Virtual Thread는 블로킹 I/O를 만나면 캐리어 스레드에서 분리(unmount)되어 대기하고, 다른 Virtual Thread가 그 캐리어 스레드를 사용합니다. 그러나 `synchronized` 블록이나 네이티브 메서드 안에 있을 때는 분리가 불가능하여 캐리어 스레드에 **핀닝(pinning)**됩니다. 일부 오래된 라이브러리는 `ThreadLocal`을 통해 스레드 친화적인 네이티브 리소스를 관리하면서 동시에 `synchronized`를 사용하는데, 이 조합이 Virtual Thread 환경에서 캐리어 스레드를 오랫동안 점유하는 핀닝 문제를 유발합니다. `ThreadLocal` 자체가 핀닝의 직접 원인은 아니지만, 기존 `ThreadLocal` 기반 코드베이스를 Virtual Thread로 전환할 때 이런 숨겨진 핀닝 지점을 함께 발견하게 되는 경우가 많습니다.

| 문제 유형 | 원인 | 영향 |
|---|---|---|
| 메모리 누수 | `remove()` 미호출, 값의 강한 참조 | 힙 증가, GC 부담 |
| 데이터 오염 | 스레드 풀 재활용 시 잔류 값 | 보안 사고, 디버깅 난이도 상승 |
| 대량 복사 | `InheritableThreadLocal` 맵 전체 복사 | 메모리 ×N, 생성 지연 |
| 불변성 부재 | 어디서나 `set()` 가능 | 추적 불가능한 값 변경 |
| 핀닝 연관성 | `synchronized` 블록과 조합 | 캐리어 스레드 점유, 처리량 저하 |

---

## Scoped Values 동작 원리

### 불변 바인딩과 스코프 경계

Scoped Values의 핵심 아이디어는 간단합니다. 값을 스레드에 묶는 대신, **특정 코드 스코프 안에서만 유효한 이름에 묶는다**는 것입니다. `ScopedValue<T>` 객체는 이름(키) 역할을 하고, `ScopedValue.where(key, value).run(...)` 또는 `.call(...)`(반환값이 필요한 경우) 호출로 그 스코프가 시작됩니다. 스코프 안에서는 `key.get()`으로 값을 읽을 수 있고, 스코프가 끝나면 바인딩은 자동으로 해제됩니다. `ThreadLocal.set()`처럼 임의의 시점에 값을 변경하는 것이 불가능하며, 한번 바인딩된 값은 해당 스코프 안에서 항상 동일한 값을 반환합니다. 이 불변성이 Scoped Values가 제공하는 안전성의 핵심입니다. 값이 어디서 어떻게 변경되었는지를 추적하느라 소비되던 디버깅 시간이 사라지고, 코드를 읽는 것만으로 컨텍스트의 출처와 수명을 파악할 수 있습니다.

```diagram
2026-09-23-742bf48b-03
```

스코프 경계가 코드 구조와 일치하기 때문에 값의 수명이 명확하며, `remove()` 같은 수동 정리가 필요 없습니다.

---

### 상속과 구조적 동시성

Scoped Values는 Java 21에서 함께 정식화된 구조적 동시성(Structured Concurrency, JEP 453)과 긴밀하게 설계되었습니다. `StructuredTaskScope` 안에서 포크(fork)된 자식 Virtual Thread는 부모 스코프의 `ScopedValue` 바인딩을 자동으로 상속합니다. 이 상속은 값의 복사가 아닌 참조 공유이기 때문에 메모리 오버헤드가 전혀 없습니다. 자식 스레드는 부모의 값을 읽을 수 있지만 변경할 수 없으며, 자식이 새로운 스코프에서 값을 리바인딩하더라도 그 변경은 자식 스코프 안에만 한정됩니다. Virtual Thread 100,000개가 동일한 트레이싱 ID를 공유할 때, `InheritableThreadLocal`은 100,000개의 복사본을 만들지만 Scoped Values는 단 하나의 객체를 참조 공유합니다. 이것이 대규모 Virtual Thread 환경에서 Scoped Values가 훨씬 유리한 이유입니다.

```diagram
2026-09-23-742bf48b-04
```

부모의 바인딩이 자식에게 복사 없이 전달되므로, 수십만 개의 Virtual Thread가 동일한 컨텍스트를 공유해도 메모리는 단 하나의 값만 사용합니다.

---

### 내부 구현: 스택 기반 스코프 체인

JVM 내부에서 Scoped Values는 각 스레드가 가진 경량 스코프 체인(scope chain)을 따라 동작합니다. 바인딩을 생성하면 현재 스코프 체인에 새 항목이 추가되고, 스코프가 종료되면 해당 항목이 제거됩니다. `get()` 호출 시에는 현재 스레드의 스코프 체인을 탐색하여 가장 가까운(가장 안쪽) 바인딩을 반환합니다. 이 구조는 중첩 스코프를 자연스럽게 지원합니다. 바깥 스코프에서 `K → V1`을 바인딩하고, 안쪽 스코프에서 `K → V2`로 리바인딩하면, 안쪽에서는 V2가, 바깥 스코프로 돌아오면 다시 V1이 반환됩니다. `ThreadLocalMap`처럼 해시 충돌이나 약한 참조 처리가 없으므로 구조가 훨씬 단순하고 예측 가능합니다. 스코프 체인 탐색은 깊이에 비례하지만, 일반적인 애플리케이션에서 중첩 깊이가 수십 레벨을 넘는 경우는 드물기 때문에 실질적인 성능 부담은 미미합니다.

> **핵심 규칙**: Scoped Values는 쓰기가 아니라 바인딩입니다. 값을 변경하려면 반드시 새 스코프를 열어야 하고, 그 변경은 새 스코프 안에서만 유효합니다.

---

## Scoped Values 적용법

### 기본 선언과 바인딩

`ScopedValue`는 `static final` 필드로 선언합니다. Java 24 이후에는 `--enable-preview` 플래그 없이 사용할 수 있으며, Java 25 LTS(2025년 9월)에서도 정식 API로 제공됩니다. 아래는 HTTP 요청 처리 시나리오에서 인증된 사용자 ID와 트레이싱 ID를 컨텍스트로 전달하는 기본 패턴입니다. 필터 또는 인터셉터 레이어에서 바인딩을 한 번 설정하면, 그 아래 모든 서비스 레이어에서 파라미터 전달 없이 컨텍스트에 접근할 수 있습니다.

```java
public class RequestContext {
    // ScopedValue는 static final로 선언 — 이름(키) 역할
    public static final ScopedValue<String> USER_ID  = ScopedValue.newInstance();
    public static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();
}

public class RequestFilter {
    public void doFilter(HttpRequest request, FilterChain chain) {
        String userId  = authenticate(request);      // 인증 단계에서 사용자 ID 추출
        String traceId = extractTrace(request);       // 트레이싱 헤더 추출

        // 두 값을 한 스코프에 바인딩 — 스코프 안의 모든 코드에서 접근 가능
        ScopedValue.where(RequestContext.USER_ID, userId)
                   .where(RequestContext.TRACE_ID, traceId)
                   .run(() -> chain.doFilter(request));
        // run() 반환 후 두 바인딩은 자동 해제 — remove() 불필요
    }
}

public class OrderService {
    public void createOrder(OrderRequest req) {
        // 메서드 시그니처에 userId, traceId 없어도 바로 접근
        String currentUser = RequestContext.USER_ID.get();   // 결과: "user-123"
        String trace       = RequestContext.TRACE_ID.get();  // 결과: "trace-abc"
        log.info("[{}] 주문 생성 요청: user={}", trace, currentUser);
    }
}
```

`where()` 체이닝으로 여러 값을 한 번에 바인딩하고, `run()`으로 스코프를 엽니다. 예외가 발생해도 스코프는 반드시 종료되므로 바인딩은 항상 정확히 해제됩니다.

| 메서드 | 반환 타입 | 예외 전파 | 언제 쓰나 |
|---|---|---|---|
| `run(Runnable)` | void | 언체크드 예외 전파 | 반환값 불필요 |
| `call(Callable<T>)` | T | 체크드 예외 포함 전파 | 반환값 필요 |
| `get()` | T | 바인딩 없으면 예외 | 반드시 바인딩된 상황 |
| `getOrElse(default)` | T | 없으면 기본값 반환 | 바인딩 선택적인 상황 |
| `isBound()` | boolean | 없음 | 바인딩 여부 조건 분기 |

---

### 구조적 동시성과 함께 쓰기

Scoped Values가 가장 강력한 위력을 발휘하는 것은 `StructuredTaskScope`와 함께 사용할 때입니다. 부모 스코프의 바인딩이 자동으로 자식 Virtual Thread에 상속되므로, 병렬로 실행되는 모든 서브태스크가 동일한 트레이싱 컨텍스트를 자동으로 공유합니다. 이 패턴은 마이크로서비스에서 여러 하위 서비스를 동시에 호출할 때 각 서브태스크의 로그에 동일한 트레이싱 ID가 찍혀야 하는 요구사항을 파라미터 전달 없이 충족시킵니다.

```java
public class OrderService {
    public OrderResult processOrder(String orderId) throws Exception {
        // 호출 시점에 USER_ID, TRACE_ID 바인딩이 이미 설정되어 있다고 가정
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            // 각 서브태스크는 별도 Virtual Thread에서 실행
            // 부모의 ScopedValue 바인딩을 자동 상속 — 파라미터 전달 불필요
            var inventoryTask = scope.fork(() -> checkInventory(orderId));
            var paymentTask   = scope.fork(() -> processPayment(orderId));
            var shippingTask  = scope.fork(() -> scheduleShipping(orderId));

            scope.join().throwIfFailed();   // 셋 중 하나라도 실패하면 나머지 취소

            return new OrderResult(
                inventoryTask.get(),
                paymentTask.get(),
                shippingTask.get()
            );
        }
    }

    private InventoryResult checkInventory(String orderId) {
        // 자식 Virtual Thread에서 부모의 바인딩에 직접 접근
        String user  = RequestContext.USER_ID.get();   // 부모에서 상속, 복사 아님
        String trace = RequestContext.TRACE_ID.get();  // 부모에서 상속
        log.info("[{}] 재고 확인: user={}", trace, user);
        // ... 재고 확인 로직
    }
}
```

세 개의 서브태스크가 각각 별도 Virtual Thread에서 실행되지만, 어느 스레드에서도 `USER_ID.get()`과 `TRACE_ID.get()`이 부모와 동일한 값을 반환합니다. 이 값들은 복사되지 않으므로 서브태스크가 아무리 많아도 메모리는 원본 하나만 사용합니다.

---

### 중첩 스코프와 리바인딩

동일한 `ScopedValue` 키에 대해 내부 스코프에서 다른 값으로 리바인딩할 수 있습니다. 이 리바인딩은 내부 스코프 안에서만 유효하며, 내부 스코프가 종료되면 자동으로 바깥 스코프의 원래 값이 복원됩니다. 예를 들어 감사(audit) 작업 실행 시 특정 구간에서만 시스템 계정으로 ID를 교체해야 하는 경우, 또는 테스트 격리를 위해 특정 코드 구간에서만 다른 사용자 컨텍스트를 주입해야 하는 경우에 유용합니다. 이 패턴 덕분에 전역 상태를 건드리지 않고 컨텍스트 조작을 국소화(localize)할 수 있습니다.

```diagram
2026-09-23-742bf48b-05
```

내부 스코프의 리바인딩이 외부 값에 전혀 영향을 주지 않으므로, 컨텍스트 조작의 부수 효과 범위를 코드 블록 단위로 정확히 제한할 수 있습니다.

---

## ThreadLocal과 Scoped Values 심층 비교

### API 차이와 마이그레이션 전략

두 API의 가장 큰 차이는 **값을 바꾸는 방식**에 있습니다. `ThreadLocal`은 `set()`으로 언제 어디서든 값을 덮어쓸 수 있습니다. 이 유연성이 편리하게 느껴지지만, 코드베이스가 커지면 "이 값을 언제, 어디서 바꿨는지"를 추적하기 어렵게 만드는 근본 원인이 됩니다. Scoped Values는 `where(...).run(...)`이라는 명확한 문법으로 값의 유효 범위를 코드 구조에 드러냅니다. `set()`이 없기 때문에 값의 출처가 항상 스코프 진입 시점으로 특정됩니다. 마이그레이션 전략으로는 먼저 `ThreadLocal.set()`이 호출되는 지점과 `remove()`가 호출되는(또는 빠져 있는) 지점을 모두 식별한 뒤, 그 경계를 `ScopedValue.where(...).run(...)` 블록으로 대체합니다. 값을 읽는 코드(`get()`)는 거의 그대로 유지할 수 있어 마이그레이션 단위 비용이 낮은 편입니다.

```diagram
2026-09-23-742bf48b-06
```

`ThreadLocal`은 수명 관리를 개발자에게 맡기지만, Scoped Values는 스코프 구조 자체가 수명을 보장합니다.

---

### 성능 특성과 메모리 영향

벤치마크 측면에서 Scoped Values의 `get()`은 `ThreadLocal`의 `get()`과 비슷하거나 더 낮은 비용을 보입니다. `ThreadLocal`의 `get()`은 내부적으로 해시맵 탐색을 수행하지만, Scoped Values는 스코프 체인을 선형 탐색합니다. 스코프 체인 깊이가 수십 레벨을 넘지 않는 일반적인 애플리케이션에서는 Scoped Values의 탐색이 더 단순하고 CPU 캐시 친화적입니다. 메모리 측면에서의 차이는 더욱 극적입니다. 동시 요청 10만 건을 Virtual Thread로 처리할 때 트레이싱 ID 하나를 `InheritableThreadLocal`로 전달하면 동일한 문자열이 10만 번 복사됩니다. 반면 Scoped Values로 전달하면 원본 하나를 참조 공유하므로 메모리 사용량은 요청 수와 무관하게 일정합니다.

| 항목 | ThreadLocal | InheritableThreadLocal | Scoped Values |
|---|---|---|---|
| `get()` 비용 | 해시맵 탐색 | 해시맵 탐색 | 체인 선형 탐색 |
| VT 10만 기준 메모리 | 값 × 10만 | 값 × 10만 복사 | 값 × 1 참조 공유 |
| 수명 관리 | 수동 `remove()` | 수동 `remove()` | 스코프 자동 해제 |
| 불변성 보장 | 없음 | 없음 | 있음 |
| 구조적 동시성 지원 | 미지원 | 제한적 | 공식 지원 |
| Java 버전 | 1.2부터 | 1.2부터 | Java 24 정식 |

---

### 어떤 상황에서 무엇을 선택할 것인가

Scoped Values가 모든 상황에서 우월한 것은 아닙니다. 값을 동적으로, 그리고 반복적으로 업데이트해야 하는 상황이라면 `ThreadLocal`이 더 직관적일 수 있습니다. 단일 스레드 안에서 루프를 돌며 누적 상태를 유지하거나, 레거시 코드와의 통합이 복잡한 경우에는 `ThreadLocal` 유지가 실용적입니다. 반면 요청 스코프 컨텍스트(사용자 ID, 트레이싱 ID, 로케일, 퍼미션 정보 등)처럼 읽기 위주이고, 생성 시점에 값이 결정되며, 하위 호출 체인 전체에 전달해야 하는 데이터라면 Scoped Values가 명확한 선택입니다. Virtual Thread를 적극 활용하는 신규 프로젝트라면 처음부터 Scoped Values를 기본으로 채택하는 것이 권장됩니다.

```diagram
2026-09-23-742bf48b-07
```

선택 기준은 단순합니다. 값의 불변성을 보장할 수 있고 Virtual Thread를 사용한다면 Scoped Values, 값이 동적으로 바뀌어야 한다면 ThreadLocal입니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

첫 번째 함정은 **바운드 체크 생략**입니다. `ScopedValue.get()`은 현재 스코프 체인에 바인딩이 없으면 `NoSuchElementException`을 던집니다. 단위 테스트, 스케줄러, 비동기 콜백처럼 HTTP 요청 스코프 외부에서 실행되는 코드가 `get()`을 호출하면 예외가 발생합니다. 이를 방지하려면 `isBound()` 확인 후 `get()`을 호출하거나, `getOrElse(defaultValue)` 메서드를 사용하는 것이 안전합니다. 두 번째 함정은 **Scoped Values와 ThreadLocal의 혼용**입니다. SLF4J의 MDC, Spring Security의 `SecurityContextHolder`는 내부적으로 `ThreadLocal`을 사용합니다. 부모 스레드에서 MDC를 설정해도 자식 Virtual Thread에 자동으로 전달되지 않으므로, MDC 값을 Scoped Values로 캡처한 뒤 자식 스레드에서 다시 MDC에 설정하는 브리지 코드가 필요합니다. 세 번째 함정은 **중첩 바인딩 남용**입니다. 중첩 리바인딩은 스코프 체인 길이를 늘려 `get()` 탐색 비용을 증가시킵니다. 현업에서는 중첩 깊이를 3~4 레벨 이내로 유지하는 것이 권장됩니다.

```diagram
2026-09-23-742bf48b-08
```

바인딩 여부를 확인하지 않은 `get()` 호출은 스코프 외부에서 예외를 발생시키므로, 방어적 코드 패턴이 필요합니다.

---

### 모니터링과 디버깅

Scoped Values는 `ThreadLocal`보다 훨씬 추적하기 쉽습니다. 값이 변경될 수 있는 지점이 `where(...).run(...)` 블록으로 한정되어 있기 때문에, 호출 스택에서 `ScopedValue$Carrier.run()` 프레임을 찾으면 바인딩 시작 지점을 즉시 특정할 수 있습니다. JVM의 스레드 덤프에는 Virtual Thread의 캐리어 스레드 정보와 현재 실행 상태가 포함되며, Java 21 이후의 JFR(Java Flight Recorder)은 Virtual Thread 핀닝 이벤트(`jdk.VirtualThreadPinned`)를 캡처하여 핀닝이 발생하는 위치를 정확히 보여 줍니다. 컨텍스트 전달이 올바른지 확인하려면 통합 테스트에서 서브태스크 안에서 `ScopedValue.get()`을 호출하여 기대값과 일치하는지 단언(assert)하는 방법이 효과적입니다. 이 테스트는 미래의 마이그레이션이나 리팩터링 시에도 컨텍스트 전달 계약이 깨지지 않았음을 보증하는 회귀 방지 역할을 합니다.

| 모니터링 항목 | 도구 | 확인 내용 |
|---|---|---|
| Virtual Thread 핀닝 | JFR (`jdk.VirtualThreadPinned`) | 핀닝 발생 위치, 지속 시간 |
| 힙 메모리 추세 | VisualVM, async-profiler | VT 증가 대비 메모리 비율 |
| 스코프 체인 깊이 | 커스텀 계측 | `get()` 탐색 비용 증가 여부 |
| 바인딩 누락 | 단위 · 통합 테스트 | `NoSuchElementException` 발생 위치 |
| MDC 전파 여부 | 로그 집계 시스템 | 트레이싱 ID 누락된 로그 라인 |

---

### 확장과 마이그레이션 전략

기존 코드베이스의 `ThreadLocal`을 Scoped Values로 전환할 때는 일괄 교체보다 단계적 접근이 현실적입니다. 첫 단계에서는 신규 기능과 새로 작성하는 서비스에서 Scoped Values를 채택하고, 기존 `ThreadLocal` 코드는 유지합니다. 두 번째 단계에서는 메모리 · 성능 개선 효과가 가장 큰 `InheritableThreadLocal` 사용처를 우선 식별하여 마이그레이션합니다. 특히 요청 컨텍스트를 스레드 풀 포크 시 자동 복사하도록 설계된 코드가 대상입니다. 세 번째 단계에서는 Spring Security의 `SecurityContextHolder`, MDC 같은 프레임워크 레벨의 `ThreadLocal` 의존성을 다룹니다. Spring Framework 6.1 이후에는 Virtual Thread를 공식 지원하며, Spring Security 6.3 이후에는 Reactive · Virtual Thread 친화적인 방식으로 보안 컨텍스트를 관리하는 옵션이 제공되므로, 이 버전 이상에서는 마이그레이션 부담이 상당히 줄었습니다. 네 번째 단계에서는 나머지 레거시 `ThreadLocal` 사용처를 순차적으로 전환합니다.

```diagram
2026-09-23-742bf48b-09
```

단계적 마이그레이션은 위험을 최소화하면서 Scoped Values의 이점을 점진적으로 확보하는 접근입니다.

---

## 맺음말

### 핵심 요약

이 글에서 다룬 내용을 정리하면 다음과 같습니다. 첫째, `ThreadLocal`은 메모리 누수, 데이터 오염, 대량 복사, 불변성 부재라는 구조적 한계를 지니며 Virtual Thread 환경에서 이 한계가 더욱 두드러집니다. 둘째, Java 24에서 JEP 487로 정식화된 Scoped Values는 불변 바인딩과 명확한 스코프 경계를 통해 이 문제를 근본적으로 해결합니다. 스코프가 종료되면 바인딩이 자동 해제되므로 수동 `remove()`가 필요 없고, 값의 수명이 코드 구조와 일치합니다. 셋째, `StructuredTaskScope`와 함께 사용하면 부모의 바인딩이 자식 Virtual Thread에 복사 없이 참조 공유되어, 수십만 개의 Virtual Thread가 동일한 컨텍스트를 공유해도 메모리 오버헤드가 없습니다. 넷째, 마이그레이션은 점진적으로, `InheritableThreadLocal` 사용처와 신규 기능부터 시작하는 것이 현실적이며, Spring Framework 6.1 이상 환경에서는 프레임워크 레벨의 지원도 충분히 갖춰져 있습니다.

### 적용 판단 기준

Scoped Values 도입이 즉각적인 효과를 줄 수 있는 상황은 다음과 같습니다. **Java 24 이상**(또는 Java 21~23에서 preview 플래그를 허용하는 환경)을 사용하고 있고, Virtual Thread를 이미 적용했거나 도입을 계획 중이며, 요청 컨텍스트(사용자 ID, 트레이싱 ID, 테넌트 정보 등)를 여러 서비스 레이어에 걸쳐 전달하는 패턴이 있거나, `InheritableThreadLocal`로 인한 메모리 증가를 경험하고 있다면 전환 검토를 권장합니다. 반면 값이 스코프 안에서 동적으로 변경되어야 하거나, Java 버전 업그레이드가 단기간에 불가능하거나, 레거시 프레임워크와의 통합 부담이 큰 경우라면 기존 `ThreadLocal`을 유지하면서 Java LTS 업그레이드 시점에 맞춰 점진적 전환을 준비하는 것이 합리적인 선택입니다. Scoped Values는 "더 안전한 ThreadLocal 대체제"가 아니라 Virtual Thread 시대의 새로운 컨텍스트 전달 패러다임으로 이해할 때 그 가치가 분명해집니다.
