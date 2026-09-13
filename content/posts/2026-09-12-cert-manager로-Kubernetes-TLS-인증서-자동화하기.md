---
title: "cert-manager로 Kubernetes TLS 인증서 자동화하기"
date: "2026-09-12 07:25"
publishedAt: ""
category: "DevOps"
tags: ["cert-manager로 Kubernetes TLS 인증서 자동화하기", "DevOps", "cert-manager", "Kubernetes", "TLS"]
excerpt: "Kubernetes 클러스터에서 HTTPS 서비스를 운영하다 보면 TLS 인증서 관리가 생각보다 복잡한 문제로 떠오릅니다."
status: "draft"
---

## 목차

1. 개요
2. cert-manager의 핵심 개념과 동작 원리
3. cert-manager 설치와 기본 설정
4. Certificate와 Issuer 구성 심화
5. 성능 분석과 대안 기술 비교
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 문제 배경: TLS 인증서 관리의 복잡성

Kubernetes 클러스터에서 HTTPS 서비스를 운영하다 보면 TLS 인증서 관리가 생각보다 복잡한 문제로 떠오릅니다. 서비스 수가 늘어날수록 각 도메인마다 인증서를 발급받고, 만료 전에 갱신하고, Secret 리소스에 등록하는 작업이 끊임없이 반복됩니다. Let's Encrypt 인증서의 유효 기간은 90일로 짧아서, 수십 개의 서비스를 운영하는 팀이라면 인증서 만료로 인한 장애가 언제든 발생할 수 있습니다. cert-manager는 이런 문제를 선언적 방식으로 해결하는 Kubernetes 네이티브 인증서 관리 도구입니다. 이 글에서는 cert-manager의 내부 동작 원리부터 운영 환경에서의 트레이드오프까지 체계적으로 다룹니다.

### 기존 방식의 한계: 수동 갱신과 운영 부담

전통적인 인증서 관리 방식에서는 certbot 같은 도구를 cron job으로 실행하거나, 팀원이 직접 인증서를 갱신하는 절차를 밟았습니다. 이 방식이 단일 서버 환경에서는 나름 잘 작동하지만, Kubernetes처럼 여러 네임스페이스에 걸쳐 서비스가 분산되어 있는 환경에서는 관리 포인트가 폭발적으로 늘어납니다. 갱신한 인증서를 Secret으로 Base64 인코딩하여 업로드하고, 해당 인증서를 참조하는 Ingress 또는 Gateway 리소스를 재기동하는 작업을 각 서비스마다 반복해야 합니다. 더 근본적인 문제는 이 과정이 자동화되지 않으면 언제든 실수가 발생할 수 있다는 점입니다. 실제 프로젝트 사례를 찾아보면 인증서 만료 알림을 놓쳐서 서비스가 다운된 경우를 어렵지 않게 발견할 수 있습니다. cert-manager는 이러한 수동 과정 전체를 컨트롤러가 자동으로 처리하도록 위임함으로써 운영 부담을 크게 줄입니다.

| 비교 항목 | 수동 관리 (certbot + cron) | cert-manager |
|---|---|---|
| 갱신 자동화 | 서버별 cron job 필요 | 컨트롤러가 자동 처리 |
| 멀티 네임스페이스 | 네임스페이스마다 별도 구성 | ClusterIssuer 단일 구성 |
| 갱신 실패 감지 | 수동 모니터링 필요 | Kubernetes Event·Prometheus 지원 |
| 선언적 관리 (GitOps) | 불가 | CRD 기반 GitOps 친화적 |
| 와일드카드 인증서 | DNS-01 수동 설정 복잡 | DNS Provider 플러그인 지원 |
| 학습 비용 | 낮음 | 중간 (CRD 이해 필요) |

---

## cert-manager의 핵심 개념과 동작 원리

### 핵심 아키텍처와 컨트롤러 구조

cert-manager는 Kubernetes의 컨트롤러 패턴을 충실히 따릅니다. 핵심 컴포넌트는 cert-manager 컨트롤러, cainjector, webhook 세 가지입니다. 컨트롤러는 Certificate, CertificateRequest, Order, Challenge 같은 커스텀 리소스(CRD)의 상태를 지속적으로 감시하며 desired state와 current state의 차이를 조정합니다. 이 과정이 Kubernetes의 reconciliation loop와 동일한 방식으로 동작하기 때문에, 인증서 발급이나 갱신 중 네트워크 오류가 발생하더라도 컨트롤러가 지수 백오프(exponential backoff) 전략으로 자동 재시도합니다. cainjector는 cert-manager가 관리하는 CA 번들을 ValidatingWebhookConfiguration, MutatingWebhookConfiguration, CRD에 자동으로 주입하는 역할을 담당합니다. webhook은 CRD 리소스 생성 시 유효성 검사와 기본값 설정을 수행합니다. 이 세 컴포넌트가 독립적으로 배포되기 때문에 각각 별도로 스케일링하거나 모니터링할 수 있다는 점도 운영 측면에서 유리합니다.

