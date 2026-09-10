---
title: "멱등성 API 설계 — Idempotency Key로 중복 요청 안전하게 처리하기"
date: "2026-09-11"
category: "Architecture"
tags: ["멱등성 API 설계 — Idempotency Key로 분산 시스템 중복 요청 안전하게 처리하기", "Architecture", "API", "Idempotency", "Key"]
excerpt: "분산 시스템에서 네트워크 장애나 타임아웃으로 인해 동일한 요청이 중복 처리되는 문제를 멱등성(Idempotency) API 설계로 안전하게 해결할 수 있습니다."
---

## 목차

1. 개요
2. 멱등성의 원리와 분산 시스템에서의 필요성
3. Idempotency Key 설계 원칙
4. 서버 사이드 구현 전략
5. 성능과 트레이드오프 분석
6. 운영 환경에서의 고려사항
7. 맺음말

---

## 개요

### 문제 배경

분산 시스템에서 네트워크 장애나 타임아웃으로 인해 동일한 요청이 중복 처리되는 문제를 **멱등성(Idempotency) API 설계**로 안전하게 해결할 수 있습니다. Idempotency Key는 클라이언트가 요청마다 고유 식별자를 첨부해, 서버가 동일한 키를 가진 재시도 요청을 단 한 번만 처리하도록 보장하는 패턴입니다. 결제, 주문, 송금처럼 부작용이 큰 연산에서 중복 실행은 치명적인 비즈니스 손실로 이어지기 때문에, 이 패턴은 현업 금융 시스템과 대규모 마이크로서비스 아키텍처에서 핵심 설계 원칙으로 자리 잡았습니다. 이 글에서는 멱등성의 이론적 배경부터 실제 구현 코드, 운영 환경에서 마주치는 함정까지 체계적으로 다룹니다.

### 기존 방식의 한계

중복 요청을 막기 위한 가장 단순한 접근법은 클라이언트 측 재시도 억제입니다. 즉, 첫 번째 요청이 성공하거나 명확한 실패를 반환할 때까지 재시도를 하지 않는 전략입니다. 그러나 분산 환경에서 "명확한 실패"를 구분하기란 생각보다 훨씬 어렵습니다. 서버가 요청을 처리하고 응답을 보냈지만 네트워크 단절로 클라이언트가 받지 못한 상황에서, 클라이언트는 요청이 실패했다고 판단합니다. 이 경우 재시도를 억제하면 처리된 요청의 결과를 영원히 알 수 없고, 재시도를 허용하면 중복 처리가 발생하는 딜레마에 빠집니다.

데이터베이스 유니크 제약을 이용한 중복 방지도 자주 시도되지만, 이 방식은 도메인 식별자(예: 주문 번호)가 사전에 생성되어 있어야 하고, 여러 서비스에 걸친 분산 트랜잭션 상황에서는 일관성을 보장하기 어렵습니다. Idempotency Key 패턴은 이 두 가지 한계를 모두 극복하는 범용적인 해법을 제시합니다.

---

## 멱등성의 원리와 분산 시스템에서의 필요성

### 멱등성이란 무엇인가

수학에서 멱등성(冪等性, Idempotency)은 f(f(x)) = f(x)가 성립하는 성질을 뜻합니다. 소프트웨어 공학에서는 동일한 연산을 여러 번 수행해도 결과가 달라지지 않는 성질을 의미합니다. HTTP 명세(RFC 7231)는 GET, HEAD, PUT, DELETE를 멱등 메서드로 정의합니다. `PUT /users/123 { "name": "홍길동" }`을 다섯 번 호출해도 최종 상태는 동일하다는 보장이 있습니다. 반면 POST는 비멱등(non-idempotent)으로 분류됩니다. `POST /orders`를 다섯 번 호출하면 다섯 개의 주문이 생성될 수 있습니다.

현업에서 "상태 변화를 만드는 연산"은 대부분 POST로 구현됩니다. 결제 요청, 송금, 구독 등록, 쿠폰 발급 같은 작업은 단 한 번만 실행되어야 하지만 POST로 표현되는 경우가 많습니다. 그렇다고 이를 모두 PUT으로 바꾸는 것은 RESTful 설계와 충돌할 수 있습니다. 이 불일치를 해소하기 위해 등장한 것이 Idempotency Key 패턴입니다.

