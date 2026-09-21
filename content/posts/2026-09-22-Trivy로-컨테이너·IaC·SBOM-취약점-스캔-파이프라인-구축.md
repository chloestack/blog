---
title: "Trivy로 컨테이너·IaC·SBOM 취약점 스캔 파이프라인 구축"
date: "2026-09-22 02:48"
publishedAt: ""
category: "DevOps"
tags: ["Trivy", "DevSecOps", "컨테이너보안", "SBOM", "IaC보안"]
excerpt: "보안 취약점은 이제 개발 마지막 단계에서 발견되면 너무 늦습니다. 컨테이너 이미지에 포함된 베이스 OS 패키지, 애플리케이션 의존성, Terraform·Kubernetes 매니페스트의 보안 설정 오류는 운영 환경에서 치명적인 침해 사…"
status: "draft"
---

## 목차

1. 개요
2. Trivy 스캔 범위와 핵심 구조
3. 컨테이너 이미지 취약점 스캔
4. IaC 코드 보안 점검
5. SBOM 생성과 의존성 추적
6. CI/CD 파이프라인 통합
7. 운영 환경 고려사항
8. 맺음말

---

## 개요

### 문제 배경

보안 취약점은 이제 개발 마지막 단계에서 발견되면 너무 늦습니다. 컨테이너 이미지에 포함된 베이스 OS 패키지, 애플리케이션 의존성, Terraform·Kubernetes 매니페스트의 보안 설정 오류는 운영 환경에서 치명적인 침해 사고로 이어질 수 있습니다. **Trivy**는 Aqua Security가 개발한 오픈소스 취약점 스캐너로, 컨테이너 이미지·파일시스템·Git 리포지터리·IaC 코드·SBOM까지 단일 도구로 검사할 수 있어 DevSecOps 파이프라인에서 널리 채택되고 있습니다. 이 글에서는 Trivy의 핵심 구조를 파악하고, 컨테이너 이미지·IaC·SBOM 스캔을 GitHub Actions에 통합하는 현실적인 방법을 살펴봅니다.

---

### 기존 방식의 한계

기존에는 취약점 스캔 도구가 역할별로 분산되어 있었습니다. 컨테이너 이미지는 Clair나 Anchore, IaC는 Checkov나 tfsec, 의존성 추적은 별도의 SCA(Software Composition Analysis) 도구를 각각 운용해야 했습니다. 도구마다 설정 방식이 다르고, 취약점 데이터베이스 업데이트 주기도 달라 팀이 관리해야 할 운영 부담이 가중됩니다. 특히 SBOM(Software Bill of Materials) 표준이 미국 CISA와 EU CRA 규제에서 의무화 방향으로 가고 있는 상황에서, SBOM 생성과 취약점 스캔을 연계하지 못하면 규정 준수 보고서를 수작업으로 만들어야 합니다.

Trivy는 이 문제를 하나의 바이너리로 해결합니다. OS 패키지(Alpine, Debian, RHEL), 언어별 패키지(npm, pip, Maven, Gradle, Go modules), IaC 설정(Terraform, CloudFormation, Kubernetes, Dockerfile), 시크릿까지 스캔하며, CycloneDX·SPDX 형식의 SBOM을 직접 생성하거나 입력으로 받아 취약점을 교차 조회합니다.

---

## Trivy 스캔 범위와 핵심 구조

### 동작 원리

Trivy는 스캔 대상을 **타겟(target)**과 **스캐너(scanner)** 두 축으로 구분합니다. 타겟은 무엇을 스캔할지(이미지, 파일시스템, 리포지터리, SBOM 파일 등)를 결정하고, 스캐너는 어떤 방식으로 분석할지(취약점, 설정 오류, 시크릿, 라이선스)를 결정합니다. 이 두 축의 조합으로 다양한 시나리오를 커버합니다.

