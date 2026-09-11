---
title: "MySQL 함수 기반 인덱스와 Generated Column으로 JSON 쿼리 최적화"
date: "2026-09-11 07:26"
category: "Database"
tags: ["MySQL 함수 기반 인덱스와 Generated Column으로 JSON 쿼리 최적화하기", "Database", "MySQL", "Generated", "Column", "JSON"]
excerpt: "MySQL 5.7.8에서 공식 JSON 타입이 도입된 이후, 관계형 데이터베이스에서 유연한 스키마를 다루려는 수요가 크게 늘었습니다."
---

## 목차

1. 개요
2. MySQL JSON 타입과 인덱스의 기본 구조
3. Generated Column으로 JSON 경로 인덱싱
4. 함수 기반 인덱스 직접 적용
5. 성능 비교와 트레이드오프 분석
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### JSON 컬럼의 등장과 쿼리 성능 문제

MySQL 5.7.8에서 공식 JSON 타입이 도입된 이후, 관계형 데이터베이스에서 유연한 스키마를 다루려는 수요가 크게 늘었습니다. 이커머스 플랫폼의 상품 속성, IoT 기기에서 수집되는 이벤트 메타데이터, A/B 테스트의 피처 플래그 값 같은 데이터들은 컬럼 수가 수십 개에서 수백 개로 폭발적으로 늘어나기 쉬운 구조입니다. JSON 컬럼 하나에 이 값들을 담아두면 테이블 구조는 단순해지지만, 그 안의 특정 경로를 조건절에 사용하는 순간 인덱스를 전혀 활용하지 못해 풀 테이블 스캔이 발생합니다. 이 글에서는 MySQL 8.0의 Generated Column과 함수 기반 인덱스를 활용해 JSON 경로 조건을 인덱스 범위 스캔으로 전환하는 방법과 그 내부 동작을 살펴봅니다.

### 기존 방식의 한계

JSON 경로 조건에 대한 가장 단순한 대응책은 테이블을 정규화해서 JSON 값을 전용 컬럼으로 뽑아내는 것입니다. 하지만 이 방법은 스키마 변경이 필요하므로 이미 수억 건의 데이터가 적재된 테이블에서는 DDL 비용이 상당합니다. `JSON_EXTRACT()` 함수를 그대로 WHERE 절에 쓰면 MySQL 옵티마이저는 함수 결과를 미리 알 수 없기 때문에 인덱스를 우회합니다. `LIKE '%value%'` 패턴처럼 전체 컬럼을 문자열로 스캔하는 방법도 있지만, 정확도와 성능 모두 허용하기 어려운 수준입니다. `JSON_CONTAINS()`나 `JSON_SEARCH()`는 더 정밀하지만, 이 역시 인덱스를 사용하지 않고 행마다 JSON 문서를 파싱합니다. 결국 MySQL이 제공하는 JSON 관련 함수들은 표현력은 뛰어나지만, 인덱스와 연동되는 경로는 제한적이었습니다. Generated Column과 함수 기반 인덱스는 바로 이 간극을 메우기 위해 등장한 솔루션입니다.

---

## MySQL JSON 타입과 인덱스의 기본 구조

### JSON 데이터 접근 방식

MySQL의 JSON 타입은 내부적으로 바이너리 포맷으로 직렬화되어 저장됩니다. 이 포맷은 문서를 전부 파싱하지 않고도 특정 경로에 O(1)에 가까운 속도로 접근할 수 있도록 설계된 것이 특징입니다. 그러나 이 구조는 InnoDB의 B-Tree 인덱스와 호환되지 않습니다. InnoDB B-Tree 인덱스는 고정된 데이터 타입의 컬럼 값을 키로 사용하는데, JSON은 문서 전체가 하나의 바이너리 블롭이므로 인덱스 키로 직접 등록할 수 없습니다.

JSON 경로에 접근하는 주요 방법은 세 가지입니다. `JSON_EXTRACT(doc, '$.path')`는 해당 경로의 값을 JSON 타입으로 반환하고, `->` 연산자는 그 단축 표기입니다. `JSON_UNQUOTE(JSON_EXTRACT(...))` 또는 `->>` 연산자는 문자열로 언쿼우트한 결과를 반환합니다. 인덱스 활용 여부를 결정할 때 이 반환 타입 차이가 중요합니다. Generated Column을 정의할 때 어떤 표현식을 쓰느냐에 따라 쿼리에서도 동일한 표현식을 사용해야 옵티마이저가 인덱스를 인식할 수 있기 때문입니다.