중요한 개념 하나를 먼저 구분해 두겠습니다. **멱등성**은 동일 결과를 보장하는 성질이고, **안전성(safety)**은 서버 상태를 변경하지 않는 성질입니다. GET은 안전하면서 멱등하지만, DELETE는 멱등하되 안전하지 않습니다. Idempotency Key가 추구하는 것은 안전성이 아닌 멱등성입니다. 즉, 연산은 일어나지만 중복으로 일어나지 않도록 보장하는 것입니다.

| HTTP 메서드 | 안전성 | 멱등성 | 비고 |
|---|---|---|---|
| GET / HEAD | ✓ | ✓ | 조회 전용 |
| PUT | ✗ | ✓ | 전체 덮어쓰기 |
| DELETE | ✗ | ✓ | 두 번째 호출도 동일 결과 |
| POST | ✗ | ✗ | Idempotency Key 필요 구간 |
| PATCH | ✗ | 조건부 | 절대 증가 연산 시 비멱등 |

### 분산 시스템에서의 장애 패턴

분산 시스템이 중복 요청을 유발하는 시나리오는 크게 세 가지로 나눌 수 있습니다.

```
클라이언트 → [네트워크] → 서버 → [DB/외부 API]

1. 요청 손실:  ──X──>               (서버 미도달, 재시도 안전)
2. 응답 손실:  ─────────> [처리 완료]
              <──X──               (클라이언트가 성공 인식 못함)
3. 처리 지연:  ─────────>  [처리 중]
              <─timeout─           (클라이언트가 실패로 판단)
```

첫 번째 시나리오(요청 손실)는 비교적 단순합니다. 서버에 요청이 도달하지 않았으므로 재시도해도 중복이 발생하지 않습니다. 그러나 클라이언트는 이 상황인지 두 번째 시나리오인지 구분할 수 없습니다. 두 번째 시나리오(응답 손실)가 더 위험합니다. 서버는 이미 주문을 생성하고 결제를 완료했는데, 클라이언트는 응답을 받지 못해 "실패"로 판단하고 재시도합니다. 세 번째 시나리오(처리 지연)는 외부 결제 게이트웨이를 호출하는 경우에 자주 나타납니다. 처리가 진행 중임에도 불구하고 클라이언트 측 타임아웃이 먼저 발생하는 상황입니다. 이 세 가지 시나리오 모두에서, 클라이언트가 재시도할 때 서버가 동일 요청임을 인식하지 못하면 중복 처리가 발생합니다.

### At-Least-Once vs Exactly-Once 전달 보장

분산 메시징 시스템은 전달 보장 수준을 At-Least-Once, At-Most-Once, Exactly-Once 세 가지로 분류합니다. 이 개념은 HTTP API에도 동일하게 적용됩니다.

| 전달 보장 | 중복 가능성 | 손실 가능성 | 구현 복잡도 | 적합한 상황 |
|---|---|---|---|---|
| At-Most-Once | 없음 | 있음 | 낮음 | 로그 수집, 분석 이벤트 |
| At-Least-Once | 있음 | 없음 | 중간 | 멱등 연산, 조회성 작업 |
| Exactly-Once | 없음 | 없음 | 높음 | 결제, 송금, 재고 차감 |

HTTP 재시도 로직을 가진 대부분의 클라이언트는 At-Least-Once 전달을 구현합니다. Idempotency Key는 이 At-Least-Once 클라이언트 행동을 Exactly-Once 처리 의미론으로 격상시키는 서버 측 메커니즘입니다. 이 차이를 이해하면, Idempotency Key가 단순한 중복 방지 기능이 아니라 분산 시스템 신뢰성의 핵심 계층임을 알 수 있습니다. Kafka나 RabbitMQ 같은 메시지 브로커가 중복 제거(deduplication) 기능을 별도로 제공하는 이유도 같은 맥락입니다.

---

## Idempotency Key 설계 원칙

### 키 생성과 소유권