내부적으로 Trivy는 세 가지 취약점 데이터베이스를 참조합니다. **NVD(National Vulnerability Database)**와 각 Linux 배포판별 어드바이저리, 그리고 GitHub Advisory Database를 병합한 **trivy-db**가 핵심입니다. 스캔 시 이 DB를 로컬에 캐시하며, 기본 24시간 간격으로 갱신합니다. CI 환경에서 네트워크 제한이 있다면 미리 빌드한 DB 이미지를 air-gapped 환경에 배포하는 방식도 지원합니다.

```diagram
2026-09-22-98ddabe9-01
```

타겟과 스캐너의 조합이 Trivy의 유연성을 만들며, 단일 명령어로 여러 스캐너를 동시에 실행할 수 있습니다.

---

### 주요 구성 요소

Trivy의 구성 요소를 이해하면 설정 파일을 체계적으로 작성할 수 있습니다. **trivy-db**는 취약점 데이터베이스로 OCI 이미지 형태로 배포되며, `ghcr.io/aquasecurity/trivy-db`에서 내려받습니다. **trivy-checks**는 IaC 설정 오류를 검사하는 Rego 정책 집합으로, 별도로 업데이트할 수 있습니다. **VEX(Vulnerability Exploitability eXchange)** 문서를 활용하면 이미 분석한 취약점에 대해 "영향 없음" 판정을 기록해 재스캔 시 노이즈를 줄일 수 있습니다.

| 구성 요소 | 역할 | 업데이트 주기 | 오프라인 지원 |
|---|---|---|---|
| trivy-db | OS·언어 취약점 DB | 기본 24시간 | OCI 이미지 미러 |
| trivy-checks | IaC Rego 정책 | 별도 관리 | 로컬 정책 경로 지정 |
| VEX 문서 | 취약점 판정 기록 | 수동 관리 | 로컬 파일 |
| Java DB | Maven·Gradle 전용 | trivy-db와 연동 | 별도 캐시 |

---

### 데이터 흐름

스캔 요청이 들어오면 Trivy는 먼저 로컬 DB 캐시를 확인하고, 만료됐으면 업데이트합니다. 그다음 타겟을 분석해 패키지 목록(SBOM에 해당하는 내부 표현)을 추출하고, 이를 DB와 대조해 CVE 목록을 생성합니다. 심각도 필터와 무시 규칙(`.trivyignore`)을 적용한 뒤 지정한 포맷(table, JSON, SARIF, CycloneDX)으로 결과를 출력합니다.

```diagram
2026-09-22-98ddabe9-02
```

DB 업데이트와 스캔이 분리되어 있어, CI에서 DB를 사전 캐시하면 스캔 시간을 수십 초 단축할 수 있습니다.

---

## 컨테이너 이미지 취약점 스캔

### 기본 설정과 스캔 전략

컨테이너 이미지 스캔은 Trivy의 가장 기본적인 사용 사례입니다. 이미지를 빌드한 뒤 레지스트리에 푸시하기 전에 스캔하는 것이 원칙이며, 이미 레지스트리에 올라간 이미지도 주기적으로 재스캔해야 합니다. 처음 도입할 때 흔히 저지르는 실수는 `CRITICAL` 심각도만 차단하고 나머지는 무시하는 정책입니다. `HIGH` 등급 취약점도 CVSS 점수 7점 이상이면 실제 공격에 활용된 사례가 많으므로, 정책을 수립할 때 심각도 외에 **실제 EPSS 점수(익스플로잇 가능성)**와 **픽스 유무**를 조건으로 함께 고려해야 합니다.

베이스 이미지 선택도 취약점 수에 큰 영향을 미칩니다. `ubuntu:22.04`와 같은 범용 이미지는 수백 개의 OS 패키지를 포함해 취약점 노이즈가 많은 반면, `alpine:3.19`나 `distroless` 계열 이미지는 최소한의 패키지만 포함합니다. 단, `distroless`는 쉘이 없어 디버깅이 어렵고, Alpine은 musl libc를 사용해 일부 C 라이브러리 의존 애플리케이션에서 예기치 않은 동작이 나올 수 있습니다. 이 트레이드오프를 팀에서 인지한 상태에서 베이스 이미지를 선택해야 합니다.