| 접근 방법 | 반환 타입 | 인덱스 직접 활용 | 비고 |
|---|---|---|---|
| `JSON_EXTRACT(col, '$.k')` | JSON | ❌ 불가 | Generated Column 경유 필요 |
| `col->'$.k'` | JSON | ❌ 불가 | JSON_EXTRACT 단축형 |
| `col->>'$.k'` | VARCHAR | ❌ 불가 | JSON_UNQUOTE 단축형 |
| Generated Column + INDEX | 지정 타입 | ✅ B-Tree 활용 | 명시적 컬럼 등록 필요 |
| 함수 기반 인덱스(8.0.13+) | 자동 추론 타입 | ✅ B-Tree 활용 | 별도 컬럼 추가 불필요 |

### 함수 기반 인덱스의 동작 원리

MySQL 8.0.13부터 도입된 **함수 기반 인덱스(Functional Index)**는 내부적으로 숨겨진 Virtual Generated Column을 자동으로 생성하고 그 위에 인덱스를 만드는 방식으로 동작합니다. 사용자 입장에서는 `CREATE INDEX idx ON t ((JSON_EXTRACT(doc, '$.key')))` 형태로 선언할 뿐이지만, 실제 InnoDB 내부에는 해당 표현식을 가진 가상 컬럼이 숨겨진 채로 존재합니다. 이 메커니즘 덕분에 Generated Column을 명시적으로 추가하지 않고도 동일한 인덱스 효과를 얻을 수 있습니다.

옵티마이저가 이 인덱스를 선택하려면 WHERE 절의 표현식이 인덱스에 등록된 표현식과 정확히 일치해야 합니다. 예를 들어 `JSON_UNQUOTE(JSON_EXTRACT(doc, '$.status'))`로 인덱스를 만들었는데 쿼리에서 `doc->>'$.status'`를 쓰면, MySQL 8.0에서는 `->>` 연산자가 `JSON_UNQUOTE(JSON_EXTRACT(...))` 와 동치임을 옵티마이저가 인식하므로 대부분 정상 동작합니다. 그러나 복잡한 중첩 표현식이 들어갈수록 명시적인 표현식 일치를 직접 확인하는 것이 더 안전합니다.

```
쿼리 실행 흐름 (함수 기반 인덱스)
─────────────────────────────────────────────────
SELECT ... WHERE JSON_EXTRACT(doc, '$.status') = 'active'
                       │
                       ▼
         옵티마이저 표현식 매칭 단계
                       │
        ┌──────────────┴──────────────────────┐
        │   Hidden Virtual Generated Column   │
        │   expr: JSON_EXTRACT(doc,'$.status') │
        │   type: 자동 추론                    │
        └──────────────────────────────────────┘
                       │
                       ▼
          B-Tree 인덱스 범위 스캔 (ref/range)
          Full Table Scan 완전 회피
─────────────────────────────────────────────────
```

### Generated Column과의 관계

Generated Column은 MySQL 5.7.6부터 지원되며, 다른 컬럼이나 표현식으로부터 값을 자동으로 계산하는 컬럼입니다. **VIRTUAL**과 **STORED** 두 가지 방식이 있습니다. VIRTUAL은 데이터를 디스크에 저장하지 않고 읽을 때마다 계산하며, STORED는 값을 디스크에 기록합니다. JSON 경로 추출처럼 계산 비용이 낮은 경우에는 VIRTUAL이 권장됩니다. STORED는 계산이 복잡하거나 읽기 빈도가 매우 높을 때 유용하지만, INSERT/UPDATE 시 스토리지 오버헤드가 발생합니다.

Generated Column이 함수 기반 인덱스보다 유연한 점은 컬럼에 명시적인 타입을 지정할 수 있다는 것입니다. JSON 경로에서 추출한 값이 정수라면 `INT`로, 날짜라면 `DATE`로 선언해두면 비교 연산 시 묵시적 타입 변환 없이 인덱스를 최대로 활용할 수 있습니다. 반면 함수 기반 인덱스는 MySQL이 타입을 자동 추론하므로, 원하는 타입으로 명확히 제어하려면 Generated Column 방식이 더 적합합니다.

---

## Generated Column으로 JSON 경로 인덱싱

### Virtual vs Stored Generated Column

두 방식의 차이는 단순히 저장 위치만이 아닙니다. VIRTUAL 컬럼은 테이블 행 자체에는 기록되지 않으므로 테이블 크기는 거의 변하지 않습니다. 다만 인덱스에는 해당 값이 저장됩니다. STORED 컬럼은 행과 인덱스 모두에 값이 저장되므로 스토리지를 더 사용하지만, 컬럼을 SELECT로 조회할 때 별도 계산 없이 바로 읽어올 수 있습니다.

