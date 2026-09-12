---
title: "PostgreSQL 쿼리 플래너 통계 튜닝과 실행 계획 고착 해결하기"
date: "2026-09-13 07:17"
publishedAt: ""
category: "Database"
tags: ["PostgreSQL 쿼리 플래너 통계 정보 튜닝과 실행 계획 고착 해결하기", "Database", "PostgreSQL"]
excerpt: "PostgreSQL의 쿼리 플래너는 실행 계획을 선택할 때 테이블과 컬럼에 저장된 통계 정보를 핵심 근거로 삼습니다. 이 통계가 실제 데이터 분포를 정확히 반영하고 있을 때 플래너는 최적의 실행 경로를 선택하지만, 통계가 오래되거나…"
status: "draft"
---

## 목차

1. 개요
2. 쿼리 플래너의 동작 원리와 통계 정보 구조
3. ANALYZE와 통계 정보 수집 전략
4. 실행 계획 고착 현상의 원인과 진단
5. 실행 계획 고착을 해결하는 방법
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경

PostgreSQL의 쿼리 플래너는 실행 계획을 선택할 때 테이블과 컬럼에 저장된 통계 정보를 핵심 근거로 삼습니다. 이 통계가 실제 데이터 분포를 정확히 반영하고 있을 때 플래너는 최적의 실행 경로를 선택하지만, 통계가 오래되거나 부정확하다면 수십 배 느린 실행 계획을 생성하는 상황이 발생합니다. 특히 데이터 증가 속도가 빠른 대용량 테이블, 특정 값에 데이터가 쏠린 분포 왜곡 컬럼, 파티션 테이블 환경에서 이 문제가 빈번하게 나타납니다. 이 글은 PostgreSQL 쿼리 플래너 통계 정보의 내부 구조부터 통계 수집 전략, 그리고 실행 계획 고착 해결까지 실제 적용 가능한 방법을 체계적으로 다룹니다.

### 기존 방식의 한계

느린 쿼리를 만났을 때 가장 먼저 시도하는 접근은 인덱스 추가나 쿼리 구조 변경입니다. 그런데 인덱스가 이미 적절히 설정되어 있고 쿼리 구조도 문제가 없음에도, 플래너가 엉뚱한 실행 경로를 선택하는 경우가 있습니다. 단순히 `VACUUM ANALYZE`를 실행해도 개선되지 않는 상황이라면 그 근본 원인은 통계 수집의 정밀도 문제, 또는 특정 실행 계획에 고착된 현상입니다. 이 두 가지는 서로 연관되어 있으며, 각각 다른 접근법이 필요하기 때문에 정확한 진단 없이 무작정 설정을 바꾸면 오히려 운영 부하를 높일 수 있습니다.

---

## 쿼리 플래너의 동작 원리와 통계 정보 구조

### 비용 기반 최적화(CBO) 메커니즘

PostgreSQL의 쿼리 플래너는 비용 기반 최적화(Cost-Based Optimizer, CBO) 방식을 사용합니다. 플래너는 하나의 쿼리에 대해 가능한 실행 계획 후보군을 생성하고, 각 후보에 비용(cost)을 추정한 뒤 가장 낮은 비용의 계획을 선택합니다. 여기서 '비용'은 실제 벽시계 시간이 아니라, 플래너가 정의한 비용 단위의 추정값입니다. 이 추정의 핵심 입력값이 바로 통계 정보이며, 통계가 부정확하면 비용 추정 자체가 왜곡되어 최악의 실행 계획이 선택될 수 있습니다.

| 비용 파라미터 | 기본값 | 의미 | 영향 범위 |
|---|---|---|---|
| `seq_page_cost` | 1.0 | 순차 페이지 읽기 단위 비용 | Seq Scan vs Index Scan 선택 |
| `random_page_cost` | 4.0 | 랜덤 페이지 읽기 비용 | 인덱스 스캔의 기준 비용 |
| `cpu_tuple_cost` | 0.01 | 튜플 처리 CPU 비용 | 행이 많을수록 영향 증가 |
| `cpu_index_tuple_cost` | 0.005 | 인덱스 튜플 처리 비용 | 인덱스 스캔 총 비용 구성 |
| `effective_cache_size` | 4GB | OS 캐시 크기 추정값 | 인덱스 스캔 비용 보정 |

