---
title: "Java ClassLoader 계층과 클래스 격리 구현"
date: "2026-09-21 02:38"
publishedAt: ""
category: "Java"
tags: ["Java ClassLoader", "클래스 격리", "플러그인 시스템", "JVM 내부", "URLClassLoader"]
excerpt: "Java ClassLoader는 JVM이 클래스 파일을 메모리에 올리는 메커니즘의 핵심입니다. 애플리케이션이 단순히 \"동작\"하는 수준을 넘어, 같은 JVM 프로세스 안에서 서로 다른 버전의 라이브러리를 격리하거나 런타임에 동적으로 코…"
status: "draft"
---

## 목차

1. 개요
2. ClassLoader 계층 구조의 설계 원리
3. 위임 모델의 동작 방식
4. 커스텀 ClassLoader 구현
5. 클래스 격리 패턴 심화
6. 성능과 트레이드오프
7. 운영 환경 적용 시 고려사항
8. 맺음말

---

## 개요

### 문제 배경

Java ClassLoader는 JVM이 클래스 파일을 메모리에 올리는 메커니즘의 핵심입니다. 애플리케이션이 단순히 "동작"하는 수준을 넘어, 같은 JVM 프로세스 안에서 서로 다른 버전의 라이브러리를 격리하거나 런타임에 동적으로 코드를 로드해야 하는 순간이 있습니다. 플러그인 아키텍처, 멀티테넌트 애플리케이션 서버, 핫 스왑이 필요한 배포 시스템이 그 대표적인 예입니다. Java ClassLoader 계층을 이해하고 커스텀 ClassLoader로 클래스 격리를 구현하면, 이러한 요구사항을 JVM 수준에서 직접 해결할 수 있습니다. 이 글에서는 ClassLoader의 계층 구조와 위임 모델을 깊이 분석하고, 실제 격리 구현 패턴과 운영 환경에서의 주의사항까지 다룹니다.

> ClassLoader를 이해한다는 것은 JVM이 "이 클래스가 저 클래스와 같은가"를 어떻게 판단하는지를 이해하는 것입니다. 이 판단 기준이 격리 설계의 전부입니다.

### 기존 방식의 한계

전통적인 단일 클래스패스 방식에서는 동일한 완전 한정 클래스 이름(FQCN)을 가진 클래스는 한 번만 로드됩니다. 예를 들어 라이브러리 A의 v1.0과 v2.0을 동시에 사용하려면, 두 버전이 같은 패키지·클래스명을 가질 경우 한쪽을 포기해야 합니다. 이 문제는 단순한 의존성 충돌로 끝나지 않고, 대규모 엔터프라이즈 환경에서 런타임 오류, 예측 불가능한 동작, 장애로 이어집니다. OSGi가 오랫동안 이 문제를 해결하기 위해 사용됐고, 더 나아가 각 모듈이 독립적인 ClassLoader를 갖는 구조가 모듈 격리의 핵심이 됐습니다. JDK 9 이후 모듈 시스템이 도입됐지만, 여전히 ClassLoader를 직접 제어해야 하는 상황은 현업에서 빈번합니다.

| 상황 | 단일 클래스패스 방식 | 클래스 격리 방식 |
|---|---|---|
| 같은 라이브러리 두 버전 사용 | 불가능 | 각 ClassLoader에서 독립 로드 |
| 런타임 플러그인 로드·언로드 | 불가능 | ClassLoader 생성·해제로 제어 |
| 멀티테넌트 클래스 분리 | 공유 오염 위험 | 테넌트별 격리 보장 |
| 핫 배포 | 전체 재시작 필요 | 대상 ClassLoader만 교체 |

---

## ClassLoader 계층 구조의 설계 원리

### Bootstrap, Platform, App ClassLoader의 역할

Java ClassLoader는 태생부터 계층 구조를 갖도록 설계됐습니다. JVM 스펙은 세 가지 기본 ClassLoader를 정의하고, 각각의 책임 영역을 명확히 구분합니다.

**Bootstrap ClassLoader**는 JVM 자체의 일부로, `java.lang`, `java.util` 등 핵심 Java API 클래스를 로드합니다. Java 코드로 작성된 것이 아니라 네이티브(C/C++) 코드로 구현돼 있어, `Class.getClassLoader()`를 호출하면 `null`을 반환합니다. 이것은 버그가 아니라 "이 클래스는 Bootstrap ClassLoader가 로드했다"는 신호입니다.