JSON 쿼리 최적화 맥락에서는 VIRTUAL이 대부분의 케이스에서 충분합니다. JSON 경로 추출은 CPU 비용이 낮은 편이고, 인덱스를 통해 필터링된 소수의 행에 대해서만 계산이 일어나기 때문입니다. STORED가 유리한 경우는 해당 컬럼을 ORDER BY나 GROUP BY에 반복적으로 사용하거나, 복수의 인덱스에서 같은 컬럼을 참조할 때 계산을 한 번으로 줄이고 싶을 때입니다.

| 항목 | VIRTUAL | STORED |
|---|---|---|
| 디스크 저장 위치 | 인덱스에만 | 행 데이터 + 인덱스 |
| INSERT/UPDATE 속도 | 빠름 | 느림 (계산 후 기록) |
| SELECT 계산 비용 | 행 읽을 때마다 발생 | 없음 (저장값 반환) |
| 스토리지 오버헤드 | 낮음 | 높음 |
| 외래 키 참조 가능 | ❌ 불가 | ✅ 가능 |
| 파티셔닝 기준 컬럼 | ❌ 불가 | ✅ 가능 |
| 권장 사용 목적 | 인덱스 전용 필터링 | 조회·정렬 빈도 높을 때 |

### Generated Column 생성과 인덱스 적용

실제 이커머스 환경을 상정해 보겠습니다. `orders` 테이블에 `meta` JSON 컬럼이 있고, 여기에 주문 채널(`$.channel`), 배송 옵션(`$.shipping.type`), 쿠폰 코드(`$.coupon`) 등이 담겨 있는 구조입니다. 가장 자주 조회되는 조건이 `$.channel = 'mobile'`이라면, 이 경로에 대한 인덱스가 없을 경우 수천만 건 테이블에서 풀 스캔이 발생합니다. VIRTUAL Generated Column을 추가하면 테이블 행 크기를 늘리지 않고 인덱스만 생성할 수 있습니다.

아래 DDL은 `meta` JSON 컬럼에서 채널 값을 추출하는 VIRTUAL Generated Column을 추가하고, 그 위에 인덱스를 생성하는 방법을 보여줍니다.

```sql
-- meta JSON 컬럼에서 채널 값을 추출하는 VIRTUAL Generated Column 추가
ALTER TABLE orders
  ADD COLUMN channel VARCHAR(32)
    GENERATED ALWAYS AS (
      JSON_UNQUOTE(JSON_EXTRACT(meta, '$.channel'))
    ) VIRTUAL,
  ADD INDEX idx_orders_channel (channel);

-- Generated Column 이름으로 직접 참조 (권장)
SELECT order_id, created_at, total_amount
FROM orders
WHERE channel = 'mobile'           -- ✅ idx_orders_channel 인덱스 사용
  AND created_at >= '2026-01-01';

-- 원래 표현식으로도 동일 인덱스 선택 가능 (MySQL 8.0 옵티마이저 동치 인식)
SELECT order_id, created_at, total_amount
FROM orders
WHERE JSON_UNQUOTE(JSON_EXTRACT(meta, '$.channel')) = 'mobile';
-- EXPLAIN → type: ref, key: idx_orders_channel
```

쿼리에서 `channel = 'mobile'`처럼 Generated Column 이름을 직접 사용해도 되고, 원래 표현식을 그대로 사용해도 옵티마이저가 동일한 인덱스를 선택합니다. 이 동치 인식은 MySQL 8.0의 옵티마이저가 숨겨진 Virtual Column과 원래 표현식을 연결하기 때문입니다. 다만 애플리케이션 코드에서는 `channel` 컬럼명을 직접 참조하는 것이 가독성과 유지보수 측면에서 유리합니다.

### 실행 계획 분석

`EXPLAIN`과 `EXPLAIN ANALYZE`는 JSON 쿼리 최적화 작업에서 핵심 도구입니다. `EXPLAIN`은 옵티마이저가 선택한 실행 계획을 보여주고, `EXPLAIN ANALYZE`는 실제 실행 통계(실행 시간, 처리된 행 수)까지 포함합니다. 인덱스가 제대로 동작하는지 확인할 때 `type` 컬럼을 가장 먼저 살펴봐야 합니다. `ALL`은 풀 테이블 스캔, `index`는 인덱스 전체 스캔, `range`는 범위 스캔, `ref`는 비고유 인덱스 조회를 의미합니다. JSON 경로 조건에 인덱스가 적용되었다면 `ref` 또는 `range`가 나타나야 합니다.