`random_page_cost`가 SSD 환경에서 기본값 4.0으로 설정된 채 운영되는 경우, 플래너는 인덱스 스캔의 비용을 과대평가해 필요하지 않은 시퀀셜 스캔을 선택할 수 있습니다. SSD 환경에서는 `random_page_cost`를 1.1~2.0 범위로 낮추는 것이 권장됩니다.

### 통계 정보가 저장되는 구조

PostgreSQL의 통계 정보는 `pg_statistic` 시스템 카탈로그에 컬럼별로 저장됩니다. 이 테이블은 여러 슬롯 구조로 다양한 통계값을 담으며, `pg_stats` 뷰는 이를 사람이 읽기 쉬운 형태로 제공합니다. 플래너는 `pg_stats`를 직접 참조해 특정 조건에서 예상 행 수를 추정하고, 조인 방법과 순서, 인덱스 사용 여부를 결정합니다.

| 통계 항목 | 의미 | 플래너 사용 목적 |
|---|---|---|
| `n_distinct` | 고유 값의 수 (음수면 비율) | 카디널리티 추정, 조인 행 수 예측 |
| `most_common_vals` | 가장 자주 등장하는 값 목록 | 특정 값 조건의 선택도 추정 |
| `most_common_freqs` | 해당 값들의 등장 빈도 | WHERE 조건 후 잔존 행 수 추정 |
| `histogram_bounds` | 데이터 분포 히스토그램 경계값 | 범위 조건의 선택도 추정 |
| `correlation` | 물리 저장 순서와의 상관관계(-1~1) | 인덱스 스캔 비용 보정 |
| `null_frac` | NULL 비율 | NULL 조건 선택도 추정 |

`n_distinct`가 음수인 경우(예: -0.05)는 "전체 행의 5%가 고유 값"이라는 의미입니다. 양수인 경우는 절댓값으로 고유 값의 개수를 나타냅니다. 플래너가 이 값을 잘못 추정하면 조인 순서나 해시 테이블 크기 결정에서 오류가 발생합니다.

### 데이터 흐름과 통계 참조 과정

SQL 쿼리가 실행 결과로 이어지기까지 PostgreSQL 내부에서는 다음 단계를 거칩니다.

```
SQL 쿼리 입력
      │
      ▼
  파서(Parser)
  ─ 문법 검사 → 파스 트리 생성
      │
      ▼
  분석기(Analyzer)
  ─ 의미론적 분석, 객체 바인딩
      │
      ▼
  재작성기(Rewriter)
  ─ 뷰 확장, 규칙 적용
      │
      ▼
  플래너(Planner / Optimizer)  ◄── pg_statistic 참조
  ├─ 후보 계획 생성 (조인 순서, 스캔 방법 등)
  ├─ 각 계획 비용 추정
  └─ 최소 비용 계획 선택 → 계획 트리 반환
      │
      ▼
  실행기(Executor)
  ─ 계획 트리를 따라 실제 실행 → 결과 반환
```

플래너 단계에서 `pg_statistic`을 참조해 카디널리티 추정, 조인 행 수 예측, 스캔 방법 선택이 이루어집니다. `EXPLAIN (ANALYZE, BUFFERS)` 명령으로 플래너의 `rows=` 예측과 `actual rows=` 실제 행 수를 비교하면 통계의 부정확도를 정량적으로 진단할 수 있습니다. 두 값의 괴리가 클수록 통계 개선이 필요하다는 신호입니다.

---

## ANALYZE와 통계 정보 수집 전략

### default_statistics_target 이해하기