Idempotency Key의 첫 번째 원칙은 **클라이언트가 생성**한다는 것입니다. 서버가 키를 생성하면 의미가 없습니다. 키는 클라이언트가 "이 요청은 내가 이전에 보낸 것과 동일한 비즈니스 의도를 가진다"는 선언이기 때문입니다. 키 생성 방식으로 UUID v4가 가장 널리 사용됩니다. UUID v4는 122비트 랜덤성을 가져 충돌 확률이 극도로 낮고, 생성 비용이 저렴하며, 언어별 표준 라이브러리가 지원합니다.

키의 범위(scope)도 중요합니다. Stripe의 구현에서는 API 키(계정) + Idempotency Key 조합으로 고유성을 보장합니다. 즉, 서로 다른 계정이 동일한 Idempotency Key 문자열을 사용해도 독립적으로 처리됩니다. 이 설계는 클라이언트가 전역적으로 유일한 키를 생성할 의무를 없애고, 자신의 세션 내에서만 유일성을 보장하면 된다는 편의를 제공합니다. 멀티테넌트 SaaS 환경에서도 동일한 원칙이 적용됩니다.

키의 만료 정책 역시 설계 단계에서 결정해야 합니다. Stripe는 24시간, Braintree는 14일의 키 유효기간을 적용합니다. 유효기간이 없으면 키 저장소가 무한히 커지고, 너무 짧으면 네트워크 장애가 유효기간을 넘어 지속될 때 보호 효과가 사라집니다. 일반적으로 비즈니스 컨텍스트와 재시도 정책의 최대 구간을 고려해 결정합니다. 결제처럼 사용자가 직접 개입하는 흐름은 24시간이면 충분하지만, 배치 처리나 비동기 워크플로우는 더 긴 기간이 필요할 수 있습니다.

> 키는 "이 요청"이 아니라 "이 비즈니스 의도"를 식별합니다. 같은 의도라면 언제나 같은 키를 사용해야 합니다.

### 요청 페이로드와 키의 관계

Idempotency Key를 사용할 때 중요한 설계 결정이 있습니다. 동일한 키로 **다른 페이로드**가 들어오면 어떻게 처리할 것인가입니다. Stripe는 이 경우 422 Unprocessable Entity를 반환합니다. 동일한 키는 동일한 요청을 의미해야 하는데, 다른 페이로드가 들어오면 클라이언트 측 버그이거나 의도적인 공격일 가능성이 높기 때문입니다.

| 상황 | 권장 처리 | HTTP 상태 코드 | 이유 |
|---|---|---|---|
| 동일 키, 동일 페이로드 (최초) | 정상 처리 | 200/201 | 신규 요청 |
| 동일 키, 동일 페이로드 (재시도) | 캐시 반환 | 200/201 | 멱등성 보장 |
| 동일 키, 다른 페이로드 | 오류 반환 | 422 | 클라이언트 오류 |
| 처리 중인 키 (진행 중) | 진행 중 반환 | 409 Conflict | 동시 재시도 방지 |
| 만료된 키 | 명시적 오류 | 422 | 의도치 않은 재사용 방지 |

페이로드 비교를 위해서는 요청 본문의 해시값을 키와 함께 저장하는 방식이 흔히 사용됩니다. 단, 해시 계산 시 순서 무관 필드(JSON 오브젝트의 키 순서)나 타임스탬프처럼 매번 달라지는 필드를 정규화한 뒤 비교해야 합니다. 그렇지 않으면 사실상 동일한 요청을 "다른 페이로드"로 잘못 판단하는 오탐이 발생할 수 있습니다.

### HTTP 헤더로 키 전달하기

Idempotency Key를 전달하는 위치로는 HTTP 헤더가 사실상의 표준입니다. `Idempotency-Key` 헤더는 IETF의 HTTP API 작업 그룹에서 논의 중이며, Stripe, PayPal, Adyen 등 주요 결제 API가 이 헤더 이름을 채택합니다. URL 쿼리 파라미터나 요청 본문에 포함하는 방식도 가능하지만, 헤더 방식이 페이로드와 제어 정보를 분리한다는 REST 원칙에 더 부합합니다.