```
cert-manager 아키텍처 전체 구조

  ┌───────────────────────────────────────────────────┐
  │                Kubernetes API Server               │
  └─────────┬──────────────────────┬──────────────────┘
            │ Watch/Update         │ Watch/Update
  ┌─────────▼───────────────────┐  │
  │   cert-manager Controller   │  │
  │  ┌─────────────────────┐    │  │
  │  │ Certificate Ctrl    │    │  │
  │  │ CertRequest Ctrl    │    │  │
  │  │ Order Ctrl          │    │  │
  │  │ Challenge Ctrl      │    │  │
  │  └─────────────────────┘    │  │
  └──────────┬──────────────────┘  │
             │ ACME Protocol        │
  ┌──────────▼──────┐   ┌──────────▼────────────────┐
  │  ACME Server    │   │  cainjector / webhook      │
  │  (Let's Encrypt)│   │  (CA 번들 주입, 유효성 검사)│
  └─────────────────┘   └────────────────────────────┘
```

### 주요 CRD와 역할

cert-manager가 도입하는 CRD는 단순히 인증서를 담는 그릇이 아니라 인증서 발급 워크플로우 전체를 표현하는 상태 기계(state machine)입니다. Certificate 리소스는 최종 목표 상태를 선언합니다. 예를 들어 "이 도메인에 대한 인증서를 이 Secret에 저장하라"고 명시합니다. CertificateRequest는 Certificate 컨트롤러가 자동으로 생성하는 중간 리소스로, 실제 ACME 서버에 요청을 보내는 단위입니다. Order는 ACME 프로토콜의 주문 개념을 표현하며, 하나의 Order는 인증서에 포함된 도메인 수만큼 여러 개의 Challenge로 구성됩니다. Challenge는 도메인 소유권을 증명하는 실제 챌린지(HTTP-01 또는 DNS-01)를 나타냅니다. 운영 중 문제가 발생했을 때 어느 단계에서 막혔는지 빠르게 좁히려면 이 계층 구조를 이해하는 것이 필수입니다.

| CRD | 생성 주체 | 역할 | 발급 후 처리 |
|---|---|---|---|
| `Issuer` / `ClusterIssuer` | 운영자 | 인증서 발급 설정 정의 | 삭제하지 않음 |
| `Certificate` | 운영자 | 원하는 인증서 선언 | 삭제하지 않음 |
| `CertificateRequest` | Certificate 컨트롤러 | ACME 서버 요청 단위 | 발급 성공 후 보존 |
| `Order` | CertificateRequest 컨트롤러 | ACME 주문 상태 관리 | 완료 후 보존 |
| `Challenge` | Order 컨트롤러 | 도메인 소유권 증명 | 완료 후 자동 삭제 |

### 인증서 발급 흐름