PostgreSQL의 통계 수집 정밀도는 `default_statistics_target` 파라미터로 조정합니다. 기본값은 100이며, 이 값이 클수록 `most_common_vals` 항목이 더 많이 수집되고 히스토그램 버킷이 세밀해집니다. 그러나 값을 무조건 높이면 `ANALYZE` 실행 시간이 증가하고 `pg_statistic` 저장 크기도 늘어납니다. 전역 설정보다는 컬럼 단위로 통계 목표를 선별 조정하는 방식이 훨씬 효율적입니다. 데이터 분포가 균등하지 않거나, WHERE 절에 자주 등장하는 컬럼에만 높은 목표를 설정합니다.

| `statistics_target` 값 | 수집되는 MCV 수 | 히스토그램 버킷 수 | 권장 사용 상황 |
|---|---|---|---|
| 10~50 | 소수 | 거친 분포 | 단순 조회, 카디널리티 낮고 균등한 컬럼 |
| 100 (기본) | 보통 | 기본 정밀도 | 일반적인 컬럼 |
| 200~500 | 많음 | 세밀한 분포 | 범위 쿼리가 많은 날짜, 금액 컬럼 |
| 500~1000 | 매우 많음 | 매우 세밀 | 극단적 분포 왜곡, 심각한 추정 오류 컬럼 |

통계 목표를 높인다고 쿼리가 직접 빨라지는 것은 아닙니다. 이 작업은 플래너가 더 정확한 판단을 내릴 수 있는 근거 데이터를 충분히 제공하는 것입니다. 효과를 확인하려면 `statistics_target` 조정 전후의 `EXPLAIN (ANALYZE)` 출력을 비교해야 합니다.

### 컬럼별 통계 목표 설정과 ANALYZE 실행

전자상거래 시스템의 `orders` 테이블에서 `status` 컬럼과 `created_at` 컬럼이 WHERE 절에 자주 사용되는데, `status`의 값 분포가 극히 불균형한 상황(예: `completed`가 97%, 나머지가 3%)을 예로 들겠습니다. 이런 경우 기본 통계 목표로는 희귀 값에 대한 선택도 추정이 부정확해집니다.

```sql
-- 컬럼별 통계 목표 조정
-- status: 값 종류는 적지만 분포가 극단적으로 치우침 → MCV를 더 세밀히 수집
ALTER TABLE orders ALTER COLUMN status SET STATISTICS 500;

-- created_at: 범위 쿼리가 많으므로 히스토그램 버킷을 세밀하게 수집
ALTER TABLE orders ALTER COLUMN created_at SET STATISTICS 500;

-- customer_id: 조인 키로 자주 사용, 카디널리티 정확도 중요
ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 300;

-- 특정 테이블만 ANALYZE (전체 DB 대비 훨씬 빠름)
ANALYZE VERBOSE orders;

-- 현재 통계 현황 확인
SELECT
    attname            AS column_name,
    attstattarget      AS statistics_target,
    n_distinct,
    null_frac,
    array_length(most_common_vals::text[], 1) AS mcv_count
FROM pg_stats
WHERE tablename = 'orders'
ORDER BY attname;
-- 결과(주석): status의 mcv_count가 4 → 500, created_at의 histogram_bounds 버킷 수 증가
```

이 설정 후 `EXPLAIN (ANALYZE)`를 재실행하면 플래너의 `rows=` 추정이 `actual rows=`에 더 가까워지는 것을 확인할 수 있습니다. 가장 먼저 통계를 갱신하고, 실행 계획이 개선되는지 확인한 뒤 추가 튜닝 여부를 결정하는 순서가 올바른 접근입니다.

### 확장 통계(Extended Statistics)로 컬럼 간 상관관계 반영

단일 컬럼 통계만으로는 표현하기 어려운 패턴이 있습니다. `city`와 `country` 컬럼이 함께 WHERE 절에 사용될 때, 플래너는 두 컬럼이 독립적이라고 가정해 각각의 선택도를 곱합니다. 그런데 "특정 도시는 항상 특정 나라에 속한다"는 상관관계가 있다면, 실제보다 선택도를 훨씬 낮게 추정해 조인 순서를 잘못 결정하게 됩니다. PostgreSQL 10부터 도입된 **확장 통계(Extended Statistics)** 기능이 이 문제를 해결합니다.