헤더 이름의 대소문자 처리도 신경 써야 합니다. HTTP/1.1에서는 대소문자를 구분하지 않지만, HTTP/2에서는 소문자를 권장합니다. 따라서 서버 측 구현에서는 헤더 이름을 소문자로 정규화한 뒤 처리하는 것이 안전합니다. 헤더 값의 길이 제한도 명시해야 합니다. 일부 프록시나 API 게이트웨이는 긴 헤더 값을 잘라내거나 거부할 수 있으므로, 커스텀 형식을 사용한다면 255자 이하를 권장합니다. UUID v4의 표준 문자열 표현(36자)은 이 기준에 충분히 부합합니다.

---

## 서버 사이드 구현 전략

### 저장소 선택과 원자적 처리

멱등성 구현의 핵심은 "키 확인 → 처리 → 결과 저장"을 **원자적(atomic)**으로 수행하는 것입니다. 이 세 단계 사이에 틈이 생기면 TOCTOU(Time Of Check To Time Of Use) 경쟁 조건이 발생합니다. 두 개의 동시 재시도 요청이 모두 "키가 없다"고 확인하고, 모두 처리를 진행하는 상황입니다. Redis는 이 문제에 이상적인 솔루션을 제공합니다. `SET key value NX EX seconds` 명령은 키가 존재하지 않을 때만 원자적으로 값을 설정합니다. 이를 이용해 최초 요청 시 "처리 중" 상태를 원자적으로 선점할 수 있습니다.

아래 코드는 Spring Boot와 Redis를 활용한 멱등성 필터의 핵심 구현입니다. 요청이 들어오면 Redis에 NX 방식으로 키를 선점하고, 이미 처리된 요청이면 저장된 응답을 즉시 반환합니다.

```java
@Component
@RequiredArgsConstructor
public class IdempotencyFilter extends OncePerRequestFilter {

    private final RedisTemplate<String, IdempotencyRecord> redisTemplate;
    private static final Duration KEY_TTL = Duration.ofHours(24);
    private static final Duration PROCESSING_TTL = Duration.ofSeconds(30); // 장애 시 자동 해제

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws IOException, ServletException {

        String idempotencyKey = request.getHeader("Idempotency-Key");

        // 헤더 없으면 멱등성 처리 없이 통과
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            filterChain.doFilter(request, response);
            return;
        }

        String redisKey = buildRedisKey(request, idempotencyKey);
        IdempotencyRecord existing = redisTemplate.opsForValue().get(redisKey);

        if (existing != null) {
            if (existing.isProcessing()) {
                // 처리 중인 동시 요청 → 409 반환
                response.setStatus(HttpServletResponse.SC_CONFLICT);
                response.getWriter().write("{\"error\":\"Request is being processed\"}");
                return;
            }
            // 이미 완료된 요청 → 캐시된 응답 반환 (비즈니스 로직 건너뜀)
            response.setStatus(existing.getStatusCode());
            response.setContentType(existing.getContentType());
            response.getWriter().write(existing.getBody());
            return; // 결과: 3~5ms, 서버 부하 없음
        }

        // NX 방식으로 "처리 중" 상태 선점 (원자적 연산)
        Boolean acquired = redisTemplate.opsForValue()
            .setIfAbsent(redisKey, IdempotencyRecord.processing(), PROCESSING_TTL);

        if (Boolean.FALSE.equals(acquired)) {
            // 경쟁 조건: 다른 요청이 먼저 선점 → 409 반환
            response.setStatus(HttpServletResponse.SC_CONFLICT);
            return;
        }

        // 실제 요청 처리 (응답 본문 캡처)
        ContentCachingResponseWrapper wrappedResponse =
            new ContentCachingResponseWrapper(response);
        try {
            filterChain.doFilter(request, wrappedResponse);
            // 처리 완료 → 최종 상태로 갱신 (TTL도 24시간으로 연장)
            IdempotencyRecord completed = IdempotencyRecord.completed(
                wrappedResponse.getStatus(),
                wrappedResponse.getContentType(),
                new String(wrappedResponse.getContentAsByteArray())
            );
            redisTemplate.opsForValue().set(redisKey, completed, KEY_TTL);
        } catch (Exception e) {
            // 예외 시 PROCESSING 레코드 삭제 (30초 TTL이 자동 해제 보장)
            redisTemplate.delete(redisKey);
            throw e;
        } finally {
            wrappedResponse.copyBodyToResponse();
        }
    }

    private String buildRedisKey(HttpServletRequest request, String key) {
        String apiKey = request.getHeader("X-API-Key");
        return String.format("idempotency:%s:%s", apiKey, key); // 계정 범위 적용
    }
}
```