**Platform ClassLoader**(JDK 8까지는 Extension ClassLoader)는 `$JAVA_HOME/lib/ext`나 `java.ext.dirs`에 있는 확장 클래스들을 담당했습니다. JDK 9 이후 모듈 시스템이 도입되면서 이름이 바뀌고 역할도 조정됐지만, 계층에서의 위치는 유지됩니다.

**Application ClassLoader**(System ClassLoader라고도 합니다)는 `-classpath` 또는 `CLASSPATH` 환경변수에 지정된 경로의 클래스를 로드합니다. 우리가 작성한 애플리케이션 코드가 대부분 이 ClassLoader를 통해 로드됩니다. 커스텀 ClassLoader를 만들 때 부모를 명시적으로 지정하지 않으면 Application ClassLoader가 자동으로 부모가 됩니다.

```diagram
2026-09-21-56d0a588-01
```

부모 ClassLoader가 자식보다 먼저 클래스 로딩을 시도하는 구조로, 핵심 API의 무결성이 애플리케이션 코드에 의해 침해되지 않도록 보호합니다.

### 클래스 동일성의 정의

Java에서 두 클래스가 "같다"고 판단되려면 단순히 FQCN이 같아서는 부족합니다. **로드한 ClassLoader까지 동일해야** 합니다. 이 정의가 클래스 격리의 핵심 원리입니다. `com.example.MyService`라는 클래스를 ClassLoader A와 ClassLoader B가 각각 로드하면, JVM은 이 둘을 서로 다른 타입으로 취급합니다.

이 사실은 흥미로운 결과를 낳습니다. 서로 다른 ClassLoader가 로드한 객체 사이에서는 직접 캐스팅이 불가능합니다. 캐스팅을 시도하면 `ClassCastException`이 발생하는데, 이는 흔히 "ClassLoader 충돌"이라 불리는 문제의 근본 원인입니다. 따라서 격리된 ClassLoader 사이의 통신은 반드시 공통 상위 ClassLoader에 의해 로드된 인터페이스나 추상 클래스를 통해야 합니다.

| 조건 | 클래스 동일 여부 | 결과 |
|---|---|---|
| 같은 FQCN + 같은 ClassLoader | ✓ 동일 | 정상 캐스팅 가능 |
| 같은 FQCN + 다른 ClassLoader | ✗ 다름 | ClassCastException |
| 다른 FQCN + 같은 ClassLoader | ✗ 다름 | 당연히 다름 |
| 인터페이스는 상위 CL에서 로드 | ✓ 공유 가능 | 안전한 격리 경계 |

### 네임스페이스와 클래스 가시성

각 ClassLoader는 고유한 **네임스페이스**를 정의합니다. 자식 ClassLoader는 부모의 네임스페이스를 볼 수 있지만, 부모는 자식의 네임스페이스를 볼 수 없습니다. 이 단방향 가시성은 의도적인 설계 선택입니다.

부모가 자식을 볼 수 없다는 점은 서비스 로케이터 패턴이나 팩토리 메서드 패턴에서 문제가 될 수 있습니다. `javax.xml.parsers.DocumentBuilderFactory`처럼 구현체를 동적으로 찾아야 하는 경우, Bootstrap ClassLoader에서 로드된 코드가 Application ClassLoader에 있는 구현체를 찾지 못하는 상황이 생깁니다. 이를 해결하기 위해 "Thread Context ClassLoader" 개념이 도입됐고, JDBC 드라이버 로딩 같은 SPI 메커니즘이 이를 적극 활용합니다. 가시성 규칙을 모르면 이 SPI 패턴이 왜 동작하는지 이해하기 어렵습니다.

> 부모는 자식을 볼 수 없다. 공유가 필요하면 공통 조상 ClassLoader에 두어야 합니다. 격리 설계의 첫 번째 원칙입니다.

---

## 위임 모델의 동작 방식

### 부모 우선 위임의 흐름

ClassLoader가 클래스 로딩 요청을 받으면 즉시 자신의 스코프에서 클래스를 찾지 않습니다. 먼저 부모 ClassLoader에게 요청을 위임하고, 부모가 실패한 경우에만 자신이 직접 클래스를 찾습니다. 이 "부모 우선 위임(Parent-First Delegation)"은 Java 1.2부터 도입된 핵심 메커니즘입니다.