```sql
-- 두 컬럼 간 의존성 통계 생성 (PostgreSQL 10+)
CREATE STATISTICS addr_region_deps (dependencies)
    ON city, country FROM customer_addresses;

-- 함께 등장하는 값 조합의 MCV 통계도 생성 (PostgreSQL 12+)
CREATE STATISTICS orders_status_tier_mcv (mcv)
    ON status, amount_tier FROM orders;

-- 확장 통계 생성 후 반드시 ANALYZE 실행
ANALYZE customer_addresses;
ANALYZE orders;

-- 생성된 확장 통계 확인
SELECT stxname, stxkeys::text, stxkind
FROM pg_statistic_ext
WHERE stxrelid IN ('customer_addresses'::regclass, 'orders'::regclass);
-- 결과(주석): dependencies 통계로 city+country 조합 선택도 정확도 향상
```

확장 통계를 생성한 뒤 `ANALYZE`를 실행하면, 다중 컬럼 조건의 선택도 추정이 크게 개선됩니다. 다만 확장 통계를 무분별하게 생성하면 `ANALYZE` 실행 시간이 증가하므로, 실제 함께 사용되는 컬럼 조합에만 선별적으로 적용하는 것이 원칙입니다. `EXPLAIN`의 행 수 추정 오류가 두 컬럼의 조합 조건에서만 나타날 때 이 방법을 적용합니다.

---

## 실행 계획 고착 현상의 원인과 진단

### 실행 계획 고착이란

**실행 계획 고착(Plan Sticking 또는 Plan Regression)** 은 데이터 변화나 통계 갱신에도 불구하고 비효율적인 실행 계획이 반복 사용되거나, 새로운 계획이 채택되었더라도 여전히 최적이 아닌 경우를 말합니다. 원인에 따라 크게 세 가지 유형으로 분류할 수 있습니다.

| 고착 유형 | 원인 | 영향 범위 | 위험도 |
|---|---|---|---|
| 통계 지연형 | 자동 통계 갱신이 임계값을 미달 | 특정 테이블 전체 | 높음 |
| 파라미터 스니핑형 | Prepared Statement 플랜 캐시 재사용 | 특정 구문·세션 | 중간~높음 |
| 통계 정밀도 부족형 | statistics_target이 분포를 충분히 반영 못 함 | 특정 컬럼 조건 | 중간 |
| 비용 파라미터 오설정형 | random_page_cost 등이 실제 하드웨어와 불일치 | DB 전체 | 중간 |

첫 번째인 통계 지연형은 대용량 테이블에서 가장 흔합니다. autovacuum의 기본 임계값(행 수의 20% + 50행)은 1억 행 테이블 기준으로 2,000만 행이 변경되어야 `ANALYZE`가 트리거됩니다. 이 임계값이 충족되지 않으면 오래된 통계가 장기간 사용됩니다. 두 번째인 파라미터 스니핑형은 PostgreSQL이 Prepared Statement 실행 계획을 캐시하는 특성 때문에 발생합니다. 처음 계획을 생성할 때의 파라미터 값이 데이터 분포의 예외적인 경우였다면, 이후 실행에서도 그 계획이 재사용됩니다.

### EXPLAIN ANALYZE로 추정 오류 진단하기

실행 계획 고착을 진단하는 가장 직접적인 방법은 `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` 출력을 분석해 `rows=`(플래너 예측)와 `actual rows=`(실제 실행) 사이의 괴리를 측정하는 것입니다. 이 괴리가 크면 클수록 해당 단계의 통계 정확도가 낮다는 뜻이며, 그 단계 이후의 모든 비용 추정도 연쇄적으로 왜곡됩니다.

```sql
-- 문제가 의심되는 쿼리에 대한 상세 실행 계획 분석
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
SELECT o.order_id, o.total_amount, c.email
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'pending'
  AND o.created_at >= NOW() - INTERVAL '7 days';

-- 출력 예시 해석 (실제 출력을 주석으로 표현):
-- Hash Join  (cost=1245.00..8934.00 rows=102 width=48)
--            (actual time=45.12..2341.56 rows=89432 loops=1)
--   Buffers: shared hit=234 read=8912
--   → rows 추정 102 vs 실제 89,432: 876배 오차
--   → 이 경우 status + created_at 조합 통계 개선 필요
--   → Hash Join 대신 Merge Join이나 Nested Loop가 유리했을 수 있음
```