```
EXPLAIN 결과 핵심 컬럼 해석 (orders 테이블 예시)
───────────────────────────────────────────────────────
type  │ key                   │ rows     │ filtered │ Extra
──────┼───────────────────────┼──────────┼──────────┼─────────────────
ALL   │ NULL                  │ 50,000만 │  10.00   │ Using where
      │                       │          │          │ (풀 스캔)
──────┼───────────────────────┼──────────┼──────────┼─────────────────
ref   │ idx_orders_channel    │   80만   │  10.00   │ Using index
      │                       │          │          │ condition
──────┼───────────────────────┼──────────┼──────────┼─────────────────
range │ idx_orders_channel    │   50만   │ 100.00   │ Using index
      │                       │          │          │ condition
───────────────────────────────────────────────────────
rows × (filtered / 100) = 옵티마이저 예측 처리 행 수
```

> **주의**: `Extra` 컬럼에 `Using where`만 있고 `Using index`가 없다면, 인덱스로 행을 찾은 뒤 추가 조건을 테이블에서 재확인하는 단계가 있다는 의미입니다. 자주 조회되는 컬럼을 인덱스에 포함시키는 커버링 인덱스 전략을 검토할 타이밍입니다.

---

## 함수 기반 인덱스 직접 적용

### MySQL 8.0.13+ 함수 기반 인덱스

MySQL 8.0.13에서 도입된 함수 기반 인덱스는 Generated Column을 테이블 스키마에 명시적으로 추가하지 않고도 동일한 효과를 얻을 수 있는 방법입니다. `CREATE INDEX` 문에서 표현식을 이중 괄호로 감싸서 선언합니다. 이 방식이 유용한 이유는 테이블의 컬럼 수를 늘리지 않으면서 인덱스만 추가할 수 있다는 점입니다. 컬럼 수가 많아지면 `SELECT *` 출력이 복잡해지고, 프레임워크의 ORM 매핑이 의도치 않게 새 컬럼을 처리하려 할 수 있습니다. 이런 부작용 없이 인덱스만 즉각 추가하고 싶을 때 함수 기반 인덱스가 적합합니다.

함수 기반 인덱스는 스키마를 최소한으로 변경하면서 빠르게 인덱스를 추가해야 하는 상황—예를 들어 운영 중 장애 대응이나 빠른 성능 검증—에 특히 유용합니다. 그러나 내부적으로는 숨겨진 Virtual Generated Column을 생성한다는 사실을 기억해야 합니다. 따라서 해당 JSON 경로의 스키마가 안정적이지 않다면, 나중에 함수 기반 인덱스를 삭제하고 재생성해야 할 수 있습니다. 장기적으로 관리 부담을 낮추려면 명시적인 Generated Column 방식이 낫습니다.

```sql
-- Generated Column 없이 함수 기반 인덱스 직접 생성 (MySQL 8.0.13+)
CREATE INDEX idx_orders_channel_func
  ON orders ((JSON_UNQUOTE(JSON_EXTRACT(meta, '$.channel'))));

-- 쿼리에서 동일 표현식 사용 시 자동으로 인덱스 선택
SELECT order_id, total_amount
FROM orders
WHERE JSON_UNQUOTE(JSON_EXTRACT(meta, '$.channel')) = 'mobile';
-- 또는 단축형 연산자도 동치로 인식됨 (MySQL 8.0+)
-- WHERE meta->>'$.channel' = 'mobile';
-- EXPLAIN → type: ref, key: idx_orders_channel_func
```

### 복합 인덱스와 커버링 인덱스

단일 JSON 경로 인덱스만으로는 복합 조건 쿼리의 성능을 최대화하기 어렵습니다. 예를 들어 `channel = 'mobile' AND status = 'paid' AND created_at BETWEEN ...` 형태의 쿼리가 자주 실행된다면, Generated Column을 여러 개 만들고 복합 인덱스로 묶는 것이 효과적입니다. 복합 인덱스의 컬럼 순서는 카디널리티와 쿼리 패턴을 함께 고려해야 합니다. 필터 조건에서 선택도(selectivity)가 높은 컬럼—즉, 특정 값이 전체 데이터의 소수만 해당되는 컬럼—을 앞에 두는 것이 일반적인 원칙입니다.

커버링 인덱스는 쿼리가 필요로 하는 모든 컬럼이 인덱스에 포함되어 있어 테이블 데이터 페이지를 읽지 않아도 되는 인덱스를 말합니다. `EXPLAIN`의 `Extra` 컬럼에 `Using index`가 표시되면 커버링 인덱스가 동작 중임을 알 수 있습니다. JSON 쿼리에서 자주 조회하는 컬럼들을 Generated Column으로 추출해 복합 인덱스에 포함시키면 테이블 페이지 접근을 완전히 배제할 수 있습니다.