부모 우선 위임의 가장 중요한 효과는 **핵심 API 보호**입니다. 누군가 `java.lang.String`을 악의적으로 교체하려는 클래스를 만들어도, Bootstrap ClassLoader가 항상 먼저 처리하므로 교체가 불가능합니다. 또한 동일한 클래스는 JVM 내에서 단 한 번만 로드돼 메모리를 절약하고 타입 일관성을 보장합니다. 반대로 클래스 격리를 구현할 때는 이 위임 순서를 역전시켜야 하는 경우가 생기며, 그 방법은 다음 섹션에서 다룹니다.

```diagram
2026-09-21-56d0a588-02
```

부모 위임 실패 시에만 자신이 직접 탐색하는 구조이며, 끝까지 실패하면 `ClassNotFoundException`이 호출부로 전파됩니다.

### loadClass vs findClass의 구분

`ClassLoader`를 상속할 때 `loadClass()`와 `findClass()` 중 무엇을 오버라이드할지 결정은 설계 의도를 정확히 이해해야 합니다. `loadClass()`는 위임 모델 전체를 제어하는 진입점입니다. 이 메서드를 오버라이드하면 부모 위임 자체를 바꿀 수 있습니다. 반면 `findClass()`는 "부모가 실패했을 때 내가 어떻게 클래스를 찾을 것인가"만 담당합니다.

Sun Microsystems의 공식 권장 사항은 일반적인 경우 `findClass()`만 오버라이드하는 것입니다. `loadClass()`를 오버라이드하면 부모 위임이 깨져 앞서 설명한 핵심 API 보호 효과가 사라질 수 있습니다. 반면 클래스 격리를 의도적으로 구현하는 경우, 즉 "자식이 먼저 찾고 부모는 나중에" 방식(Child-First)이 필요할 때는 `loadClass()`를 신중하게 재정의해야 합니다. 이 두 메서드의 역할 차이를 명확히 구분하지 않으면 미묘한 버그가 생길 수 있습니다.

| 메서드 | 역할 | 오버라이드 시 효과 | 권장 여부 |
|---|---|---|---|
| `loadClass()` | 전체 위임 흐름 제어 | 부모 위임 전략 변경 가능 | 격리 구현 시에만 |
| `findClass()` | 실제 바이트코드 탐색 | 탐색 위치·방법만 변경 | 일반적인 경우 권장 |
| `defineClass()` | 바이트코드 → Class 변환 | 바이트코드 변환 삽입 가능 | 거의 오버라이드 안 함 |
| `resolveClass()` | 심볼릭 참조 해결 | 참조 해결 시점 제어 | 거의 오버라이드 안 함 |

### 컨텍스트 ClassLoader의 역할

Java SPI(Service Provider Interface)는 코드와 구현체를 분리하는 대표적인 패턴입니다. `ServiceLoader`, JDBC, JNDI 등이 이를 활용합니다. 그런데 Bootstrap ClassLoader에서 로드된 `ServiceLoader`가 어떻게 Application ClassLoader에 있는 구현체를 발견할 수 있을까요? 바로 **Thread Context ClassLoader** 덕분입니다. `Thread.currentThread().getContextClassLoader()`로 접근하는 이 ClassLoader는 스레드별로 다르게 설정할 수 있으며, 상위 ClassLoader 코드가 하위 클래스를 동적으로 찾아야 할 때 사용합니다.

웹 애플리케이션 서버(Tomcat, JBoss 등)는 각 웹 앱 배포 시마다 Thread Context ClassLoader를 해당 웹 앱의 ClassLoader로 설정해 웹 앱 간 클래스 격리를 달성합니다. 멀티스레드 환경에서 특정 스레드가 다른 ClassLoader 컨텍스트로 작업해야 한다면, 작업 전에 컨텍스트 ClassLoader를 교체하고 작업 후에 복원하는 패턴이 필수입니다. 복원을 빠뜨리면 스레드 풀에서 재사용되는 스레드가 엉뚱한 ClassLoader 컨텍스트로 계속 동작하는 문제가 생깁니다.

> Thread Context ClassLoader는 "부모가 자식을 볼 수 없다"는 계층 제약을 우회하는 합법적인 통로입니다. SPI 메커니즘 전체가 이 우회로 위에 서 있습니다.

---

## 커스텀 ClassLoader 구현

### URLClassLoader를 활용한 기본 격리