아래 예시는 Trivy 설정 파일을 활용해 일관된 스캔 정책을 적용하는 방법입니다. 명령줄 플래그 대신 `trivy.yaml`을 사용하면 CI와 로컬 개발 환경에서 동일한 설정을 보장합니다.

```yaml
# trivy.yaml — 프로젝트 루트에 위치
image:
  removed-pkgs: true        # 삭제된 패키지도 스캔
scan:
  scanners:
    - vuln
    - secret
  skip-dirs:
    - node_modules
    - .git
vulnerability:
  type:
    - os
    - library
  ignore-unfixed: false      # 픽스 없는 취약점도 보고
severity:
  - CRITICAL
  - HIGH
  - MEDIUM
format: json
output: trivy-results.json
```

설정 파일을 리포지터리에 커밋해 두면, `trivy image --config trivy.yaml myapp:latest` 한 줄로 일관된 스캔을 실행할 수 있습니다. `ignore-unfixed: false`를 유지하는 이유는, 픽스가 없는 취약점도 인지하고 있어야 베이스 이미지 교체 시점을 판단할 수 있기 때문입니다.

---

### 레이어별 취약점 분석

Trivy는 `--format table` 출력에서 각 취약점이 **어느 패키지**에서 비롯됐는지 보여주지만, **어느 Dockerfile 레이어**에서 도입됐는지는 기본적으로 표시하지 않습니다. `trivy image --format json`으로 출력한 결과에서 `Layer.DiffID` 필드를 보면 레이어 해시를 확인할 수 있고, `docker history`와 대조하면 어떤 `RUN` 지시어가 문제의 패키지를 설치했는지 추적할 수 있습니다.

```diagram
2026-09-22-98ddabe9-03
```

레이어 분석을 통해 베이스 이미지에서 비롯된 취약점인지, 애플리케이션 의존성에서 비롯된 취약점인지를 구분하면 대응 우선순위를 더 정확하게 설정할 수 있습니다.

---

### 무시 규칙과 VEX 활용

`.trivyignore` 파일은 취약점 ID나 패키지명을 기반으로 스캔 결과에서 특정 항목을 제외합니다. 단순한 억제(suppression) 방식이라 이유를 기록할 수 없다는 단점이 있습니다. 보다 구조화된 방식은 **VEX(Vulnerability Exploitability eXchange)** 문서를 사용하는 것입니다. VEX는 "이 취약점은 우리 컨텍스트에서 영향 없음(not_affected)이며, 그 이유는 X"처럼 판정 근거를 기계 가독 형식으로 기록합니다. Trivy는 OpenVEX 형식의 VEX 파일을 `--vex` 옵션으로 전달받아 결과 필터링에 활용합니다.

> 규제 환경에서 취약점 예외 처리를 감사 추적해야 한다면 `.trivyignore` 대신 VEX 문서를 사용하십시오. 판정 근거와 유효 기간이 기계 가독 형태로 남기 때문입니다.

무시 항목에 만료일 주석(`# trivy:ignore:CVE-XXXX -- expires 2025-03-01`)을 추가하는 습관을 팀에 정착시키거나, VEX 문서로 이유와 기한을 명시하는 방식으로 관리하면 파일이 불투명해지는 문제를 예방할 수 있습니다.

---

## IaC 코드 보안 점검

### Terraform·Kubernetes 설정 오류 탐지

IaC 스캔은 인프라 코드가 배포되기 전에 보안 오류를 잡는 **Shift-Left** 접근의 핵심입니다. Trivy의 `--scanners misconfig` 옵션은 Terraform, CloudFormation, Kubernetes 매니페스트, Helm 차트, Dockerfile의 설정 오류를 Rego 정책으로 검사합니다. 예를 들어 S3 버킷의 퍼블릭 액세스 차단이 꺼져 있거나, Kubernetes Pod가 `privileged: true`로 실행되거나, Dockerfile에서 루트 사용자로 실행되는 케이스를 탐지합니다.