`rows=` 추정이 실제보다 훨씬 낮다면 플래너는 해시 테이블 크기를 너무 작게 잡고, 조인 순서를 잘못 결정합니다. 반대로 실제보다 높게 추정한다면 불필요하게 큰 메모리를 할당하거나, 더 가벼운 Nested Loop가 유리한 상황에서 Hash Join을 선택합니다. 두 방향 모두 성능 저하로 이어지므로 정확한 추정이 중요합니다.

### 고착 원인별 진단 체크리스트

체계적인 진단을 위해 다음 항목을 순서대로 확인합니다.

| 진단 항목 | 확인 방법 | 이상 신호 |
|---|---|---|
| 통계 수집 시점 | `pg_stat_user_tables`의 `last_analyze`, `last_autoanalyze` | 중요 테이블의 분석 시간이 24시간 이상 경과 |
| 통계 목표값 | `pg_attribute`의 `attstattarget` | `-1`(기본 상속) 또는 낮은 수치 |
| 행 수 추정 오류 | `EXPLAIN ANALYZE`의 `rows=` vs `actual rows=` | 5배 이상 차이 |
| 데드 튜플 비율 | `pg_stat_user_tables`의 `n_dead_tup / n_live_tup` | 비율 10% 초과 |
| 파라미터 캐시 | `pg_prepared_statements` | 오래된 계획을 가진 구문 존재 |
| autovacuum 빈도 | `pg_stat_user_tables`의 `autoanalyze_count` | 예상보다 현저히 낮은 카운트 |

> **핵심 규칙**: 실행 계획 고착 진단의 시작점은 언제나 `EXPLAIN (ANALYZE, BUFFERS)`의 `rows=` vs `actual rows=` 괴리 확인입니다. 이 수치가 5배 이상 벌어진다면 통계 개선을 최우선으로 검토하세요. 인덱스 추가나 쿼리 변경은 그 다음입니다.

---

## 실행 계획 고착을 해결하는 방법

### 통계 강제 갱신과 autovacuum 임계값 조정

대용량 테이블에서는 autovacuum의 기본 임계값이 사실상 자동 통계 갱신이 거의 일어나지 않는 설정과 같습니다. 이런 환경에서는 테이블 단위로 autovacuum 파라미터를 낮게 재설정해 더 자주 통계를 수집하도록 합니다. 절댓값 임계값(`autovacuum_analyze_threshold`)과 비율 임계값(`autovacuum_analyze_scale_factor`)을 함께 조정하면 대형 테이블에서 훨씬 반응성 좋은 통계 갱신이 가능합니다.

```sql
-- 대용량 테이블에 autovacuum 임계값 개별 조정
ALTER TABLE orders SET (
    autovacuum_analyze_scale_factor = 0.01,  -- 기본 0.2 → 1%로 낮춤
    autovacuum_analyze_threshold    = 1000   -- 최소 1000행 변경 시 트리거
);

-- 대규모 배치 작업 후 즉각 통계 갱신 (특정 컬럼만 지정하면 더 빠름)
ANALYZE VERBOSE orders (status, created_at, customer_id, amount);

-- 파티션 테이블은 각 파티션 개별 ANALYZE 필요
ANALYZE orders_2025_q3;
ANALYZE orders_2025_q4;

-- 현재 테이블 단위 autovacuum 설정 확인
SELECT relname, reloptions
FROM pg_class
WHERE relname LIKE 'orders%';
-- 결과(주석): reloptions에 설정한 autovacuum 파라미터가 표시됨
```

대규모 INSERT나 UPDATE 배치 작업 이후에는 autovacuum이 자동으로 실행되더라도 지연이 발생합니다. 중요한 배치 완료 후에는 반드시 수동 `ANALYZE`를 실행하는 운영 절차를 수립하는 것이 안전합니다.