이 구현에서 핵심 포인트는 세 가지입니다. 첫째, `setIfAbsent`(NX 명령)으로 선점 단계를 원자적으로 처리해 경쟁 조건을 원천 차단합니다. 둘째, PROCESSING 상태에 30초 TTL을 설정해 서버 장애 시 자동 해제를 보장합니다. 셋째, `ContentCachingResponseWrapper`를 사용해 실제 서비스 레이어의 응답 본문을 캡처하여 Redis에 저장하므로, 비즈니스 로직을 전혀 수정하지 않고 필터 레이어에서 멱등성을 투명하게 구현합니다.

### 데이터베이스 기반 구현

Redis를 도입하기 어려운 환경이거나 감사 추적(Audit Trail)이 필요한 경우에는 RDBMS로 멱등성 테이블을 구성합니다. 핵심은 `idempotency_key` 컬럼에 UNIQUE 제약을 걸고, `INSERT ... ON CONFLICT DO NOTHING`(PostgreSQL)을 활용해 원자적으로 선점하는 것입니다.

```sql
-- 멱등성 레코드 테이블 (PostgreSQL)
CREATE TABLE idempotency_records (
    id              BIGSERIAL      PRIMARY KEY,
    idempotency_key VARCHAR(255)   NOT NULL,
    api_key         VARCHAR(255)   NOT NULL,
    status          VARCHAR(20)    NOT NULL DEFAULT 'PROCESSING',
    request_hash    VARCHAR(64),                      -- SHA-256 of normalized body
    response_status INT,
    response_body   TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ    NOT NULL,
    UNIQUE (api_key, idempotency_key)                -- 계정 범위 고유성 보장
);

-- 만료된 레코드 정리용 인덱스 (배치 또는 pg_cron 활용)
CREATE INDEX idx_idempotency_expires ON idempotency_records (expires_at)
    WHERE status = 'COMPLETED';
```

| 구현 방식 | 내구성 | 처리 성능 | 복잡도 | 적합한 상황 |
|---|---|---|---|---|
| Redis (메모리) | 설정에 따라 다름 | 매우 높음 (~1ms) | 낮음 | 고트래픽, 짧은 TTL |
| Redis + DB 이중화 | 높음 | 높음 | 중간 | 금융 수준 신뢰성 |
| RDBMS 단독 | 높음 | 중간 (5~20ms) | 낮음 | 감사 추적 필요 |
| 분산 락 (etcd 등) | 높음 | 낮음 | 높음 | 복잡한 분산 워크플로우 |

Redis 방식은 처리 속도가 빠르지만 장애 시 재시작 후 PROCESSING 상태로 남은 레코드에 대한 별도 정책이 필요합니다. RDBMS 방식은 구현이 단순하고 감사 추적에 유리하지만, 고트래픽 환경에서 `idempotency_records` 테이블이 핫스팟이 될 수 있으므로 파티셔닝을 고려해야 합니다.

### 비동기 처리와 멱등성

동기 HTTP 응답이 아닌 비동기 작업(예: 이메일 발송, 외부 API 호출)을 포함하는 요청에서는 멱등성 보장이 더 복잡합니다. 요청을 수신하고 202 Accepted를 반환한 뒤 백그라운드에서 처리하는 패턴에서는, 최초 요청 시 작업 ID를 Idempotency Key와 함께 저장하고, 재시도 시 동일한 작업 ID를 반환해야 합니다.

```
최초 요청  ──> 작업 생성(ID: job-abc) ──> 202 Accepted { "jobId": "job-abc" }
재시도 요청 ──> 키 확인 ──────────────> 202 Accepted { "jobId": "job-abc" }
폴링 요청   ──> GET /jobs/job-abc ───> 200 { "status": "completed", "result": {...} }
```