| 인덱스 유형 | 구성 예시 | 효과 | 주의점 |
|---|---|---|---|
| 단일 JSON 경로 | `(channel)` | 단순 등치·범위 조건 | 복합 조건에서는 효과 제한적 |
| 복합 인덱스 | `(channel, status)` | 복합 조건 최적화 | 컬럼 순서 잘못 설정 시 스킵 발생 |
| 커버링 인덱스 | `(channel, status, total_amount)` | 테이블 접근 불필요 | 인덱스 크기 증가, 쓰기 비용 상승 |
| JSON 배열 인덱스 | 멀티밸류(8.0.17+) | 배열 내 원소 검색 | MEMBER OF 연산자 필요 |

### 쿼리 최적화 전후 비교

최적화의 효과를 명확히 확인하려면 실제 데이터와 함께 `EXPLAIN ANALYZE`를 비교해봐야 합니다. 중요한 것은 단순히 실행 시간이 줄어드는 것 이상으로, 행 단위 JSON 파싱 비용이 완전히 제거되고 I/O가 인덱스 페이지 위주로 집중된다는 구조적 변화입니다. 특히 JSON 문서의 크기가 클수록—메타 데이터가 수백 바이트에서 수 킬로바이트에 이르는 경우—풀 스캔 시의 파싱 비용이 더욱 커지므로 인덱스 효과도 두드러집니다.

```
최적화 전후 실행 특성 비교 (orders 테이블 5,000만 행 기준)
────────────────────────────────────────────────────────────
항목               변경전 (풀 스캔)       변경후 (인덱스 스캔)
──────────────────┼──────────────────────┼─────────────────────
실행 계획 type    │ ALL                  │ ref
접근 행 수        │ 5,000만              │ 약 80만
JSON 파싱 횟수    │ 5,000만              │ 0 (인덱스 키 비교)
예상 실행 시간    │ ~12초                │ ~0.08초
버퍼 풀 I/O 패턴 │ 데이터 페이지 전체   │ 인덱스 페이지 집중
────────────────────────────────────────────────────────────
```

> **핵심 포인트**: 인덱스 효과는 JSON 문서 크기와 카디널리티에 비례합니다. 문서가 클수록, 해당 경로의 고유값이 많을수록 개선 폭이 커집니다.

---

## 성능 비교와 트레이드오프 분석

### 성능 특성

성능에 영향을 미치는 요소는 크게 세 가지입니다. 첫째는 JSON 문서의 크기입니다. 문서가 클수록 `JSON_EXTRACT`를 행마다 실행하는 비용이 커지므로 인덱스 효과가 더 두드러집니다. 수십 바이트짜리 문서라면 파싱 비용 자체가 낮아 인덱스 유무의 차이가 상대적으로 작습니다. 반면 수 킬로바이트짜리 JSON 문서를 수천만 행에 걸쳐 파싱하면 CPU와 I/O 모두 포화에 이를 수 있습니다.

둘째는 해당 경로 값의 카디널리티입니다. 고유값이 많을수록 인덱스의 선택도가 높아져 더 적은 행을 읽게 됩니다. 예를 들어 `$.channel`이 `mobile`, `web`, `app` 세 가지 값만 가진다면 각 값이 전체의 약 33%를 차지하므로 인덱스 효과가 제한적입니다. 반면 `$.coupon_code`처럼 값의 종류가 수만 개라면 인덱스 효율이 극적으로 높아집니다. 셋째는 동시 쓰기 부하입니다. STORED Generated Column은 INSERT/UPDATE마다 값을 계산해 저장하므로, 쓰기 부하가 높은 테이블에서는 VIRTUAL보다 처리량이 낮아질 수 있습니다.

| 데이터 특성 | 인덱스 기대 효과 | 권장 방식 |
|---|---|---|
| JSON 문서 크고, 카디널리티 높음 | ★★★★★ 매우 큼 | VIRTUAL Generated Column |
| JSON 문서 작고, 카디널리티 낮음 | ★★☆☆☆ 제한적 | 인덱스 대신 파티셔닝 고려 |
| 쓰기 부하 낮고 읽기 빈도 매우 높음 | ★★★★☆ 큼 | STORED Column 검토 |
| 쓰기 부하 높음 (초당 수천 건) | ★★★☆☆ 보통 | VIRTUAL Column 유지 |
| 복합 조건 필터링 | ★★★★☆ 큼 | 복합 Generated Column 인덱스 |

### 대안 기술과 비교