기존에 tfsec이나 Checkov를 사용하고 있었다면 Trivy로 이전할 때 몇 가지 차이를 인지해야 합니다. tfsec은 Terraform 전용이고 Go 기반 정책을 사용하는 반면, Trivy는 CNCF의 OPA(Open Policy Agent)가 채택한 Rego 언어로 정책을 작성해 커스텀 확장이 용이합니다. Checkov는 Python 기반 정책으로 AWS 서비스 커버리지가 넓지만, Trivy와 함께 쓰면 도구 수가 늘어납니다. 이미 Trivy를 이미지 스캔에 사용하고 있다면 IaC 스캔도 Trivy로 통합하는 것이 운영 부담을 줄이는 선택입니다.

| 도구 | 주요 대상 | 정책 언어 | Trivy와의 관계 |
|---|---|---|---|
| tfsec | Terraform 전용 | Go 내장 규칙 | Trivy로 통합 가능 |
| Checkov | Terraform·K8s·CF | Python | AWS 커버리지 우수 |
| Trivy misconfig | Terraform·K8s·CF·Helm | Rego | 이미지 스캔과 통합 |
| kube-score | Kubernetes 전용 | Go 내장 규칙 | 보완 사용 가능 |

```diagram
2026-09-22-98ddabe9-04
```

심각도에 따라 경고와 파이프라인 차단을 구분하면, 개발 생산성을 유지하면서도 고위험 설정 오류는 즉시 막을 수 있습니다.

---

### 커스텀 Rego 정책 작성

조직 내부의 보안 정책은 Trivy가 제공하는 기본 정책으로는 커버되지 않을 수 있습니다. 예를 들어 "모든 Kubernetes Deployment는 `securityContext.runAsNonRoot: true`를 명시해야 한다"는 팀 규칙을 강제하려면 커스텀 Rego 정책을 작성해야 합니다.

```rego
# policies/require_non_root.rego
package user.kubernetes.deployment

__rego_metadata__ := {
  "id":          "CUSTOM-K8S-001",
  "title":       "컨테이너는 비루트 사용자로 실행해야 합니다",
  "severity":    "HIGH",
  "description": "runAsNonRoot가 true가 아니면 컨테이너가 root로 실행될 수 있습니다",
}

__rego_input__ := {
  "combine": false,
  "selector": [{"type": "kubernetes"}],
}

deny[msg] {
  container := input.spec.template.spec.containers[_]
  not container.securityContext.runAsNonRoot == true
  msg := sprintf(
    "컨테이너 '%s'에 runAsNonRoot: true 설정이 없습니다",
    [container.name]
  )
}
```

이 파일을 `policies/` 디렉터리에 저장하고 `trivy config --policy policies/ --namespaces user k8s/`와 같이 실행하면 커스텀 정책이 기본 정책과 함께 적용됩니다. `--namespaces user`는 Trivy에게 `user.*` 패키지 이름공간을 커스텀 정책으로 인식하도록 지시합니다. 정책 파일을 리포지터리에서 관리하면 보안 정책 변경도 코드 리뷰를 통해 추적할 수 있습니다.

---

### Helm 차트와 Kustomize 지원

Kubernetes 배포에서 원본 YAML을 직접 관리하기보다 Helm 차트나 Kustomize를 사용하는 경우가 많습니다. Trivy는 `trivy config` 명령에서 Helm 차트 경로를 직접 받아 렌더링된 매니페스트를 분석하며, `--helm-values` 옵션으로 커스텀 values 파일을 전달할 수 있습니다. Kustomize는 `kubectl kustomize . | trivy config -`처럼 파이프를 활용해 표준 입력으로 넘기는 방식이 현재 가장 안정적입니다. 이 방식은 Kustomize 오버레이까지 완전히 렌더링된 결과물을 스캔하므로 실제 배포 상태를 정확하게 반영합니다.