이 흐름에서 Idempotency Key의 역할은 클라이언트가 항상 동일한 jobId를 받도록 보장하는 것입니다. 작업이 이미 완료된 상태라면 완료된 결과를 직접 반환할 수도 있습니다. 중요한 점은 비동기 작업 자체에도 멱등성이 필요하다는 것입니다. 작업 큐(예: Kafka, RabbitMQ)로 전달되는 메시지에 동일한 jobId를 포함시켜, 워커(Worker)가 중복 처리를 방지하도록 설계해야 합니다.

---

## 성능과 트레이드오프 분석

### 레이턴시 오버헤드 측정

Idempotency Key 처리는 모든 요청에 추가 I/O를 발생시킵니다. Redis 조회는 일반적으로 1ms 미만이지만, 네트워크 홉과 직렬화 비용을 포함하면 2~5ms 수준이 현실적입니다. RDBMS 조회는 인덱스가 최적화되어 있어도 5~20ms 범위를 기대해야 합니다.

```
변경전 (멱등성 없음):
클라이언트 ─[1ms 네트워크]─> 서버 ─[50ms 비즈니스 로직]─> 응답 (총 ~52ms)

변경후 (Redis 멱등성):
클라이언트 ─[1ms 네트워크]─> 서버 ─[3ms Redis 조회]
                                    ─[50ms 비즈니스 로직]
                                    ─[3ms Redis 저장]─> 응답 (총 ~57ms, +10%)

캐시 히트 (재시도 요청):
클라이언트 ─[1ms 네트워크]─> 서버 ─[3ms Redis 조회]─> 응답 (총 ~4ms, -92%)
```

총 레이턴시 증가는 약 5~10% 수준으로, 결제나 주문처럼 데이터 정합성이 중요한 API에서는 충분히 수용 가능한 트레이드오프입니다. 반면 수십 ms 내에 응답해야 하는 실시간 추천 API나 검색 API에는 적합하지 않습니다. 캐시 히트(재시도 요청) 상황에서는 오히려 성능이 크게 향상됩니다. 대규모 장애 복구 시 다수의 재시도 요청이 동시에 몰리는 상황에서 서버 부하를 크게 낮추는 효과도 있습니다.

### 대안 접근법과의 비교

결제나 주문 중복을 막기 위해 흔히 시도되는 접근법을 Idempotency Key 패턴과 나란히 비교하면, 각 방식의 한계가 명확히 드러납니다.

| 접근법 | 중복 방지 보장 수준 | 구현 복잡도 | 클라이언트 변경 필요 | 주요 제한사항 |
|---|---|---|---|---|
| Idempotency Key | 강력 (네트워크 장애 포함) | 중간 | 필요 | 저장소 관리 필요 |
| DB 유니크 제약 | 도메인 의존 | 낮음 | 불필요 | 분산 트랜잭션 미보장 |
| 낙관적 락 | 충돌 감지만 | 중간 | 불필요 | 재시도 시 충돌 반복 가능 |
| 비즈니스 규칙 검증 | 의미 기반, 부분적 | 높음 | 불필요 | 모든 케이스 커버 어려움 |
| 메시지 중복 제거 (Kafka) | 파티션 내 보장 | 높음 | 필요 | 인프라 종속성 높음 |

유니크 제약 방식은 도메인에서 식별자가 명확한 경우(예: 외부 주문 번호)에는 단순하고 효과적입니다. 그러나 여러 서비스를 거치는 분산 사가(Saga) 패턴에서는 각 서비스 단계마다 다른 식별자를 사용하기 때문에 통합적인 중복 방지가 어렵습니다. Idempotency Key는 클라이언트가 단 하나의 키로 전체 분산 흐름을 추적할 수 있다는 점에서 더 범용적입니다.

### 어떤 상황에서 선택할 것인가

모든 API에 Idempotency Key를 적용하는 것은 오버엔지니어링입니다. 도입 여부를 판단할 때는 "이 요청이 두 번 처리된다면 어떤 비즈니스 영향이 발생하는가?"라는 질문을 먼저 던져야 합니다.