JSON 경로 인덱싱 문제에 접근하는 방법은 MySQL 내에만도 여러 가지입니다. 정규화(테이블 분리)는 가장 근본적인 해결책으로, 쿼리 성능 면에서 Generated Column보다 우수한 경우가 많습니다. 하지만 스키마 변경이 수반되며, 속성 구조의 유연성을 일부 포기해야 합니다. 전문 검색 엔진(Elasticsearch, OpenSearch)으로 JSON 데이터를 이관하는 방법도 있습니다. 복잡한 JSON 구조를 다양한 경로로 검색해야 하는 경우 효과적이지만, 아키텍처 복잡도와 운영 비용이 올라갑니다.

PostgreSQL의 `jsonb` 타입과 GIN 인덱스는 JSON 경로 인덱싱에서 더 성숙한 기능을 제공합니다. GIN 인덱스는 JSON 문서 내 모든 키-값 쌍을 인덱싱하므로, 경로가 미리 정해지지 않은 임의 쿼리에서도 인덱스를 활용할 수 있습니다. MySQL은 이런 범용 JSON 인덱스를 지원하지 않으므로, 인덱스가 필요한 경로를 사전에 식별해야 하는 제약이 있습니다. 이 제약이 오히려 설계 규율을 강제하는 장점이 되기도 하지만, 탐색적 쿼리가 빈번한 환경에서는 부담이 됩니다.

| 방법 | 쿼리 성능 | 스키마 유연성 | 운영 복잡도 | 도입 비용 |
|---|---|---|---|---|
| 정규화 (컬럼 분리) | ★★★★★ | ★★☆☆☆ | 낮음 | DDL 비용 큼 |
| Generated Column + 인덱스 | ★★★★☆ | ★★★★☆ | 낮음 | DDL 최소 |
| Elasticsearch 연동 | ★★★★★ | ★★★★★ | 높음 | 인프라 추가 |
| PostgreSQL jsonb + GIN | ★★★★★ | ★★★★★ | 중간 | DB 교체 필요 |

### 어떤 상황에서 선택할 것인가

기술 선택의 핵심은 쿼리 패턴의 안정성과 JSON 구조의 예측 가능성에 달려 있습니다. 운영 중인 API의 WHERE 절을 분석해보면, 대부분의 읽기 쿼리는 2~5개의 고정 조건을 반복적으로 사용합니다. 그 조건 중 JSON 경로가 포함된 것이 있고, 해당 경로가 안정적이라면 Generated Column + 인덱스를 적용하는 것이 합리적입니다. 반면, 사용자가 임의로 JSON 필드를 선택해서 검색하는 UI(예: 동적 필터 기능)가 있다면 MySQL의 정적 인덱스로는 커버하기 어렵습니다. 이 경우에는 검색 레이어를 별도로 구성하거나 Elasticsearch를 도입하는 것이 현실적인 선택입니다.

> **선택 원칙**: 인덱스가 필요한 JSON 경로가 5개 이하이고, 해당 경로의 스키마가 안정적이라면 Generated Column이 가장 현실적입니다. 경로가 동적이거나 임의 검색이 필요하다면 별도 검색 엔진과의 역할 분담을 검토할 시점입니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

Generated Column 기반 인덱스의 가장 흔한 실수는 **표현식 불일치**입니다. Generated Column을 `JSON_UNQUOTE(JSON_EXTRACT(meta, '$.channel'))`로 정의했는데 쿼리에서 `meta->'$.channel'`을 사용하면, 전자는 문자열을 반환하고 후자는 JSON 타입을 반환하므로 옵티마이저가 인덱스를 선택하지 않을 수 있습니다. 이를 예방하려면 Generated Column 정의와 애플리케이션 쿼리에서 동일한 함수 표현식을 사용하도록 팀 내 컨벤션을 수립하는 것이 좋습니다.

두 번째 함정은 **타입 불일치**입니다. JSON에서 추출한 숫자 값이 문자열 타입의 Generated Column으로 정의되어 있을 때, 쿼리에서 숫자 리터럴(`WHERE price = 1000`)로 비교하면 묵시적 형변환이 발생하고 인덱스 활용이 깨질 수 있습니다. Generated Column의 타입을 JSON 값의 실제 타입에 맞게 명시적으로 선언하는 것이 중요합니다. 세 번째는 **NULL 비율 문제**입니다. 해당 JSON 경로가 존재하지 않는 행에서 `JSON_EXTRACT`는 NULL을 반환합니다. B-Tree 인덱스는 NULL을 인덱싱할 수 있지만, NULL이 전체의 상당 비율을 차지하면 옵티마이저가 인덱스를 포기하고 풀 스캔을 선택하는 경우가 있습니다.