### 파라미터 스니핑과 플랜 캐시 초기화

PostgreSQL은 Prepared Statement를 처음 실행할 때 실행 계획을 캐시하며, 이후 같은 구문이 실행될 때 파라미터 값과 무관하게 캐시된 계획을 재사용합니다. 처음 캐시된 계획이 특정 파라미터 조합에만 최적이었다면, 다른 파라미터에서는 비효율적인 계획이 사용됩니다. 이 문제는 `plan_cache_mode` 파라미터로 캐시 전략을 조정해 해결할 수 있습니다.

| `plan_cache_mode` 값 | 동작 방식 | 장점 | 단점 | 권장 상황 |
|---|---|---|---|---|
| `auto` (기본) | 5회 실행 후 generic/custom 비용 비교 | 균형 잡힌 성능 | 파라미터 스니핑에 취약 | 일반적인 경우 |
| `force_generic_plan` | 파라미터 무관 일반 계획 고정 | 계획 생성 오버헤드 최소화 | 데이터 분포 변화에 둔감 | OLTP, 단순 쿼리 다수 |
| `force_custom_plan` | 매 실행 시 파라미터 반영 계획 생성 | 각 실행마다 최적 계획 | 계획 생성 CPU 오버헤드 | 파라미터별 분포 편차가 클 때 |

파라미터 스니핑이 의심되는 경우, 세션 수준에서 `SET plan_cache_mode = force_custom_plan`을 적용하고 성능 변화를 측정합니다. 개선이 확인되면 연결 수준의 파라미터로 영구 설정을 검토합니다. PgBouncer와 같은 연결 풀러 환경에서는 연결이 재사용되기 때문에 플랜 캐시가 더 오래 유지된다는 점도 고려해야 합니다.

### pg_hint_plan을 활용한 실행 계획 강제 지정

통계 개선과 파라미터 캐시 조정으로도 해결되지 않는 경우, `pg_hint_plan` 확장을 최후 수단으로 활용합니다. 이는 SQL 주석 형태로 플래너에게 힌트를 제공해 원하는 실행 계획을 유도하는 방식입니다. Oracle의 쿼리 힌트, SQL Server의 `USE INDEX` 구문과 유사한 개념입니다.

```sql
-- pg_hint_plan 확장 설치 후 주석 힌트 사용 예
/*+ IndexScan(o orders_status_created_at_idx)
    HashJoin(o c)
    Leading(o c) */
SELECT o.order_id, o.total_amount, c.email
FROM orders o
JOIN customers c ON o.customer_id = c.id
WHERE o.status = 'pending'
  AND o.created_at >= NOW() - INTERVAL '7 days';

-- 애플리케이션 코드 수정 없이 힌트 테이블로 적용
-- hint_plan.hints 테이블에 정규화된 쿼리 패턴과 힌트를 등록
INSERT INTO hint_plan.hints (norm_query_string, application_name, hints)
VALUES (
    'SELECT o.order_id, o.total_amount, c.email
FROM orders o JOIN customers c ON o.customer_id = $1
WHERE o.status = $2 AND o.created_at >= $3',
    'commerce_api',
    'IndexScan(o orders_status_created_at_idx) HashJoin(o c)'
);
-- 결과(주석): 해당 앱에서 실행되는 정규화 쿼리에 힌트 자동 적용
```

`pg_hint_plan`은 효과적이지만 실행 계획 로직이 코드베이스 외부에 분산된다는 단점이 있습니다. 힌트 테이블에 등록된 항목이 많아질수록 관리 복잡도가 높아지며, PostgreSQL 버전 업그레이드 시 플래너 내부 구조 변화로 힌트의 효과가 달라질 수 있습니다. 반드시 근본 원인인 통계 개선이나 인덱스 설계 개선을 먼저 시도하고, 해결이 어려울 때만 힌트를 사용하는 원칙을 지켜야 합니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