> Helm 차트 스캔 시 `--helm-values prod-values.yaml`처럼 운영 환경용 values 파일을 지정하지 않으면, 기본값 기준으로만 스캔됩니다. 환경별 values 파일을 각각 지정해 스캔하는 것이 정확합니다.

환경별 values 차이로 인한 보안 설정 오류를 놓치지 않으려면, dev·staging·prod 각각의 values 파일을 CI에서 별도로 스캔하도록 파이프라인을 구성하는 것이 좋습니다.

---

## SBOM 생성과 의존성 추적

### SBOM이 필요한 이유

SBOM은 소프트웨어 공급망(Software Supply Chain)의 투명성을 높이는 핵심 문서입니다. 2021년 Log4Shell 사태를 기억하시나요? 당시 수천 개 조직이 자신들의 시스템이 Log4j를 사용하는지조차 즉시 파악하지 못했습니다. SBOM이 있었다면 영향받는 시스템을 몇 시간 내에 특정할 수 있었을 것입니다. 미국 행정명령 EO 14028과 CISA의 요구사항, 그리고 EU의 Cyber Resilience Act(CRA)는 소프트웨어 공급업체에게 SBOM 제공을 점점 의무화하는 방향으로 가고 있습니다.

Trivy는 **CycloneDX**와 **SPDX** 두 가지 SBOM 표준을 모두 지원합니다. CycloneDX는 취약점 정보와의 통합이 강하고, SPDX는 라이선스 컴플라이언스 도구와의 호환성이 높습니다. 두 형식 모두 JSON과 XML을 지원하며, 어떤 형식을 선택할지는 다운스트림 도구(의존성 트래킹 플랫폼, 규제 보고 도구)의 요구사항에 따라 결정합니다. 단순히 규제 충족을 위한 일회성 문서가 아니라, 신규 CVE가 공개됐을 때 이미지 재빌드 없이 영향 범위를 즉시 파악하는 **운용 도구**로 바라보는 시각이 중요합니다.

```diagram
2026-09-22-98ddabe9-05
```

SBOM은 한 번 생성해두면 취약점 스캔 입력으로 재활용할 수 있어, 이미지를 재빌드하지 않고도 새로운 CVE가 발표됐을 때 빠르게 영향도를 분석할 수 있습니다.

---

### SBOM 생성 워크플로

이미지를 빌드한 뒤 SBOM을 생성하고, 이를 레지스트리에 아티팩트로 첨부하는 패턴이 현재 표준으로 자리잡고 있습니다. `cosign`과 함께 사용하면 SBOM에 서명까지 추가해 공급망 무결성을 보장할 수 있습니다. Trivy로 SBOM을 생성할 때 `--scanners` 옵션을 빈 문자열로 설정하면 취약점 스캔 없이 SBOM만 생성합니다.

```bash
# 1단계: CycloneDX SBOM 생성 (패키지 목록만 추출, CVE 스캔 없음)
trivy image \
  --format cyclonedx \
  --output sbom.cdx.json \
  --scanners "" \
  myapp:v1.2.3
# 결과: sbom.cdx.json 생성 — components 배열에 OS·언어 패키지 목록 포함

# 2단계: 생성된 SBOM으로 취약점 스캔
trivy sbom \
  --severity CRITICAL,HIGH \
  --exit-code 1 \
  sbom.cdx.json
# 결과: CRITICAL·HIGH CVE 발견 시 exit code 1 → 파이프라인 중단
```

2단계에서 SBOM 파일을 스캔 입력으로 사용하면 같은 패키지 목록에 대해 추후 반복 스캔이 가능합니다. `--exit-code 1`은 취약점 발견 시 비정상 종료 코드를 반환해 CI가 빌드를 실패로 처리하도록 합니다. SBOM 파일을 레지스트리나 아티팩트 저장소에 함께 보관하면 6개월 뒤 신규 CVE가 발표됐을 때도 해당 버전 이미지의 영향을 즉시 파악할 수 있습니다.