| 실수 유형 | 증상 | 해결책 |
|---|---|---|
| 표현식 불일치 (JSON vs VARCHAR) | EXPLAIN type: ALL | 쿼리·컬럼 정의 표현식 통일 |
| 타입 불일치 (숫자↔문자열) | EXPLAIN Extra: Using where | Generated Column 타입 명시 |
| NULL 비율 과다 (30% 이상) | 옵티마이저가 인덱스 포기 | 복합 인덱스 또는 NOT NULL 제약 추가 |
| 쓰기 부하 급증 | INSERT/UPDATE 응답 시간 증가 | STORED → VIRTUAL 전환, 인덱스 수 축소 |
| JSON 스키마 변경 | Generated Column 값 불일치 | DDL 동기화 정책 수립 및 자동화 |

### 모니터링과 디버깅

운영 환경에서 JSON 경로 인덱스가 기대대로 동작하는지 확인하는 주요 수단은 세 가지입니다. 첫째, **슬로우 쿼리 로그**를 활성화하고 `long_query_time`을 낮게 설정(예: 0.5초)해두면 인덱스를 타지 못하는 쿼리가 로그에 잡힙니다. 슬로우 쿼리 로그에는 `Rows_examined`와 `Rows_sent` 값도 기록되므로, 두 값의 차이가 클수록 인덱스 효율이 낮다는 신호입니다.

둘째, **Performance Schema**의 `events_statements_summary_by_digest` 테이블을 통해 특정 쿼리 패턴의 평균 실행 시간과 `SUM_ROWS_EXAMINED` 대비 `SUM_ROWS_SENT` 비율을 추적할 수 있습니다. 셋째, `SHOW INDEX FROM orders` 명령과 `information_schema.STATISTICS`를 통해 인덱스의 카디널리티를 확인할 수 있습니다. 카디널리티가 지나치게 낮으면 옵티마이저가 인덱스 사용을 포기할 가능성이 높습니다. `ANALYZE TABLE` 명령으로 통계를 갱신하면 옵티마이저의 판단 정확도를 높일 수 있습니다.

```
인덱스 효율 모니터링 체크리스트
────────────────────────────────────────────────────────────
[1] EXPLAIN type 확인
    ALL / index  → 인덱스 미사용 → 표현식·타입 재확인
    ref / range  → 인덱스 정상 동작

[2] 슬로우 쿼리 로그 비율 확인
    Rows_examined / Rows_sent > 100 → 선택도 낮음

[3] 인덱스 카디널리티 확인
    SHOW INDEX FROM orders;
    Cardinality < (전체 행 수 × 0.01) → 효과 미미 가능성

[4] Performance Schema 통계
    SELECT DIGEST_TEXT, AVG_TIMER_WAIT, SUM_ROWS_EXAMINED
    FROM performance_schema.events_statements_summary_by_digest
    ORDER BY AVG_TIMER_WAIT DESC LIMIT 10;

[5] 통계 갱신 (카디널리티 이상 시)
    ANALYZE TABLE orders;
────────────────────────────────────────────────────────────
```

### 마이그레이션 전략

이미 운영 중인 대용량 테이블에 Generated Column과 인덱스를 추가하려면 DDL 잠금 전략을 신중하게 결정해야 합니다. MySQL 8.0은 `ALTER TABLE ... ADD COLUMN ... VIRTUAL`에 대해 즉시 메타데이터만 변경하는 **인스턴트 알고리즘(ALGORITHM=INSTANT)**을 지원합니다. VIRTUAL Generated Column은 값을 디스크에 저장하지 않으므로 컬럼 추가 자체는 거의 즉각적으로 완료됩니다. 반면 인덱스 추가는 여전히 테이블 스캔이 필요하므로 시간이 걸립니다.

무중단 마이그레이션을 위해서는 **pt-online-schema-change** 또는 **gh-ost** 같은 온라인 DDL 도구를 활용하는 것을 권장합니다. 특히 gh-ost는 MySQL 복제를 활용해 변경을 점진적으로 적용하면서 원본 테이블에 미치는 영향을 최소화합니다. 인덱스 추가는 `ALGORITHM=INPLACE, LOCK=NONE` 옵션으로 온라인으로 수행 가능하지만, 이 과정에서 I/O와 CPU 부하가 증가하므로 비피크 시간대에 수행하거나 `innodb_online_alter_log_max_size` 설정을 충분히 늘려야 합니다. STORED Generated Column은 인스턴트 알고리즘을 지원하지 않으므로, 대용량 테이블에서 STORED를 추가할 때는 특히 주의해야 합니다.

> **마이그레이션 원칙**: VIRTUAL Generated Column 추가(ALGORITHM=INSTANT)와 인덱스 추가(ALGORITHM=INPLACE)를 별도 단계로 분리해 각 단계의 부하와 잠금 시간을 최소화하십시오.