첫 번째는 **통계 목표를 전역으로 과도하게 높이는 실수**입니다. `postgresql.conf`에서 `default_statistics_target = 1000`을 설정하면 모든 컬럼의 통계 수집 정밀도가 올라가지만, autovacuum이 각 테이블을 분석하는 시간이 수십 배 길어집니다. 이로 인해 autovacuum 큐가 밀리고, 다른 테이블의 통계 갱신이 지연되는 역효과가 발생합니다. 통계 목표 상향은 반드시 컬럼 단위로, 실제 문제가 확인된 컬럼에만 적용해야 합니다.

두 번째는 **파티션 테이블에서 부모 테이블만 ANALYZE하는 실수**입니다. PostgreSQL 선언형 파티션(Declarative Partitioning)에서 부모 테이블을 `ANALYZE`해도 개별 파티션 통계는 갱신되지 않습니다. 각 파티션은 독립적인 통계를 가지므로, 파티션별로 `ANALYZE`를 실행하거나 주기적으로 모든 파티션을 순회하는 배치를 구성해야 합니다.

| 실수 유형 | 발생 결과 | 올바른 접근법 |
|---|---|---|
| 전역 statistics_target 과도 상향 | autovacuum 부하 급증, ANALYZE 지연 | 컬럼 단위 선별 적용 |
| 배치 후 ANALYZE 생략 | 오래된 통계로 비효율 계획 지속 | 배치 완료 직후 수동 ANALYZE |
| 파티션 부모만 ANALYZE | 개별 파티션 통계 미갱신 | 각 파티션 ANALYZE 또는 순회 배치 |
| pg_hint_plan 남용 | 관리 복잡도 증가, 업그레이드 위험 | 통계 개선 먼저, 힌트는 최후 수단 |
| 연결 풀 환경에서 플랜 캐시 미고려 | 파라미터 스니핑 장기화 | plan_cache_mode 조정 검토 |
| SSD 환경에서 random_page_cost 기본값 유지 | 인덱스 스캔 비용 과대 평가 | random_page_cost = 1.1~2.0으로 조정 |

### 모니터링과 핵심 지표 관찰

운영 환경에서 쿼리 플래너 상태를 지속적으로 모니터링하려면 `pg_stat_user_tables`와 `pg_stat_statements` 확장을 함께 활용합니다. `pg_stat_statements`는 쿼리별 실행 횟수, 총 실행 시간, 평균 실행 시간을 집계해 이상 징후를 감지하는 데 유용합니다. 특정 쿼리의 평균 실행 시간이 갑자기 증가했다면, 통계 갱신 타이밍과 실행 계획 변경 여부를 확인해야 합니다.

| 지표 | 관찰 위치 | 이상 신호 기준 |
|---|---|---|
| `last_analyze`, `last_autoanalyze` | `pg_stat_user_tables` | 중요 테이블의 분석 경과 시간이 24시간 초과 |
| `n_dead_tup / n_live_tup` | `pg_stat_user_tables` | 비율 10% 이상 |
| 쿼리 평균 실행 시간 추이 | `pg_stat_statements` | 특정 쿼리의 평균 실행 시간 급등 |
| `rows=` vs `actual rows=` 괴리 | `EXPLAIN ANALYZE` | 5배 이상 차이 |
| `autoanalyze_count` 증가 속도 | `pg_stat_user_tables` | 예상보다 현저히 낮은 증가 빈도 |

> **함정 주의**: `last_autoanalyze`가 최근임에도 `rows=` 추정 오류가 계속 크다면, 통계 갱신 빈도가 아닌 정밀도(statistics_target)가 부족한 것입니다. 갱신 빈도를 높이는 것만으로는 해결되지 않습니다.

### 확장과 마이그레이션 고려사항

PostgreSQL 버전 업그레이드나 대규모 데이터 마이그레이션 시에는 통계 정보 전략을 반드시 재검토해야 합니다. `pg_upgrade`를 사용한 메이저 버전 업그레이드에서는 통계 정보가 그대로 이전되지만, 새 버전에서 플래너 내부 비용 추정 로직이 변경될 수 있습니다. 이 때문에 업그레이드 직후에는 전체 `ANALYZE`를 실행하는 것이 공식 권장 사항입니다.