```
도입 권장:
├── 결제, 송금, 환불 등 금전적 부작용이 있는 API
├── 이메일·SMS 발송처럼 부작용 취소가 어려운 외부 서비스 호출
├── 재시도 로직이 내장된 클라이언트 (모바일 앱, SDK)
└── 분산 사가에서 각 단계의 보상 트랜잭션이 복잡한 경우

도입 불필요:
├── 읽기 전용 API (GET, HEAD)
├── 자체적으로 멱등한 PUT/DELETE 요청
├── 비즈니스 키로 유니크 제약이 이미 충분한 경우
└── At-Most-Once 전달이 허용되는 이벤트·로그 수집
```

---

## 운영 환경에서의 고려사항

### 흔한 실수와 함정

멱등성 구현에서 가장 많이 발생하는 실수는 **PROCESSING 상태를 정리하지 않는 것**입니다. 서버가 요청을 처리하다 예외로 종료되거나 Redis가 재시작되면, 해당 Idempotency Key가 "처리 중" 상태로 영구 잠금될 수 있습니다. 이후 재시도 요청은 모두 409 Conflict를 받게 되어, 클라이언트는 성공도 실패도 아닌 상태에 무한히 갇힙니다. 이를 방지하려면 PROCESSING 상태에 짧은 TTL(예: 30초)을 설정하고, 처리 완료 후 최종 상태로 갱신하는 방식을 반드시 사용해야 합니다.

두 번째 함정은 **응답 본문 크기**입니다. 대용량 파일 업로드나 목록 조회처럼 응답이 수 MB에 달하는 경우, 이를 Redis에 저장하면 메모리 비용이 급증합니다. 이런 경우 응답 전체 대신 응답 상태 코드와 핵심 필드(예: 주문 ID, 결제 결과)만 저장하고, 클라이언트에게는 결과를 조회할 수 있는 URL이나 ID를 반환하는 방식으로 설계를 조정해야 합니다.

세 번째 함정은 **페이로드 해시 비교를 생략**하는 것입니다. 키만 확인하고 페이로드 비교를 건너뛰면, 클라이언트가 동일한 키로 전혀 다른 요청(예: 다른 금액의 결제)을 보냈을 때 최초 요청의 결과가 반환됩니다. 클라이언트 버그를 서버가 조용히 삼켜버리는 상황입니다. 페이로드 해시 비교는 구현 비용이 낮으므로 생략하지 않는 것을 강력히 권장합니다.

> PROCESSING 상태에는 항상 짧은 TTL을 설정하십시오. 영구 잠금은 가용성 장애로 이어집니다.

### 모니터링과 디버깅

멱등성 레이어에서 관찰해야 할 핵심 지표는 크게 네 가지입니다.

| 지표 | 설명 | 이상 신호 기준 |
|---|---|---|
| 캐시 히트율 | 재시도 요청 비율 | 급격한 증가 → 클라이언트 재시도 폭증 또는 업스트림 장애 |
| PROCESSING 잔존 수 | 처리 중 상태 레코드 수 | 0이어야 정상, 증가 시 서버 장애 징후 |
| 페이로드 불일치 오류율 | 422 오류 발생 수 | 높으면 클라이언트 버그 또는 악의적 요청 |
| 평균 키 TTL 잔존 | 키 만료 전 평균 잔존 시간 | 너무 짧으면 TTL 정책 재검토 필요 |

캐시 히트율이 갑자기 급증하는 것은 클라이언트 재시도 로직이 과도하게 작동하거나, 업스트림 서비스의 장애로 다수의 타임아웃이 발생하고 있다는 신호일 수 있습니다. 이를 SLO 대시보드에 포함시키면 인시던트 감지 시간을 크게 단축할 수 있습니다. Prometheus + Grafana 환경에서는 `idempotency_cache_hit_total`과 `idempotency_conflict_total` 같은 카운터 메트릭을 별도로 노출하는 것을 권장합니다.

로그에는 Idempotency Key의 해시값(원본 노출 지양)과 처리 결과(HIT/MISS/CONFLICT)를 반드시 포함시켜야 합니다. 장애 상황에서 특정 키의 처리 흐름을 추적하는 것이 원인 분석의 핵심이 되기 때문입니다.

### 확장과 마이그레이션

단일 Redis 인스턴스에서 Redis Cluster로 마이그레이션할 때는 해시 슬롯 분산에 주의해야 합니다. 동일 API 키에 대한 여러 Idempotency Key가 서로 다른 슬롯에 분산되는 것은 성능에는 유리하지만, `MULTI/EXEC` 트랜잭션이 필요한 경우 같은 슬롯에 있어야 하므로 설계 시 미리 고려해야 합니다.