Java는 `URLClassLoader`라는 검증된 구현체를 기본 제공합니다. JAR 파일이나 디렉터리를 URL 배열로 지정하면 해당 경로에서 클래스를 로드하는 ClassLoader를 즉시 만들 수 있습니다. 플러그인을 외부 JAR로 패키징하고 런타임에 동적 로드하는 경우 이 방식이 가장 간단합니다. 핵심은 공통 인터페이스를 반드시 상위 ClassLoader(부모)가 로드하게 함으로써, 플러그인 ClassLoader와 호스트 코드가 동일한 타입 정의를 공유하게 만드는 것입니다. 아래 예제는 외부 JAR에서 플러그인 구현체를 로드하고 공통 인터페이스를 통해 안전하게 호출하는 패턴을 보여줍니다.

```java
// Plugin.java — 공통 인터페이스 (App ClassLoader가 로드)
public interface Plugin {
    String execute(String input);
}

// PluginLoader.java — URLClassLoader 기반 플러그인 로더
public class PluginLoader implements AutoCloseable {

    private final URLClassLoader classLoader;

    public PluginLoader(Path jarPath) throws MalformedURLException {
        // 부모를 현재 Thread Context CL로 설정 → Plugin 인터페이스 공유
        this.classLoader = new URLClassLoader(
            new URL[]{jarPath.toUri().toURL()},
            Thread.currentThread().getContextClassLoader()
        );
    }

    public Plugin load(String className) throws Exception {
        // 플러그인 JAR의 ClassLoader로 클래스 로드 후 Plugin으로 캐스팅
        Class<?> clazz = classLoader.loadClass(className);
        return (Plugin) clazz.getDeclaredConstructor().newInstance();
        // 결과: Plugin 인터페이스를 통해 타입 안전하게 호출 가능
    }

    @Override
    public void close() throws IOException {
        classLoader.close(); // 명시적 해제로 Metaspace 누수 방지
    }
}
```

`Plugin` 인터페이스가 부모 ClassLoader(Application CL)에 의해 로드되기 때문에, 플러그인 JAR의 ClassLoader와 메인 코드 모두 동일한 `Plugin` 타입을 공유합니다. `AutoCloseable` 구현은 단순한 형식이 아니라, ClassLoader를 닫아야 로드한 클래스 메타데이터가 GC 대상이 될 수 있기 때문에 필수적입니다.

### Child-First ClassLoader 직접 구현

단순 격리를 넘어, 같은 클래스명을 가진 서로 다른 버전의 클래스를 동시에 사용해야 한다면 부모 우선 위임을 역전시켜야 합니다. Tomcat이 각 웹 앱에 대해 이 Child-First 방식을 사용합니다. `loadClass()`를 오버라이드하되, `java.*`와 `javax.*` 패키지는 반드시 부모에게 강제 위임해야 합니다. 이를 빠뜨리면 `java.lang.Object` 같은 핵심 클래스까지 재로드를 시도해 `SecurityException`이 발생하거나, 같은 JVM에서 두 개의 `Object` 타입이 공존하는 비정상 상태가 될 수 있습니다.

```java
public class ChildFirstClassLoader extends URLClassLoader {

    public ChildFirstClassLoader(URL[] urls, ClassLoader parent) {
        super(urls, parent);
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve)
            throws ClassNotFoundException {

        synchronized (getClassLoadingLock(name)) {
            // 1. 이미 로드된 클래스는 재사용
            Class<?> loaded = findLoadedClass(name);
            if (loaded != null) return loaded;

            // 2. java.* / javax.* 는 반드시 부모 위임 (핵심 API 보호)
            if (name.startsWith("java.") || name.startsWith("javax.")) {
                return super.loadClass(name, resolve);
            }

            // 3. 자신이 먼저 탐색 (Child-First)
            try {
                Class<?> clazz = findClass(name);
                if (resolve) resolveClass(clazz);
                return clazz;
            } catch (ClassNotFoundException e) {
                // 4. 자신에게 없으면 부모에게 위임
                return super.loadClass(name, resolve);
            }
        }
    }
}
```

`getClassLoadingLock()`으로 동기화하는 부분은 병렬 클래스 로딩(JDK 7+ 지원)을 위한 것입니다. 같은 클래스를 두 스레드가 동시에 로드하려 할 때 중복 로딩을 방지합니다.

### defineClass와 바이트코드 변환