| 상황 | 통계 관련 체크사항 |
|---|---|
| 메이저 버전 업그레이드 | pg_upgrade 후 전체 ANALYZE 실행 |
| 대규모 데이터 마이그레이션 | 마이그레이션 완료 후 대상 테이블 ANALYZE |
| 파티션 구조 변경 | 신규 파티션 및 영향받는 파티션 ANALYZE |
| pg_hint_plan 버전 업 | 확장 호환성 확인, 힌트 효과 재검증 |
| 하드웨어 교체(HDD→SSD) | `random_page_cost` 재조정 필요 |

`pg_hint_plan`에 의존하는 힌트가 많다면, 버전 업그레이드 전 그 힌트들이 여전히 유효한지 스테이징 환경에서 검증해야 합니다. 플래너가 개선되어 힌트 없이도 최적 계획을 선택하게 될 수도 있으며, 반대로 기존 힌트가 부적절해질 수도 있기 때문입니다. 장기 유지보수 관점에서 힌트보다 통계 개선과 인덱스 설계를 통한 근본적 해결이 항상 우선입니다.

---

## 맺음말

### 핵심 요약

이 글에서는 PostgreSQL 쿼리 플래너 통계 정보의 내부 구조부터 시작해, 통계 수집 전략 수립과 실행 계획 고착 현상의 진단·해결까지 단계적으로 살펴보았습니다. 핵심을 정리하면 다음과 같습니다.

- PostgreSQL 플래너는 비용 기반 최적화(CBO)를 사용하며, `pg_statistic`의 통계가 부정확할수록 실행 계획의 품질이 저하됩니다.
- 통계 목표(`statistics_target`)는 전역이 아닌 컬럼 단위로 선별 조정해야 하며, 확장 통계(Extended Statistics)로 컬럼 간 상관관계도 반영할 수 있습니다.
- 실행 계획 고착은 `EXPLAIN (ANALYZE, BUFFERS)`의 `rows=` vs `actual rows=` 괴리로 진단하고, 통계 갱신·autovacuum 임계값 조정·`plan_cache_mode` 변경 순으로 해결합니다.
- `pg_hint_plan`은 강력하지만, 관리 복잡도와 업그레이드 위험을 고려해 근본 원인 해결이 어려울 때만 활용합니다.

### 적용 판단 기준

아래 항목 중 하나 이상이 해당된다면 인덱스 추가나 쿼리 변경보다 통계 튜닝을 먼저 검토하는 것이 우선입니다.

```
통계 튜닝 필요 여부 체크리스트
──────────────────────────────────
□ EXPLAIN ANALYZE에서 rows vs actual rows 괴리가 5배 이상
□ 중요 테이블의 last_analyze가 24시간 이상 경과
□ 대용량 배치 작업 후 특정 쿼리 성능 갑자기 저하
□ Prepared Statement 사용 환경에서 파라미터에 따라 성능 편차 큼
□ 파티션 테이블에서 특정 파티션만 느린 경우
□ 다중 컬럼 조건에서 행 수 추정 오류가 반복되는 경우
□ 인덱스가 있음에도 Seq Scan이 지속적으로 선택되는 경우
```

### 다음 단계

통계 정보 튜닝을 마친 뒤에는 관련 주제로 심화 학습을 이어갈 수 있습니다. **PostgreSQL 파티션 테이블 설계**는 파티셔닝 환경에서 파티션 제거(Partition Pruning)가 올바르게 작동하도록 통계를 유지하는 방법을 다룹니다. **`pg_stat_statements`를 활용한 쿼리 성능 모니터링**은 운영 환경에서 지속적으로 쿼리 성능을 관찰하는 체계를 갖추는 데 도움이 됩니다. 공식 문서인 [PostgreSQL Planner Statistics](https://www.postgresql.org/docs/current/planner-stats.html)와 [Row Estimation Examples](https://www.postgresql.org/docs/current/row-estimation-examples.html)는 플래너 내부 동작을 더 깊이 이해하는 데 필수 참고 자료입니다.

[관련글:PostgreSQL 인덱스 설계]
[관련글:pg_stat_statements 쿼리 성능 모니터링]