---

### Dependency Track 연동

SBOM을 생성하는 것에서 그치지 않고, 지속적으로 추적하려면 **Dependency Track** 같은 SBOM 관리 플랫폼과 연동해야 합니다. Dependency Track은 SBOM을 업로드받아 컴포넌트 인벤토리를 관리하고, 새로운 CVE가 NVD에 등재될 때마다 기존 SBOM과 자동으로 대조해 알림을 발송합니다. Trivy가 SBOM 생성 도구라면, Dependency Track은 SBOM 추적 플랫폼이라고 볼 수 있습니다. 두 도구를 함께 사용하면 "오늘 새로 발표된 CVE가 우리 서비스 중 어디에 영향을 미치는가"를 자동으로 파악할 수 있습니다.

| 도구 | 역할 | 주요 기능 | 비용 |
|---|---|---|---|
| Trivy | SBOM 생성·스캔 | 이미지·IaC·SBOM 스캔 | 오픈소스 |
| Dependency Track | SBOM 추적·관리 | 신규 CVE 자동 대조·알림 | 오픈소스 |
| Grype | SBOM 취약점 스캔 | Anchore 계열, SBOM 입력 지원 | 오픈소스 |
| Aqua Platform | 통합 보안 플랫폼 | SLA 보장·정책 관리·대시보드 | 상용 |

---

## CI/CD 파이프라인 통합

### GitHub Actions 통합

GitHub Actions에서 Trivy를 통합하는 가장 간결한 방법은 `aquasecurity/trivy-action`을 사용하는 것입니다. 이 액션은 Trivy 설치·DB 다운로드·스캔 실행을 하나의 스텝으로 처리하며, SARIF 형식으로 결과를 출력해 GitHub Security 탭의 Code Scanning 기능과 통합됩니다. SARIF(Static Analysis Results Interchange Format)는 GitHub이 표준으로 채택한 정적 분석 결과 형식으로, PR에 인라인 코멘트로 취약점을 표시할 수 있습니다.

```yaml
# .github/workflows/security-scan.yml
name: Security Scan
on:
  push:
    branches: [main]
  pull_request:

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write   # SARIF 업로드 권한
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Build image
        run: docker build -t myapp:${{ github.sha }} .

      - name: Run Trivy image scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: myapp:${{ github.sha }}
          format: sarif
          output: trivy-image.sarif
          severity: CRITICAL,HIGH
          exit-code: "1"        # 취약점 발견 시 워크플로 실패

      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()            # 스캔 실패해도 결과는 업로드
        with:
          sarif_file: trivy-image.sarif

      - name: Run Trivy IaC scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: config
          scan-ref: .
          format: sarif
          output: trivy-iac.sarif

      - name: Upload IaC SARIF
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-iac.sarif
```

`if: always()`를 업로드 스텝에 붙이면, 취약점 발견으로 워크플로가 실패하더라도 SARIF 파일이 GitHub에 업로드되어 Security 탭에서 확인할 수 있습니다. 이 설정이 없으면 스캔 실패 시 결과 자체가 사라져 원인 파악이 어려워집니다.

---

### DB 캐시 전략과 파이프라인 최적화

CI 파이프라인에서 Trivy를 실행할 때 가장 큰 시간 소요는 취약점 DB 다운로드입니다. DB 압축 크기가 약 70MB 내외이며, 레이턴시가 높은 환경에서는 30-60초가 소요되기도 합니다. GitHub Actions의 캐시 액션을 활용하면 이를 크게 줄일 수 있습니다. 캐시 키를 날짜 기반으로 설정하면 DB를 하루에 한 번만 갱신하고, 같은 날 실행되는 모든 파이프라인은 캐시를 재사용합니다. `~/.cache/trivy` 경로를 캐시하면 되며, 대규모 모노레포에서 여러 서비스의 이미지를 병렬로 스캔할 때 DB 다운로드 중복을 없앨 수 있어 전체 파이프라인 시간이 크게 줄어듭니다.