서비스 규모가 커져 API 서버를 여러 리전에 배포하는 경우, 리전 간 Redis 복제 지연(Replication Lag)이 중복 처리 창을 열 수 있습니다. 이를 해결하는 방법으로는 세 가지 접근이 있습니다.

| 전략 | 장점 | 단점 | 비용 |
|---|---|---|---|
| 클라이언트 리전 고정 (Sticky Routing) | 복잡도 낮음 | 리전 장애 시 세션 유실 | 낮음 |
| 글로벌 분산 Redis (Geo-Replication) | 일관성 높음 | 쓰기 레이턴시 증가 | 높음 |
| 리전별 독립 네임스페이스 | 성능 최적 | 크로스 리전 중복 가능 | 낮음 |

또한 RDBMS 멱등성 테이블은 시간이 지남에 따라 만료된 레코드로 인해 급격히 커질 수 있습니다. 파티셔닝(예: `expires_at` 기준 월별 파티션)과 주기적인 만료 데이터 삭제 배치 작업을 초기 설계 단계부터 계획해야 합니다.

---

## 맺음말

### 핵심 요약

멱등성 API 설계는 분산 시스템의 신뢰성을 근본적으로 향상시키는 패턴입니다. Idempotency Key는 클라이언트가 생성한 고유 식별자로, 서버가 동일 요청을 단 한 번만 처리하도록 보장합니다. 구현의 핵심은 **원자적 선점**(Redis NX 명령 또는 DB UNIQUE 제약), **페이로드 해시 비교**, **PROCESSING 상태의 자동 해제**라는 세 가지 메커니즘의 조합입니다. 레이턴시 오버헤드는 5~10% 수준으로 결제나 주문처럼 정합성이 중요한 API에서는 충분히 수용 가능하며, 대규모 재시도 폭증 상황에서는 오히려 서버 부하를 낮추는 부가 효과도 있습니다.

### 적용 판단 기준

API를 설계할 때 "이 요청이 두 번 처리된다면 어떤 일이 발생하는가?"라는 질문을 먼저 던져야 합니다. 금전적 부작용이 있거나, 외부 서비스 호출처럼 취소가 어려운 연산이거나, 클라이언트가 재시도 로직을 가진 경우에 집중적으로 도입을 검토해야 합니다. 모든 API에 무분별하게 적용하는 것은 오히려 운영 복잡도를 높이므로, 비즈니스 영향도와 트레이드오프를 명확히 분석한 뒤 결정하는 것이 바람직합니다.

### 다음 단계

Idempotency Key 패턴을 이해했다면, 관련된 두 가지 심화 주제를 탐구하기를 권장합니다. 첫째는 **분산 사가 패턴**입니다. 여러 마이크로서비스에 걸친 트랜잭션에서 각 단계의 멱등성을 어떻게 보장하고, 보상 트랜잭션을 설계하는지 이해하면 더 복잡한 비즈니스 흐름을 안전하게 다룰 수 있습니다. 둘째는 **Transactional Outbox 패턴**입니다. 데이터베이스 트랜잭션과 메시지 발행을 원자적으로 처리하는 이 패턴은, Idempotency Key와 결합했을 때 분산 시스템에서 Exactly-Once 처리를 실현하는 강력한 조합이 됩니다.

공식 참고 자료로는 [Stripe Idempotent Requests 문서](https://stripe.com/docs/api/idempotent_requests)와 [IETF Idempotency-Key 헤더 초안](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)을 권장합니다. 두 문서 모두 이론과 실제 서비스 경험이 결합된 높은 수준의 설계 결정을 담고 있습니다.

---

**출처**

1. [Stripe API, Idempotent requests](https://stripe.com/docs/api/idempotent_requests) — 실제 운영 중인 구현의 규칙과 보관 기간.
2. [IETF, The Idempotency-Key HTTP Header Field (draft)](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) — 표준화 진행 중인 헤더 사양.
3. [RFC 9110, HTTP Semantics — 9.2.2 Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html) — 멱등 메서드의 규범적 정의.