`defineClass()`는 바이트 배열을 `Class` 객체로 변환하는 메서드입니다. 이 단계에서 바이트코드를 직접 조작하면 AOP(Aspect-Oriented Programming), 코드 계측(Instrumentation), 버전별 기능 패칭 등을 ClassLoader 수준에서 구현할 수 있습니다. Java Agent나 ASM, Byte Buddy 같은 라이브러리가 내부적으로 이 원리를 사용합니다. 단, 이 단계에서 잘못된 바이트코드를 주입하면 `VerifyError`가 발생하며 로딩 자체가 실패합니다.

```diagram
2026-09-21-56d0a588-03
```

`defineClass()` 단계에서 바이트코드 변환을 삽입하면 AOP나 계측 코드를 ClassLoader 수준에서 주입할 수 있으며, 이 방식이 Java Agent의 기술적 기반입니다.

---

## 클래스 격리 패턴 심화

### 플러그인 아키텍처 설계

실제 플러그인 시스템에서 클래스 격리를 적용할 때 가장 중요한 설계 결정은 **공유 클래스와 격리 클래스의 경계**를 어디에 그을 것인가입니다. 너무 많이 공유하면 격리 효과가 사라지고, 너무 적게 공유하면 플러그인과 호스트 사이의 통신 자체가 불가능해집니다. 일반적으로 채택하는 패턴은 **API 레이어 분리**입니다. 플러그인이 구현해야 할 인터페이스와 값 객체(VO/DTO)는 별도 모듈에 두고, 이 모듈만 상위 ClassLoader가 로드합니다. 플러그인 구현체, 플러그인이 사용하는 서드파티 라이브러리는 모두 해당 플러그인의 격리된 ClassLoader 스코프에 둡니다.

이렇게 하면 플러그인 A가 `jackson-databind:2.14`를 쓰고 플러그인 B가 `jackson-databind:2.15`를 써도, 두 버전이 충돌 없이 공존합니다. 각 버전의 클래스는 FQCN이 같더라도 서로 다른 ClassLoader에 의해 로드됐으므로 JVM이 다른 타입으로 취급합니다.

```diagram
2026-09-21-56d0a588-04
```

App ClassLoader가 공유 API를 담당하고, 각 플러그인은 독립된 ClassLoader 아래에서 서로 다른 버전의 라이브러리를 격리합니다.

### 격리 범위 결정 전략

클래스 격리의 범위를 결정할 때 세 가지 전략을 고려할 수 있습니다. 첫 번째는 **JAR 단위 격리**로, 각 JAR 파일마다 별도 ClassLoader를 할당합니다. 가장 세밀한 격리지만 ClassLoader 수가 폭발적으로 늘어 관리 비용과 메모리 오버헤드가 커집니다. 두 번째는 **플러그인 단위 격리**로, 플러그인(기능 단위)별로 ClassLoader를 만들고 해당 플러그인의 모든 의존성을 포함합니다. 가장 널리 쓰이는 균형 잡힌 방식입니다. 세 번째는 **버전 그룹 격리**로, 동일한 버전의 라이브러리를 사용하는 플러그인들이 ClassLoader를 공유합니다. 메모리 효율이 높지만 하나의 버전 업그레이드가 공유 그룹 전체에 영향을 미칩니다. 어떤 전략이 적합한지는 플러그인 수, 의존성 충돌 빈도, 메모리 예산을 함께 고려해 결정해야 합니다.

| 전략 | ClassLoader 수 | 메모리 효율 | 격리 강도 | 언제 쓰나 |
|---|---|---|---|---|
| JAR 단위 | 많음 | 낮음 | 최강 | 보안이 최우선인 환경 |
| 플러그인 단위 | 중간 | 중간 | 강 | 일반적인 플러그인 시스템 |
| 버전 그룹 | 적음 | 높음 | 중간 | 충돌 드물고 플러그인 많을 때 |

### 직렬화와 격리된 클래스

클래스 격리 환경에서 Java 직렬화를 사용하면 예상치 못한 문제가 생길 수 있습니다. 직렬화된 객체를 역직렬화할 때 JVM은 해당 클래스를 찾아야 하는데, 격리된 ClassLoader의 클래스는 기본 역직렬화 경로에서 보이지 않습니다. 이 문제를 해결하려면 `ObjectInputStream`을 상속하고 `resolveClass()` 메서드를 오버라이드해 올바른 ClassLoader를 참조하도록 해야 합니다. 구현이 번거롭고 오류 발생 가능성도 높습니다.