```diagram
2026-09-22-98ddabe9-06
```

캐시를 활용하면 DB 다운로드 시간이 첫 실행 이후 수 초로 단축되며, 특히 PR마다 스캔을 실행하는 환경에서 누적 비용이 줄어듭니다.

---

### GitLab CI 및 Operator 방식 비교

GitLab CI에서는 Trivy를 Docker 이미지로 직접 실행하는 방식이 일반적입니다. `aquasec/trivy:latest` 이미지를 job의 `image`로 지정하고, GitLab의 Security Scanning 기능과 연동하려면 결과를 `gl-container-scanning-report.json` 파일명으로 저장해야 합니다. GitLab Ultimate 플랜에서는 이 파일을 자동으로 파싱해 MR(Merge Request) 내 보안 위젯에 표시합니다.

Kubernetes 클러스터 수가 많거나 배포 후 재스캔이 중요한 경우에는 **Trivy Operator**를 고려합니다. Trivy Operator는 클러스터에 배포되어 새로운 Pod가 생성될 때마다 자동으로 이미지를 스캔하고 결과를 `VulnerabilityReport` CRD로 저장합니다. CI에서 배포 전 스캔과 Operator의 배포 후 재스캔을 함께 운용하면, "배포 직후에는 안전했으나 이후 신규 CVE로 영향받게 된" 상황도 탐지할 수 있습니다.

---

## 운영 환경 고려사항

### 흔한 실수와 함정

Trivy를 처음 도입하면 취약점 수에 압도되는 경우가 많습니다. `ubuntu:22.04` 기반 이미지를 스캔하면 수백 개의 취약점이 보고될 수 있는데, 대부분은 Ubuntu LTS가 업스트림 픽스를 아직 백포트하지 않은 것들입니다. 이 경우 Ubuntu 자체 어드바이저리 기준으로 실제 영향이 없는 항목들이 많습니다. Trivy는 배포판별 어드바이저리를 우선하므로, `--ignore-unfixed` 옵션으로 픽스 없는 취약점을 제외하면 초기 노이즈를 크게 줄일 수 있습니다. 이후 팀이 도구에 익숙해지면 점진적으로 정책을 강화하는 방식이 현실적입니다.

또 다른 함정은 **파이프라인 우회(bypass) 문화**입니다. 취약점이 발견됐을 때 CI를 통과시키기 위해 `.trivyignore`에 CVE ID를 무분별하게 추가하면, 파일이 빠르게 불투명해집니다. 이를 방지하려면 각 무시 항목에 만료일 주석을 설정하거나, VEX 문서로 이유와 기한을 명시하는 방식으로 관리해야 합니다.

```diagram
2026-09-22-98ddabe9-07
```

취약점 대응 프로세스를 팀 내에 명문화해 두면, 발견 즉시 어떤 경로로 처리할지 결정하는 시간을 단축할 수 있습니다.

---

### 모니터링과 메트릭 수집

취약점 스캔 결과를 단순히 CI 로그로만 남기면 추세를 파악하기 어렵습니다. `--format json`으로 결과를 저장하고, 이를 파싱해 **취약점 수 추이**·**평균 수정 소요 시간(MTTR)**·**심각도별 분포**를 대시보드에 시각화하면 보안 상태를 정량적으로 관리할 수 있습니다. Grafana + Prometheus 조합을 사용하는 팀은 Trivy의 JSON 결과를 Pushgateway로 밀어넣는 스크립트를 CI에 추가하는 방식을 많이 씁니다.

| 지표 | 의미 | 권장 임계값 |
|---|---|---|
| CRITICAL 개수 | 즉시 대응 필요 | 0 (차단 정책) |
| HIGH 개수 추이 | 주간 증감 | 주 단위 감소 목표 |
| MTTR | 발견→패치 시간 | CRITICAL 24h 이내 |
| 무시 항목 수 | 기술 부채 지표 | 월 정기 검토 |
| SBOM 커버리지 | 추적되는 서비스 비율 | 100% 목표 |