---

## 맺음말

### 핵심 요약

이 글에서 다룬 내용을 세 가지로 정리합니다. 첫째, MySQL의 JSON 경로 조건(`JSON_EXTRACT`, `->>` 등)은 인덱스를 직접 사용할 수 없는 구조이므로, Generated Column 또는 함수 기반 인덱스를 통해 인덱스 가능한 형태로 변환해야 합니다. 둘째, VIRTUAL Generated Column은 스토리지 오버헤드 없이 인덱스 효과를 얻는 방법이며, 인덱스가 필요한 경로를 사전에 식별할 수 있을 때 적합합니다. STORED는 읽기 빈도가 극도로 높거나 외래 키·파티셔닝이 필요한 특수 상황에서 선택합니다. 셋째, 함수 기반 인덱스(MySQL 8.0.13+)는 스키마를 변경하지 않고 인덱스를 추가할 수 있어 긴급 최적화에 유용하지만, 장기적으로는 명시적인 Generated Column이 관리와 가독성 측면에서 낫습니다.

### 적용 판단 기준

이 방식을 도입할 때는 반드시 쿼리 패턴 분석을 먼저 수행해야 합니다. 슬로우 쿼리 로그나 Performance Schema에서 JSON 경로를 WHERE 절에 포함한 쿼리가 상위 고비용 쿼리에 포함되어 있다면, Generated Column 인덱스 적용을 즉시 검토할 가치가 있습니다. 반대로 해당 경로가 드물게 조회되거나, 카디널리티가 매우 낮거나, JSON 스키마가 자주 바뀐다면 신중하게 접근해야 합니다. 인덱스는 항상 쓰기 비용을 수반하므로, 인덱스가 가져오는 읽기 이득이 쓰기 오버헤드를 명백히 상회할 때 도입을 결정하는 것이 바람직합니다.

| 도입 권장 | 도입 보류 |
|---|---|
| JSON 경로 조건이 빈번한 고비용 쿼리에 포함 | 해당 쿼리 빈도가 낮거나 데이터 소량 |
| 해당 경로의 카디널리티 중간~높음 | 경로 값이 2~3가지로 카디널리티 매우 낮음 |
| JSON 스키마가 안정적으로 유지됨 | JSON 구조가 자주 변경되는 개발 초기 단계 |
| 쓰기 부하가 읽기보다 현저히 낮음 | 초당 수천 건 이상의 고빈도 INSERT/UPDATE |
| 테이블 크기 수백만 행 이상 | 소규모 테이블 (수만 행 이하) |

### 다음 단계

Generated Column 인덱스를 적용한 뒤 성능 이슈가 남아있다면, 파티셔닝과 함께 사용하는 것을 검토해볼 수 있습니다. 예를 들어 `created_at` 기준으로 범위 파티셔닝을 적용하고, 각 파티션 내에서 Generated Column 인덱스를 활용하면 파티션 프루닝과 인덱스 효율을 동시에 얻을 수 있습니다. 또한 MySQL 8.0.17부터 지원되는 **멀티밸류 인덱스(Multi-Valued Index)**는 JSON 배열 내 개별 요소에 인덱스를 적용하는 새로운 방법으로, `MEMBER OF` 연산자와 함께 JSON 배열을 다루는 쿼리에서 활용할 수 있습니다. 더 복잡한 JSON 분석이 필요하다면 ClickHouse나 Apache Druid 같은 OLAP 엔진 또는 Elasticsearch로의 역할 분담을 고려해볼 시점입니다.

공식 MySQL 문서에서 Generated Column과 함수 기반 인덱스 관련 내용을 직접 확인할 수 있습니다: https://dev.mysql.com/doc/refman/8.0/en/create-table-generated-columns.html

---

**출처**

1. [MySQL 8.0 Reference — CREATE TABLE and Generated Columns](https://dev.mysql.com/doc/refman/8.0/en/create-table-generated-columns.html) — VIRTUAL/STORED의 정의와 제약.
2. [MySQL 8.0 Reference — CREATE INDEX](https://dev.mysql.com/doc/refman/8.0/en/create-index.html) — 함수 기반 인덱스 문법과 조건.
3. [MySQL 8.0 Reference — The JSON Data Type](https://dev.mysql.com/doc/refman/8.0/en/json.html) — JSON 타입의 저장 형식.
4. [MySQL 8.0 Reference — JSON 검색 함수](https://dev.mysql.com/doc/refman/8.0/en/json-search-functions.html) — `->>`와 `JSON_EXTRACT`의 동치 관계.