더 현실적인 해결책은 직렬화 프레임워크를 교체하는 것입니다. JSON(Jackson, Gson), Protocol Buffers, MessagePack 등 ClassLoader 비의존적인 직렬화 방식은 격리 경계를 넘을 때 데이터를 전송하기 훨씬 안전합니다. 이 경우 격리 경계에서의 통신은 순수한 데이터 전송이 되고, 타입 정보는 공유 API 레이어의 인터페이스로만 교환합니다. 클래스 격리 환경을 설계할 때부터 경계를 넘는 통신에 Java 직렬화를 사용하지 않는 것이 예방 차원에서 중요합니다.

> 격리 경계를 넘는 통신은 "데이터"로만 하고, "타입"은 공유 API 레이어에서만 교환해야 합니다. 이 원칙 하나가 대부분의 ClassCastException을 예방합니다.

---

## 성능과 트레이드오프

### ClassLoader가 메모리에 미치는 영향

ClassLoader를 무분별하게 생성하면 **Metaspace 고갈**로 이어질 수 있습니다. JDK 8 이전에는 PermGen이 이 역할을 했고, 수많은 `OutOfMemoryError: PermGen space` 장애의 원인이었습니다. JDK 8 이후 Metaspace로 바뀌면서 기본값이 동적 확장되지만, 무한정 늘어나지는 않으며 `-XX:MaxMetaspaceSize`로 상한을 설정하면 동일한 문제가 재현됩니다. 각 ClassLoader가 로드한 클래스의 메타데이터(메서드 테이블, 상수 풀, 바이트코드 등)는 Metaspace에 올라갑니다. ClassLoader 인스턴스가 GC되지 않으면 해당 ClassLoader가 로드한 클래스들도 Metaspace에서 해제되지 않습니다.

```diagram
2026-09-21-56d0a588-05
```

ClassLoader에 대한 강한 참조가 남아 있으면 GC가 불가하고, Metaspace의 클래스 메타데이터도 함께 유지돼 누수로 이어집니다.

### 클래스 로딩 비용과 캐싱

클래스 로딩은 결코 가볍지 않습니다. JAR 파일 탐색, 바이트코드 읽기, 검증(Verification), 준비(Preparation), 해결(Resolution), 초기화(Initialization) 단계를 거치는 전체 과정은 수십 밀리초가 걸릴 수 있습니다. 대규모 플러그인 시스템에서 플러그인을 자주 언로드·재로드하는 패턴은 이 비용이 누적돼 애플리케이션 반응 시간에 영향을 줄 수 있습니다.

`findLoadedClass()`를 통해 이미 로드된 클래스는 재로드를 건너뛸 수 있습니다. ClassLoader 자체가 내부적으로 캐시를 유지하기 때문에, 동일한 ClassLoader 인스턴스로 같은 클래스를 여러 번 요청해도 처음 한 번만 전체 로딩 과정을 거칩니다. 이 특성을 이용하면 자주 사용하는 클래스는 수명이 긴 ClassLoader가 담당하게 하고, 일회성 사용 클래스는 별도 ClassLoader에서 처리 후 즉시 해제하는 방식으로 성능과 격리를 동시에 추구할 수 있습니다.

| 클래스 로딩 단계 | 주요 작업 | 비용 |
|---|---|---|
| Loading | JAR 탐색, 바이트코드 읽기 | I/O 비용 발생 |
| Verification | 바이트코드 유효성 검사 | CPU 집중 |
| Preparation | 정적 필드 메모리 할당 | 메모리 할당 |
| Resolution | 심볼릭 참조 → 직접 참조 | 지연 또는 즉시 |
| Initialization | 정적 초기화 블록 실행 | 코드 실행 비용 |

### OSGi, Jigsaw, URLClassLoader 비교

클래스 격리를 달성하는 방법은 커스텀 ClassLoader 외에도 여럿 있습니다. OSGi는 번들(Bundle)마다 ClassLoader를 부여하고 Export/Import 선언을 통해 패키지 공유를 관리합니다. 매우 정교한 격리가 가능하지만 학습 비용과 런타임 복잡성이 높습니다. JDK 9의 모듈 시스템(Jigsaw)은 컴파일 타임 격리를 강화하지만, ClassLoader 수준의 런타임 격리는 OSGi나 커스텀 ClassLoader만큼 유연하지 않습니다. `URLClassLoader`는 설정이 가장 단순하고 JDK 기본 제공이라는 장점이 있으며, 정교한 격리보다 빠른 구현이 필요할 때 적합합니다. 세 방식 모두 트레이드오프가 있으므로 요구사항의 복잡도에 맞게 선택해야 합니다.