---

### 확장과 마이그레이션

조직의 서비스 수가 늘어나면 스캔 결과를 중앙에서 집계해야 합니다. **Trivy Operator**는 Kubernetes 클러스터 안에 배포해 클러스터 내 모든 Pod 이미지를 자동으로 스캔하고 결과를 `VulnerabilityReport` CRD로 저장합니다. `kubectl get vulnerabilityreports -A`로 클러스터 전체 취약점 현황을 조회할 수 있어, 수십 개 마이크로서비스를 운영하는 환경에서 수작업 스캔의 한계를 극복할 수 있습니다. Helm 차트로 배포되며, `--set operator.scanJobsInSameNamespace=true` 옵션으로 스캔 Job을 대상 네임스페이스와 분리하는 등 세밀한 제어가 가능합니다.

기존에 Anchore나 Clair를 사용하다 Trivy로 이전하는 경우, 취약점 탐지율과 오탐률이 미묘하게 다를 수 있습니다. 이전 초기에는 두 도구를 병행 실행해 결과를 비교하고, 팀이 신뢰 수준을 확보한 뒤 기존 도구를 제거하는 점진적 마이그레이션 전략이 안전합니다. 특히 Java 생태계의 경우 Trivy의 Java DB 갱신 주기와 Gradle·Maven의 다단계 의존성 해석 정확도를 별도로 검증해 보는 것이 좋습니다.

---

## 맺음말

### 핵심 요약

Trivy는 컨테이너 이미지·IaC·SBOM을 단일 도구로 스캔해 DevSecOps 파이프라인을 단순화합니다. 핵심은 세 가지입니다. 첫째, `trivy.yaml` 설정 파일을 리포지터리에 커밋해 로컬과 CI 환경의 스캔 정책을 통일합니다. 둘째, SARIF 포맷으로 결과를 출력해 GitHub Security 탭이나 GitLab Security Dashboard에 통합하면 개발자가 PR 단계에서 직접 취약점을 확인할 수 있습니다. 셋째, 단순 스캔에서 그치지 않고 SBOM을 생성해 레지스트리에 함께 보관하면, 새로운 CVE가 공개됐을 때 이미지를 재빌드하지 않고도 영향 범위를 즉시 파악할 수 있습니다.

```diagram
2026-09-22-98ddabe9-08
```

빌드·스캔·배포·재스캔으로 이어지는 이 루프가 완성되면, 취약점 탐지가 일회성 이벤트가 아니라 지속적인 프로세스가 됩니다.

---

### 적용 판단 기준

Trivy 도입을 검토할 때 다음 기준으로 판단하시기 바랍니다. 컨테이너 기반 워크로드를 운영하고 있고 취약점 스캔 도구가 없다면 즉시 도입을 권장합니다. 설치가 간단하고(싱글 바이너리 또는 도커 이미지), GitHub Actions·GitLab CI 연동 예제가 풍부합니다. 이미 tfsec·Clair 같은 도구를 사용 중이라면 Trivy로의 통합이 운영 비용을 실제로 줄이는지를 먼저 평가해야 합니다. SBOM 규제 요건을 충족해야 하는 환경이라면 CycloneDX·SPDX 생성 기능과 Dependency Track 연동이 큰 장점입니다. 반면 매우 세밀한 엔터프라이즈 정책 관리가 필요하거나 SLA가 보장된 취약점 데이터베이스가 필요하다면 Aqua Platform이나 Snyk 같은 상용 제품의 추가 기능을 함께 검토하는 것이 현실적입니다. Trivy는 단독 도구로도 충분히 강력하지만, 조직의 규모와 규제 환경에 따라 상위 플랫폼과의 조합이 필요한 시점이 있음을 인지하고 로드맵을 설계하시기 바랍니다.