실제 인증서 발급이 어떤 단계로 이루어지는지 이해하면 문제가 생겼을 때 어느 리소스를 먼저 확인해야 하는지 명확해집니다. Certificate 리소스가 생성되면 컨트롤러는 참조된 Issuer/ClusterIssuer를 확인하고 CertificateRequest를 생성합니다. ACME 방식이라면 Order가 생성되고, ACME 서버(Let's Encrypt 등)에 주문이 접수됩니다. 서버는 도메인 소유권 증명을 위한 챌린지 토큰을 내려줍니다. HTTP-01이라면 cert-manager가 클러스터 내에 임시 Pod와 Service를 생성해 챌린지를 처리하고, DNS-01이라면 DNS 공급자 API를 통해 TXT 레코드를 추가합니다. 챌린지 검증이 완료되면 ACME 서버가 서명된 인증서를 발급하고, cert-manager는 이를 지정된 Kubernetes Secret에 `tls.crt`와 `tls.key` 키로 저장합니다. Certificate 리소스의 `status.conditions`가 `Ready: True`로 변경되면 발급이 완료된 것입니다.

```
인증서 발급 단계별 흐름

  [사용자: Certificate 생성]
         │
         ▼
  [Certificate 컨트롤러: CertificateRequest 자동 생성]
         │
         ▼
  [ACME 컨트롤러: Order 생성] ──────▶ [ACME 서버: 주문 접수]
         │                                     │
         ▼                                     ▼
  [Challenge 생성]                    [챌린지 토큰 반환]
         │
         ├─ HTTP-01: 임시 Pod/Svc 생성 → 외부 HTTP 검증
         └─ DNS-01: DNS TXT 레코드 추가 → 전파 대기 후 검증
         │
         ▼
  [챌린지 성공] ─────────────────▶ [ACME 서버: 인증서 서명·발급]
         │
         ▼
  [Secret 저장: tls.crt / tls.key]
         │
         ▼
  [Certificate.status.ready = True]
```

---

## cert-manager 설치와 기본 설정

### 설치 방법 비교와 선택 기준

cert-manager를 클러스터에 설치하는 방법은 크게 세 가지입니다. 공식 YAML 매니페스트를 직접 적용하는 방식, Helm 차트를 사용하는 방식, 그리고 OperatorHub를 통한 Operator 방식입니다. 각각의 선택에는 분명한 이유가 있습니다. 공식 YAML 방식은 가장 단순하지만 커스터마이징이 어렵고, 버전 업그레이드 시 이전 버전과의 차이를 직접 추적해야 합니다. Helm 차트 방식은 `values.yaml`로 세부 설정을 선언적으로 관리할 수 있어서 GitOps 파이프라인에 통합하기 좋습니다. 특히 `installCRDs: true` 옵션 하나로 CRD 설치까지 한 번에 처리할 수 있다는 점이 편리합니다. Operator 방식은 OpenShift 환경에서 주로 사용되며, Operator 자체가 업그레이드 관리를 담당합니다. 팀의 도구 스택과 운영 정책에 따라 선택하되, 대부분의 Kubernetes 현업 환경에서는 Helm이 가장 넓게 쓰입니다.

| 설치 방식 | 장점 | 단점 | 권장 환경 |
|---|---|---|---|
| 공식 YAML | 단순, 의존성 없음 | 커스터마이징 불편, 업그레이드 복잡 | 빠른 검증용 |
| Helm | values.yaml 관리, GitOps 친화 | Helm 학습 비용 | 프로덕션, GitOps |
| OLM/Operator | 자동 업그레이드 | OpenShift 중심 | OpenShift 환경 |

Helm으로 설치할 때 주목할 설정값들이 있습니다. `global.leaderElection.namespace`는 cert-manager가 리더 선출에 사용하는 네임스페이스를 지정합니다. 기본값은 `kube-system`이지만, RBAC 정책이 엄격한 환경에서는 cert-manager 전용 네임스페이스를 지정하는 편이 권한 관리에 유리합니다. `replicaCount`를 높이면 고가용성(HA) 구성이 가능하지만, cert-manager 컨트롤러는 리더 선출 방식으로 동작하기 때문에 실제로 작업을 수행하는 인스턴스는 항상 하나입니다. 나머지 인스턴스는 리더 장애 시 빠르게 인수인계받기 위한 대기 상태로 존재합니다.

### Let's Encrypt Issuer와 Certificate 설정

Let's Encrypt를 사용하는 ClusterIssuer를 설정할 때 가장 먼저 결정해야 할 것은 스테이징 서버와 프로덕션 서버 중 어느 것을 먼저 사용할지입니다. Let's Encrypt 프로덕션 서버는 도메인당 주당 50개의 인증서 발급 한도가 있습니다. 개발이나 테스트 단계에서 설정을 잘못하여 발급 실패를 반복하다 보면 이 한도에 걸릴 수 있습니다. 따라서 스테이징 서버로 먼저 워크플로우를 검증한 뒤 프로덕션으로 전환하는 것이 안전합니다. 스테이징 서버가 발급하는 인증서는 신뢰할 수 없는 CA가 서명하기 때문에 브라우저에서 경고가 뜨지만, cert-manager의 동작을 검증하는 데는 충분합니다. 스테이징 ClusterIssuer와 프로덕션 ClusterIssuer를 함께 선언해두고, Certificate 리소스의 `issuerRef`만 바꿔서 전환하는 패턴이 일반적입니다.

다음은 HTTP-01 챌린지 방식의 ClusterIssuer와 이를 참조하는 Certificate 리소스를 정의하는 예시입니다. Nginx Ingress 기반 클러스터에서 가장 일반적으로 사용하는 구성입니다.

```yaml
# clusterissuer-prod.yaml — 프로덕션 Let's Encrypt ClusterIssuer
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com          # 만료 알림 수신 이메일
    privateKeySecretRef:
      name: letsencrypt-prod-key    # ACME 계정 키가 저장되는 Secret
    solvers:
    - http01:
        ingress:
          class: nginx              # 사용 중인 Ingress 컨트롤러 class명
---
# certificate-api.yaml — api.example.com 인증서 선언
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: production
spec:
  secretName: api-tls-secret       # 발급된 인증서가 저장될 Secret 이름
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - api.example.com
  - www.api.example.com
  duration: 2160h                  # 90일 (Let's Encrypt 기본값)
  renewBefore: 360h                # 만료 15일 전 갱신 시작
  privateKey:
    algorithm: ECDSA               # RSA 대비 키 크기 작고 성능 우수
    size: 256
```

위 구성에서 `renewBefore`는 매우 중요한 파라미터입니다. cert-manager는 인증서 만료 `renewBefore` 시간 전에 자동 갱신을 시작합니다. Let's Encrypt의 90일 인증서라면 `360h`(15일) 정도가 적절하며, 갱신 시도에 실패하더라도 15일의 여유 시간이 있어서 운영팀이 개입할 시간을 확보할 수 있습니다. 너무 짧게 설정하면 갱신 실패 시 즉각적인 장애로 이어질 수 있고, 너무 길게 설정하면 인증서를 불필요하게 자주 갱신해서 발급 한도에 근접할 수 있습니다. `privateKey.algorithm`을 `ECDSA`로 설정하면 RSA 2048 대비 키 크기가 작고 TLS 핸드셰이크 성능이 좋아집니다.

### Certificate 리소스와 Ingress 연동 방식

Certificate 리소스를 올바르게 정의하는 것만큼 중요한 것이 Ingress 리소스와의 연동 방식을 이해하는 것입니다. cert-manager는 두 가지 방식으로 Ingress와 연동됩니다. 첫 번째는 Certificate 리소스를 명시적으로 생성하는 방식이고, 두 번째는 Ingress 리소스에 `cert-manager.io/cluster-issuer` 어노테이션을 추가하면 cert-manager가 자동으로 Certificate를 생성하는 방식입니다. 후자가 간편해 보이지만, Certificate의 세부 설정(`duration`, `renewBefore`, `privateKey` 알고리즘 등)을 제어하기 어렵다는 단점이 있습니다. 운영 환경에서는 Certificate 리소스를 명시적으로 선언하는 방식이 설정의 투명성과 감사 추적 측면에서 더 유리합니다. GitOps 저장소에 Certificate 리소스를 함께 관리하면 인증서 설정의 변경 이력을 추적하고, 클러스터 재구성 시 일관성을 유지할 수 있습니다.

> Certificate 리소스를 GitOps 저장소로 관리하면 인증서 설정 변경 이력이 Git log로 남아 감사와 복구가 쉬워집니다. Ingress 어노테이션 방식은 설정 가시성이 낮습니다.

---

## Certificate와 Issuer 구성 심화

### ClusterIssuer vs Issuer 선택 기준

Issuer와 ClusterIssuer의 차이는 단순히 적용 범위의 차이가 아닙니다. 이 선택이 네임스페이스 격리 정책, RBAC 설계, 멀티 테넌트 운영 방식에 직접적인 영향을 미칩니다. Issuer는 네임스페이스 스코프 리소스입니다. 특정 네임스페이스에 속한 Certificate만 해당 Issuer를 참조할 수 있습니다. 이 방식은 팀별로 네임스페이스가 분리된 멀티 테넌트 환경에서 각 팀이 자체 ACME 계정이나 CA를 사용해야 할 때 적합합니다. 반면 ClusterIssuer는 클러스터 전체에서 참조 가능합니다. 단일 Let's Encrypt 계정으로 클러스터 전체의 인증서를 관리할 때 ClusterIssuer를 사용하면 중복 설정 없이 일관된 발급 정책을 유지할 수 있습니다. 대부분의 단일 팀 운영 환경에서는 ClusterIssuer가 선호됩니다.

| 항목 | Issuer | ClusterIssuer |
|---|---|---|
| 스코프 | 네임스페이스 한정 | 클러스터 전체 |
| ACME 계정 분리 | 팀/네임스페이스별 가능 | 단일 공유 계정 |
| 적합한 환경 | 멀티 테넌트, 팀별 격리 | 단일 팀, 통합 관리 |
| 관리 복잡도 | 네임스페이스 수만큼 증가 | 단일 구성 유지 |
| RBAC 세분화 | 가능 (네임스페이스 단위) | 제한적 (클러스터 단위) |

### DNS-01 챌린지와 HTTP-01 챌린지 비교

챌린지 방식 선택은 인프라 구성과 보안 정책에 따라 달라집니다. HTTP-01 챌린지는 cert-manager가 `.well-known/acme-challenge/` 경로에 임시 응답을 제공하는 방식입니다. 구성이 단순하고 별도의 DNS API 권한이 필요 없다는 장점이 있지만, 챌린지를 수행하는 동안 외부에서 해당 경로에 HTTP로 접근할 수 있어야 합니다. 즉, 인터넷에 노출되지 않는 내부 전용 도메인이나 방화벽 뒤에 있는 서비스에는 사용할 수 없습니다. 또한 와일드카드 인증서(`*.example.com`)는 HTTP-01 챌린지로 발급할 수 없습니다. ACME 사양상 와일드카드 인증서는 반드시 DNS-01 챌린지를 통해서만 발급 가능합니다.

DNS-01 챌린지는 도메인의 DNS에 특정 TXT 레코드를 추가해 소유권을 증명합니다. 외부 HTTP 접근이 불필요하기 때문에 내부 서비스에도 사용할 수 있고 와일드카드 인증서도 발급할 수 있습니다. 단점은 DNS 공급자 API 키를 Kubernetes Secret으로 관리해야 한다는 점과, DNS 변경이 전파되는 데 시간이 걸린다는 점입니다. cert-manager는 AWS Route 53, Cloudflare, Google Cloud DNS, Azure DNS 등 주요 DNS 공급자용 솔버를 내장하고 있습니다. 클라우드 환경에서는 IRSA(IAM Roles for Service Accounts)나 Workload Identity를 활용해서 API 키 없이 IAM 권한으로 DNS를 제어하는 방식이 보안 측면에서 더 안전합니다.

| 항목 | HTTP-01 | DNS-01 |
|---|---|---|
| 외부 인터넷 접근 필요 | 필수 (포트 80) | 불필요 |
| 와일드카드 인증서 | ✗ | ✓ |
| 내부 전용 도메인 | ✗ | ✓ |
| DNS API 권한 | 불필요 | 필수 |
| 발급 소요 시간 | 빠름 (1~3분) | DNS 전파 포함 (5~15분) |
| 설정 복잡도 | 낮음 | 중간~높음 |
| 클라우드 IAM 연동 | 해당 없음 | IRSA / Workload Identity 가능 |

### 와일드카드 인증서와 SAN 설정

와일드카드 인증서를 사용할 때 한 가지 주의할 점이 있습니다. `*.example.com` 형식의 와일드카드는 한 단계 서브도메인만 커버합니다. `api.example.com`은 포함되지만 `v1.api.example.com`은 포함되지 않습니다. 여러 레벨의 서브도메인을 커버하려면 각 레벨마다 별도의 와일드카드 항목을 추가하거나, SAN(Subject Alternative Names)에 개별 도메인을 명시해야 합니다. cert-manager의 Certificate 리소스에서 `dnsNames` 배열에 여러 도메인을 나열하면 하나의 인증서에 여러 SAN이 포함됩니다. 이 방식은 도메인 수가 적을 때는 편리하지만, 도메인이 많아질수록 Certificate 리소스 관리가 복잡해집니다. 운영 환경에서는 도메인 그룹을 논리적으로 나누어 Certificate를 분리 관리하는 편이 유지보수에 유리합니다. 예를 들어 퍼블릭 API용, 내부 서비스용, 어드민 패널용으로 Certificate를 구분하는 방식이 흔하게 사용됩니다.

> 와일드카드 인증서는 관리 편의성과 보안 리스크 사이의 균형을 고려해야 합니다. 와일드카드 개인 키가 유출되면 해당 도메인의 모든 서브도메인에 영향을 미치므로, Secret 접근 권한을 엄격하게 관리해야 합니다.

---

## 성능 분석과 대안 기술 비교

### 성능 특성과 자원 사용량

cert-manager 컨트롤러의 자원 사용량은 관리하는 인증서 수와 갱신 빈도에 비례합니다. 일반적인 중소 규모 클러스터에서 cert-manager 컨트롤러는 CPU 10~50m, 메모리 64~256Mi 정도를 사용합니다. 수백 개의 인증서를 동시에 관리하는 대규모 환경에서는 메모리 사용량이 더 증가할 수 있습니다. 특히 일시적으로 많은 Certificate 갱신이 집중되는 상황(클러스터 마이그레이션 직후나 대규모 인프라 교체 시)에서는 ACME 서버의 레이트 리밋에 걸리지 않도록 주의해야 합니다. Let's Encrypt는 IP당 분당 20회, 도메인당 주당 50개의 인증서 발급 한도를 적용합니다. cert-manager가 처리하는 워크로드 대부분은 I/O 바운드입니다. ACME 서버와의 HTTP 통신, DNS API 호출, Kubernetes API 서버 업데이트가 주를 이루기 때문에, CPU 리소스보다 네트워크 레이턴시와 Kubernetes API 서버의 응답 속도가 전체 인증서 발급 시간에 더 큰 영향을 미칩니다.

| 지표 | 소규모 (50개 미만) | 대규모 (200개 이상) | 주의 임계치 |
|---|---|---|---|
| CPU 사용량 | 10~30m | 50~100m | 200m 초과 시 조사 필요 |
| 메모리 사용량 | 64~128Mi | 128~256Mi | 512Mi 초과 시 조사 필요 |
| HTTP-01 발급 시간 | 1~2분 | 1~3분 | 5분 초과 시 챌린지 실패 의심 |
| DNS-01 발급 시간 | 5~10분 | 5~15분 | 30분 초과 시 DNS 전파 문제 의심 |
| 동시 갱신 가능 수 | 제한 없음 | 레이트 리밋 고려 | 주당 50개 한도 유의 |

### 대안 기술과 비교

cert-manager 외에도 Kubernetes 환경에서 TLS 인증서를 관리하는 방법은 여러 가지가 있습니다. 각각의 접근법은 서로 다른 요구사항에 최적화되어 있습니다.

**Traefik 내장 인증서 관리**는 Traefik Ingress 컨트롤러를 사용한다면 별도의 cert-manager 없이도 자동 인증서 갱신이 가능합니다. 그러나 Traefik이 인증서 상태를 파일 시스템이나 KV 스토어에 저장하기 때문에, 여러 Traefik 인스턴스 간 인증서 공유 문제가 발생하기 쉽습니다. 또한 cert-manager처럼 다양한 Issuer 유형(자체 서명, Vault, Venafi 등)을 지원하지 않습니다.

**HashiCorp Vault PKI**는 내부 CA를 운영하거나 기업용 PKI 인프라가 있는 환경에서 Vault PKI 시크릿 엔진을 사용하는 것이 좋습니다. cert-manager는 Vault를 Issuer로 사용할 수 있기 때문에 두 도구를 결합하는 것도 충분히 가능합니다. Vault가 인증서 정책과 만료 관리를 담당하고, cert-manager는 Kubernetes 내에서 인증서 생명주기를 관리하는 역할을 맡는 구성은 엔터프라이즈 환경에서 자주 사용됩니다.

**클라우드 공급자 관리형 서비스**(AWS ACM, GCP Certificate Manager 등)는 해당 클라우드의 로드 밸런서나 CDN과 긴밀하게 통합됩니다. Kubernetes 내부에서 직접 TLS를 종료하지 않고 로드 밸런서 레벨에서 처리하는 아키텍처라면 이 방식이 운영 부담이 적습니다. 단, Kubernetes Pod나 Service가 직접 TLS를 처리해야 하는 경우에는 적합하지 않습니다.

| 도구 | 적합한 환경 | 멀티 Issuer 지원 | Kubernetes 네이티브 | 자체 CA 지원 |
|---|---|---|---|---|
| cert-manager | 범용, 멀티 Issuer | ✓ | ✓ | ✓ |
| Traefik 내장 | Traefik 단독 환경 | ✗ | 제한적 | ✗ |
| Vault PKI | 엔터프라이즈 PKI | cert-manager 연동 | cert-manager 연동 | ✓ |
| AWS ACM | AWS 전용, LB 레벨 TLS | ✗ | ✗ | ✗ |

### 기술 선택 기준

cert-manager가 가장 빛을 발하는 상황은 다양한 Issuer를 혼합해서 사용해야 하거나, 여러 팀이 동일한 클러스터를 공유하는 멀티 테넌트 환경입니다. 인프라를 코드로 관리하는 GitOps 환경에서도 Certificate CRD가 YAML로 선언되기 때문에 자연스럽게 통합됩니다. 반면 단일 Ingress 컨트롤러를 사용하는 소규모 환경이라면 해당 컨트롤러의 내장 인증서 관리 기능으로도 충분할 수 있습니다. 기업 환경에서 내부 PKI와 통합이 필요하다면 cert-manager와 Vault를 함께 사용하는 구성이 유력한 선택지입니다. 순전히 퍼블릭 클라우드 로드 밸런서를 통해 TLS를 종료하는 아키텍처라면 클라우드 공급자의 관리형 서비스가 운영 부담이 적습니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

cert-manager를 처음 도입할 때 가장 자주 발생하는 문제는 챌린지 검증 실패입니다. HTTP-01 챌린지의 경우, 외부에서 `http://도메인/.well-known/acme-challenge/` 경로에 접근할 수 없으면 챌린지가 실패합니다. 이 문제는 Ingress 컨트롤러 설정에서 해당 경로로 들어오는 트래픽을 cert-manager의 solver Pod로 정확히 라우팅하지 않을 때 발생합니다. Nginx Ingress를 사용한다면 `cert-manager.io/cluster-issuer` 어노테이션이 붙은 Ingress에 자동으로 설정이 추가되지만, 커스텀 Nginx 설정이나 별도의 리버스 프록시가 앞단에 있다면 라우팅 규칙을 직접 확인해야 합니다.

또 다른 흔한 실수는 스테이징 검증 없이 바로 프로덕션 Issuer를 사용하는 것입니다. Let's Encrypt 프로덕션의 레이트 리밋은 생각보다 빠르게 소진됩니다. 특히 클러스터를 처음 구성하면서 설정 오류로 인해 발급-실패-재시도를 반복하다 보면 레이트 리밋에 걸릴 수 있습니다. 레이트 리밋은 최대 1주일까지 지속될 수 있어서, 운영 중인 서비스에 영향을 줄 수도 있습니다. 네임스페이스 간 Secret 참조 문제도 주의가 필요합니다. cert-manager가 생성하는 인증서 Secret은 Certificate 리소스와 동일한 네임스페이스에 생성됩니다. 다른 네임스페이스의 Ingress에서 이 Secret을 참조하려면 Secret을 복사하거나, kubernetes-replicator 같은 도구를 사용해서 자동으로 동기화해야 합니다.

> ClusterIssuer를 사용하더라도 발급된 인증서 Secret은 Certificate 리소스가 위치한 네임스페이스에만 생성됩니다. Secret은 클러스터 범위 리소스가 아닙니다.

### 모니터링과 디버깅

cert-manager는 Prometheus 메트릭을 기본으로 제공합니다. 운영 환경에서 반드시 모니터링해야 할 주요 메트릭은 `certmanager_certificate_expiration_timestamp_seconds`입니다. 이 메트릭으로 각 인증서의 만료 시각을 추적하고, 만료가 임박한 인증서에 대해 알람을 설정할 수 있습니다. `certmanager_certificate_ready_status`는 각 인증서의 현재 준비 상태를 나타냅니다. 값이 1이면 정상, 0이면 문제가 있는 상태입니다.

인증서 발급이 예상대로 진행되지 않을 때는 단계적으로 리소스를 확인하는 접근법이 효율적입니다. `kubectl describe certificate <이름>` 명령을 실행하면 현재 상태와 이벤트 목록을 볼 수 있습니다. 상태가 `False`이거나 이유 코드가 표시되면, 그 이유를 따라 CertificateRequest, Order, Challenge 리소스를 순서대로 확인합니다. Challenge 리소스까지 내려가면 실제 챌린지 URL과 ACME 서버로부터 받은 실패 메시지를 확인할 수 있어서 정확한 원인을 파악할 수 있습니다. 아래는 인증서 문제 발생 시 진단에 활용하는 kubectl 명령 시퀀스입니다.

```bash
# 1단계: Certificate 상태와 이벤트 확인
kubectl describe certificate api-tls -n production

# 2단계: 연결된 CertificateRequest 확인
kubectl get certificaterequest -n production
kubectl describe certificaterequest api-tls-xxxxx -n production

# 3단계: Order 상태 확인
kubectl get order -n production
kubectl describe order api-tls-xxxxx-xxxxxxxx -n production

# 4단계: Challenge 상태와 오류 메시지 확인
kubectl get challenge -n production
kubectl describe challenge api-tls-xxxxx-xxxxxxxx-xxxxxxxx -n production

# cert-manager 컨트롤러 로그에서 상세 오류 확인
kubectl logs -n cert-manager deploy/cert-manager --tail=100 | grep ERROR
```

위 진단 순서를 따르면 대부분의 인증서 발급 실패 원인을 10분 내에 찾을 수 있습니다. 가장 많이 발생하는 오류 유형은 챌린지 HTTP 응답 코드 불일치(404, 503), DNS TXT 레코드 전파 미완료, ACME 서버 레이트 리밋 초과, 그리고 Issuer에 설정된 계정 키 Secret 불일치입니다.

| Prometheus 메트릭 | 의미 | 권장 알람 기준 |
|---|---|---|
| `certmanager_certificate_expiration_timestamp_seconds` | 인증서 만료 시각 | 현재 시각 기준 15일 이내이면 경고 |
| `certmanager_certificate_ready_status` | Ready 상태 (1=정상, 0=문제) | 0이 30분 이상 지속되면 알람 |
| `certmanager_http_acme_client_request_count` | ACME API 요청 수 | 급증 시 레이트 리밋 근접 의심 |
| `certmanager_controller_sync_call_count` | 컨트롤러 동기화 호출 수 | 비정상 급증 시 조사 필요 |

### 확장과 마이그레이션

cert-manager 버전을 업그레이드할 때는 CRD 변경 사항을 반드시 확인해야 합니다. cert-manager는 주요 마이너 버전(v1.x)에서 CRD API 스펙이 변경될 수 있습니다. Helm으로 관리한다면 `helm upgrade` 전에 CRD를 먼저 업그레이드하는 것이 권장 순서입니다. cert-manager 공식 문서의 업그레이드 노트에는 버전별 변경 사항과 주의사항이 상세하게 제공되므로, 업그레이드 전 반드시 확인해야 합니다.

기존 클러스터에서 이미 수동으로 관리하던 인증서를 cert-manager로 마이그레이션하는 경우, 기존 Secret의 이름을 Certificate 리소스의 `secretName`과 동일하게 설정하면 cert-manager가 해당 Secret을 인수하여 관리를 시작합니다. 이때 인증서 만료 시점이 도래하면 cert-manager가 자동으로 갱신합니다. 마이그레이션 직후에는 기존 인증서와 cert-manager가 발급하는 새 인증서 사이에 일시적인 불일치가 생길 수 있으므로, 첫 갱신 주기를 주의 깊게 모니터링하는 것이 좋습니다. 다중 클러스터 환경에서 인증서를 공유해야 하는 경우에는 cert-manager가 직접 지원하는 기능이 아닙니다. 이런 상황에서는 각 클러스터에 독립적으로 cert-manager를 구성하거나, 중앙 Vault에서 인증서를 발급하고 External Secrets Operator로 각 클러스터에 배포하는 방식을 고려할 수 있습니다.

---

## 맺음말

### 핵심 요약

cert-manager는 Kubernetes 환경에서 TLS 인증서 생명주기를 선언적으로 관리하는 도구입니다. ACME 프로토콜을 통한 Let's Encrypt 연동, 자체 서명 인증서, HashiCorp Vault, Venafi 등 다양한 인증서 소스를 단일 프레임워크로 통합합니다. Certificate, Issuer, ClusterIssuer, Order, Challenge로 구성된 CRD 계층은 인증서 발급 워크플로우 전체를 Kubernetes 리소스로 표현합니다. 이를 통해 GitOps 파이프라인에 인증서 관리를 자연스럽게 통합할 수 있습니다. HTTP-01과 DNS-01 두 가지 챌린지 방식의 차이를 이해하고 상황에 맞게 선택하는 것, 그리고 `renewBefore` 같은 파라미터를 적절히 조정하는 것이 안정적인 인증서 자동화의 핵심입니다.

### 적용 판단 기준

cert-manager 도입을 결정할 때 다음 기준을 참고하면 좋습니다. 관리해야 할 TLS 인증서가 5개 이상이고 갱신 자동화가 필요하다면 cert-manager의 도입 효과가 큽니다. 여러 Issuer 유형을 혼합해야 하거나, 여러 팀이 동일한 클러스터를 공유하는 멀티 테넌트 환경이라면 cert-manager의 CRD 기반 설계가 명확한 이점을 제공합니다. 반면 단일 Ingress 컨트롤러를 사용하는 소규모 환경이거나, 퍼블릭 클라우드 로드 밸런서에서 TLS를 완전히 종료하는 아키텍처라면 더 간단한 대안이 적합할 수 있습니다.

| 도입 권장 상황 | 대안 검토 상황 |
|---|---|
| 인증서 5개 이상 관리 필요 | 단일 Ingress 컨트롤러 내장 기능으로 충분 |
| 멀티 Issuer (ACME + Vault 등) 혼용 | 퍼블릭 클라우드 L7 LB에서 TLS 종료 |
| GitOps로 인증서 설정 이력 관리 | 소규모, 단순 환경 |
| 내부 CA 또는 기업 PKI 연동 필요 | 인증서 수가 매우 적음 (3개 미만) |
| 멀티 테넌트 클러스터 | 단일 Ingress 클래스만 사용 |