| 방식 | 런타임 격리 | 버전 충돌 해결 | 설정 복잡도 | 언제 쓰나 |
|---|---|---|---|---|
| URLClassLoader | 강 | 가능 | 낮음 | 빠른 구현, 단순 격리 |
| 커스텀 ClassLoader | 최강 | 완전 제어 | 높음 | 정교한 격리 요구 시 |
| OSGi | 강 | Export/Import | 매우 높음 | 대규모 모듈 시스템 |
| Jigsaw 모듈 | 중간 | 제한적 | 중간 | 컴파일 타임 경계가 충분할 때 |

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

ClassLoader 관련 문제 중 가장 자주 발생하는 것은 **ClassLoader 누수**입니다. 웹 애플리케이션 서버에서 웹 앱을 재배포할 때마다 새로운 ClassLoader가 생성되는데, 이전 ClassLoader에 대한 참조가 어딘가에 남아 있으면 GC가 불가하고 Metaspace가 조금씩 소모됩니다. ThreadLocal에 저장된 객체, 정적 필드(static field)에 캐시된 인스턴스, 스레드 풀에서 실행 중인 `Runnable`이나 `Callable` 등이 구 ClassLoader에 대한 참조를 암묵적으로 보유하는 주요 경로입니다. 두 번째 함정은 **로깅 프레임워크 충돌**입니다. SLF4J 같은 로깅 라이브러리는 ClassLoader 바인딩 방식으로 동작하기 때문에, 플러그인이 독립된 ClassLoader를 갖더라도 로깅 설정을 공유하지 않으면 로그가 출력되지 않거나 설정이 중복 적용될 수 있습니다. 해결책은 로깅 API(SLF4J API)를 공유 ClassLoader에 두고, 구현체(Logback)는 호스트 애플리케이션의 ClassLoader에서만 로드하는 것입니다.

```diagram
2026-09-21-56d0a588-06
```

스레드 풀과 정적 필드에 남은 구 ClassLoader 참조가 Metaspace 누수의 주요 진입 경로입니다.

### 모니터링과 디버깅

운영 환경에서 ClassLoader 관련 문제를 진단하는 첫 번째 수단은 JVM 플래그입니다. `-verbose:class` 또는 `-Xlog:class+load=info`를 사용하면 각 클래스가 어느 ClassLoader에 의해 로드됐는지 출력됩니다. 클래스 충돌이나 의도치 않은 로딩 경로 문제를 추적할 때 유용합니다.

**Metaspace 사용량 모니터링**은 ClassLoader 누수를 조기에 발견하는 핵심 지표입니다. JMX를 통해 `java.lang:type=MemoryPool,name=Metaspace`의 `Usage.used` 값을 정기적으로 수집하면, 재배포 이후 Metaspace가 감소하지 않는 패턴을 감지할 수 있습니다. 재배포가 반복될수록 Metaspace가 단계적으로 증가한다면 ClassLoader 누수를 강하게 의심해야 합니다.

| 진단 수단 | 무엇을 알 수 있는가 | 적합한 상황 |
|---|---|---|
| `-verbose:class` | 클래스별 로딩 ClassLoader | 예상 밖 로딩 경로 추적 |
| JMX Metaspace 지표 | Metaspace 사용량 추세 | 누수 조기 발견 |
| Eclipse MAT (힙 덤프) | ClassLoader별 보유 메모리 | 누수 ClassLoader 특정 |
| `Class.getClassLoader()` | 특정 클래스의 로더 확인 | ClassCastException 원인 분석 |

힙 덤프를 통한 ClassLoader 분석도 중요합니다. Eclipse Memory Analyzer(MAT)의 "ClassLoader Explorer" 기능을 사용하면 각 ClassLoader가 로드한 클래스 수와 점유 메모리를 시각적으로 확인할 수 있습니다. "retain heap" 기준으로 정렬하면 어느 ClassLoader가 메모리를 과도하게 잡고 있는지 즉시 파악됩니다.

### 확장과 마이그레이션

기존 단일 ClassLoader 구조를 다중 ClassLoader 아키텍처로 마이그레이션할 때는 점진적 전환이 중요합니다. 모든 컴포넌트를 한 번에 격리하려다 보면 `ClassCastException`, `NoClassDefFoundError` 등의 문제가 한꺼번에 쏟아지면서 디버깅이 매우 어려워집니다. 대신 가장 독립적인 컴포넌트부터 격리하고, 격리 경계에서의 인터페이스 계약을 명확히 정의한 뒤, 나머지를 순차적으로 마이그레이션하는 방식을 권장합니다.

JDK 버전별로 ClassLoader 동작에 미묘한 차이도 있습니다. JDK 9 이후 `URLClassLoader`의 `close()` 메서드가 더 엄격하게 동작하고, Bootstrap ClassLoader를 참조할 때 `null` 대신 플랫폼 ClassLoader 참조가 반환되는 부분 등이 마이그레이션 시 예상치 못한 동작을 유발할 수 있습니다. JDK 17이나 JDK 21로 업그레이드할 때 ClassLoader 관련 코드를 반드시 재검토해야 하는 이유입니다.

```diagram
2026-09-21-56d0a588-07
```

점진적 마이그레이션은 독립 컴포넌트 식별 → 격리 적용 → 인터페이스 검증의 순환으로 진행하며, 한 번에 전체를 바꾸려는 시도는 예상치 못한 충돌을 일으킵니다.

---

## 맺음말

### 핵심 요약

Java ClassLoader는 단순한 클래스 로딩 도구를 넘어 JVM 런타임의 격리와 동적 확장성을 책임지는 핵심 인프라입니다. Bootstrap → Platform → Application의 계층과 부모 우선 위임 모델은 핵심 API의 무결성을 보호하면서 사용자 정의 ClassLoader가 개입할 수 있는 공간을 설계합니다. `URLClassLoader`는 빠른 구현을 위한 실용적인 선택이고, `loadClass()`를 재정의한 Child-First ClassLoader는 라이브러리 버전 격리가 필요한 더 정교한 요구사항을 해결합니다. 격리된 ClassLoader 사이의 통신은 반드시 공유 상위 ClassLoader에서 로드한 인터페이스로만 이뤄져야 타입 안전성이 보장됩니다. Metaspace 누수와 ClassLoader 참조 관리는 이 구조를 운영 환경에서 안정적으로 유지하기 위한 필수 항목입니다.

> 클래스 격리의 본질은 "같은 이름의 클래스를 다른 타입으로 취급하는 것"입니다. 이 한 문장이 설계의 모든 결정을 이끕니다.

### 적용 판단 기준

커스텀 ClassLoader와 클래스 격리가 실제 필요한 상황은 다음 기준으로 판단할 수 있습니다. 첫째, **동일 JVM에서 같은 라이브러리의 다른 버전을 동시에 사용해야 하는가**. 단순한 의존성 정렬로 해결되지 않는다면 ClassLoader 격리가 유일한 실용적 해법입니다. 둘째, **런타임에 코드를 동적으로 로드·언로드해야 하는가**. 플러그인 시스템, 핫 배포, 멀티테넌트 환경이 여기에 해당합니다. 셋째, **신뢰할 수 없는 코드를 격리해서 실행해야 하는가**. ClassLoader 격리로 호스트 애플리케이션에 미치는 영향을 제한할 수 있습니다. 반면, 단순한 의존성 분리나 빌드 타임 모듈화가 목표라면 Jigsaw 모듈이나 빌드 도구 수준의 솔루션이 더 적합합니다. ClassLoader 직접 제어는 강력하지만 Metaspace 관리, `ClassCastException`, 누수 위험 등 복잡성이 따라오기 때문에, 도입 전에 이 복잡성을 감당할 만큼 요구사항이 명확한지 먼저 검토하는 것이 현명합니다.

| 상황 | 권장 접근법 |
|---|---|
| 라이브러리 버전 동시 운용 필요 | Child-First ClassLoader 또는 URLClassLoader |
| 런타임 플러그인 로드·언로드 | URLClassLoader + AutoCloseable 패턴 |
| 대규모 모듈 시스템 구축 | OSGi 또는 커스텀 ClassLoader |
| 컴파일 타임 경계 강화 | Jigsaw 모듈 |
| 단순 의존성 분리 | 빌드 도구(Maven/Gradle) 수준으로 충분 |
