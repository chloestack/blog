---
title: "Ollama로 로컬 LLM 서빙과 OpenAI 호환 API 연동하기"
date: "2026-10-18 02:10"
updated: "2026-10-19 15:39"
category: "AI"
tags: ["Ollama", "로컬LLM", "OpenAI호환API", "LLM개발환경", "Spring AI"]
excerpt: "개발 단계 LLM 비용을 0원으로 만드는 법입니다. Ollama 설치부터 OpenAI 호환 API로 Spring에 붙이기까지, 환경 변수 하나로 로컬 모델과 상용 API를 오가게 구성합니다."
---

## 목차

1. 개요
2. Ollama 아키텍처와 동작 원리
3. Ollama 설치와 첫 번째 모델 서빙
4. OpenAI 호환 API 연동
5. 성능 특성과 기술 선택 기준
6. 운영 환경 적용 시 고려사항
7. 맺음말

---

## 개요

### 로컬 LLM 개발 환경의 필요성

LLM(Large Language Model)을 활용한 애플리케이션 개발이 빠르게 확산되면서, 개발·테스트 단계에서 OpenAI나 Anthropic 같은 상용 API에만 의존하는 방식의 한계가 점점 뚜렷해지고 있습니다. API 호출 비용은 초기 프로토타입 단계에서는 작아 보이지만, 반복적인 테스트와 CI 파이프라인 통합이 쌓이면 청구 비용이 예상치 못하게 늘어납니다. 여기에 고객 데이터나 내부 문서 같은 민감한 정보를 외부 서버로 전송해야 한다는 보안 우려까지 더해지면, 로컬에서 LLM을 직접 구동하는 환경의 필요성이 명확해집니다. Ollama는 이런 배경에서 등장한 오픈소스 도구로, macOS·Linux·Windows 어디서든 몇 줄의 명령어만으로 Llama 3, Mistral, Gemma, Qwen 같은 오픈 가중치 모델을 로컬에서 서빙할 수 있도록 설계되어 있습니다.

Ollama가 주목받는 이유는 단순히 모델을 실행하는 데 그치지 않기 때문입니다. OpenAI의 Chat Completions API와 호환되는 엔드포인트를 함께 제공하므로, 기존에 OpenAI SDK나 LangChain, Spring AI로 작성한 코드를 최소한의 수정으로 로컬 모델로 전환할 수 있습니다. 이는 개발 환경에서는 비용 없이 로컬 모델을 활용하고, 프로덕션 배포 시에만 상용 API로 전환하는 전략을 현실적으로 가능하게 만듭니다.

```diagram
2026-10-18-e554af31-01
```

상용 API와 Ollama는 동일한 인터페이스를 애플리케이션에 노출하므로, 환경 변수 하나로 두 환경을 오갈 수 있습니다.

### 기존 방식의 한계

Ollama 이전에도 로컬 LLM 실행 방법은 존재했습니다. llama.cpp를 직접 빌드하거나, Hugging Face의 `transformers` 라이브러리를 사용하는 방식이 이미 있었습니다. 그러나 이들 방식은 공통적인 진입 장벽을 가지고 있었습니다. CUDA 드라이버 버전 충돌, Python 가상환경 관리, 모델 가중치 파일의 수동 변환 등 설정 과정 자체가 상당한 전문 지식을 요구했습니다. Java나 Go 같은 비파이썬 환경에서 개발하는 팀이라면 Python 생태계 전체를 추가로 관리해야 하는 부담이 생깁니다.

Docker 기반 솔루션도 대안으로 쓰였지만, GPU 패스스루 설정과 대용량 이미지 관리가 번거롭고, 컨테이너 안에 모델 가중치를 포함하면 이미지 크기가 수십 GB에 달하는 경우도 드물지 않습니다. Ollama는 이 모든 복잡성을 단일 바이너리로 추상화하면서, 모델을 OCI(Open Container Initiative) 아티팩트 방식으로 레지스트리에서 관리하는 구조를 채택했습니다.

| 방식 | 설치 난이도 | 비파이썬 지원 | OpenAI 호환 | 주의점 |
|---|---|---|---|---|
| llama.cpp 직접 빌드 | 높음 | 가능하나 복잡 | 별도 구성 필요 | 버전마다 빌드 반복 |
| Hugging Face transformers | 중간 | Python 전용 | 없음 | Python 환경 필수 |
| Docker + llama.cpp | 중간 | 가능 | 별도 구성 필요 | GPU 패스스루 설정 필요 |
| Ollama | 낮음 | 모든 언어 가능 | 기본 제공 | 프로덕션 처리량 한계 있음 |

---

## Ollama 아키텍처와 동작 원리

### 모델 레이어 관리 방식

Ollama의 내부 구조를 이해하면 모델을 더 효율적으로 다룰 수 있습니다. Ollama는 모델을 레이어 단위로 관리합니다. 각 모델은 기반 가중치 레이어, LoRA 어댑터 레이어, 시스템 프롬프트, 대화 템플릿 등 여러 레이어의 조합으로 구성됩니다. 이 레이어 구조는 컨테이너 이미지의 레이어 개념과 유사하며, 동일한 기반 가중치를 공유하는 두 모델을 설치할 때 중복 데이터를 저장하지 않습니다. 예를 들어 `llama3.2:3b`와 `llama3.2:3b-instruct-q4_K_M`이 동일한 기반 레이어를 공유한다면 디스크 공간이 절약됩니다.

모델 파일은 기본적으로 `~/.ollama/models` 디렉터리에 저장됩니다. GGUF(GPT-Generated Unified Format) 포맷으로 저장된 가중치 파일과 메타데이터를 포함하며, llama.cpp를 핵심 추론 엔진으로 사용합니다. llama.cpp는 CPU 전용 실행은 물론, Apple Silicon의 Metal, NVIDIA의 CUDA, AMD의 ROCm을 자동으로 감지하여 GPU 가속을 활성화합니다. 이 자동 감지 동작이 Ollama가 드라이버 설치 외에 별도의 설정 없이 동작하는 핵심 이유입니다.

```diagram
2026-10-18-e554af31-02
```

Metal이나 CUDA가 감지되면 GPU 레이어 수를 자동으로 최대화하며, CPU와 GPU의 혼합 실행(partial offload)도 지원합니다.

### 요청 처리 흐름

Ollama는 `ollama serve` 명령으로 시작되는 HTTP 서버로 동작합니다. 기본 포트는 **11434**이며, `OLLAMA_HOST` 환경 변수로 바인딩 주소를 변경할 수 있습니다. 클라이언트가 `/api/chat`이나 `/v1/chat/completions` 엔드포인트로 요청을 보내면, Ollama 서버는 해당 모델이 이미 메모리에 로드되어 있는지 확인합니다. 처음 요청이라면 모델을 메모리에 로드하는 데 수 초가 걸리지만, 이후 요청부터는 즉시 응답합니다.

기본적으로 마지막 요청으로부터 5분이 지나면 모델이 메모리에서 언로드됩니다. 이 시간은 `OLLAMA_KEEP_ALIVE` 환경 변수로 조정할 수 있으며, `-1`로 설정하면 영구 로드 상태를 유지합니다. 개발 환경에서는 이 값을 `-1`로 고정해 두는 것이 첫 번째 요청의 지연을 없애는 가장 단순한 방법입니다. 반면 메모리가 제한적인 환경에서는 짧은 언로드 시간을 유지해 다른 프로세스와 메모리를 공유하는 전략도 유효합니다.

```diagram
2026-10-18-e554af31-03
```

모델 로드 지연은 첫 번째 요청에서만 발생합니다. `OLLAMA_KEEP_ALIVE=-1` 설정으로 이 지연을 제거할 수 있습니다.

### 지원 백엔드와 하드웨어 가속

Ollama가 지원하는 하드웨어 가속 백엔드는 플랫폼에 따라 다릅니다. macOS에서는 Apple Silicon의 Metal GPU를 자동으로 활용하며, 통합 메모리 아키텍처 덕분에 CPU와 GPU가 동일한 메모리 풀을 공유합니다. 이는 16GB M3 MacBook에서도 7B 모델을 충분히 실행할 수 있다는 의미입니다. Linux에서는 CUDA(NVIDIA)와 ROCm(AMD)을 지원하며, 드라이버만 올바르게 설치되어 있으면 Ollama가 자동으로 감지합니다. Windows에서는 WSL2 환경에서의 CUDA 지원이 안정적이며, 네이티브 환경에서도 CUDA와 ROCm을 지원합니다.

| 플랫폼 | 백엔드 | 특성 | 주의점 |
|---|---|---|---|
| macOS (Apple Silicon) | Metal | RAM·VRAM 통합 메모리 | RAM 용량이 사실상 VRAM |
| Linux (NVIDIA) | CUDA | 고성능 · 광범위 지원 | CUDA 드라이버 12.x 이상 권장 |
| Linux (AMD) | ROCm | 일부 모델 지원 | ROCm 6.x 호환성 사전 확인 필요 |
| Windows | CUDA / ROCm | 네이티브 지원 | WSL2 경유가 더 안정적 |
| CPU 전용 | llama.cpp | 하드웨어 무관 | 속도 느림, 3B 이하 모델 권장 |

---

## Ollama 설치와 첫 번째 모델 서빙

### 설치 및 초기 설정

설치는 매우 단순합니다. macOS에서는 `brew install ollama` 또는 공식 사이트(https://ollama.com)에서 설치 패키지를 내려받으면 됩니다. Linux에서는 공식 설치 스크립트 한 줄로 완료되고, Windows에서는 설치 파일을 내려받거나 Winget을 통해 설치할 수 있습니다. 설치가 완료되면 `ollama` CLI가 시스템 경로에 등록되고, macOS에서는 메뉴 바 앱 형태로 서버가 자동 시작됩니다.

개발 환경에서 Ollama 서버를 외부 네트워크에도 노출하려면 서버 시작 전에 `OLLAMA_HOST=0.0.0.0` 환경 변수를 설정해야 합니다. 기본값은 `127.0.0.1:11434`로 로컬호스트에만 바인딩됩니다. CI 파이프라인이나 Docker 컨테이너 안에서 Ollama를 사용할 때는 이 환경 변수 설정이 중요합니다. 공식 Docker 이미지(`ollama/ollama`)를 사용하면 컨테이너 환경에서의 구성이 간편해지며, GPU 지원이 필요하다면 NVIDIA Container Toolkit이 사전 설치된 환경에서 `--gpus all` 플래그와 함께 컨테이너를 실행합니다.

```diagram
2026-10-18-e554af31-04
```

설치 방법은 플랫폼마다 다르지만 최종적으로는 동일한 HTTP 서버가 실행됩니다.

### 모델 다운로드와 실행

모델 실행에 앞서 사용할 모델을 pull해야 합니다. Ollama 공식 라이브러리(https://ollama.com/library)에는 수백 개의 모델이 등록되어 있습니다. 모델 이름 뒤에 태그를 붙여 양자화 수준을 지정할 수 있습니다. 예를 들어 `llama3.2:3b-instruct-q4_K_M`은 Llama 3.2 3B 모델의 인스트럭트 파인튜닝 버전에 Q4_K_M 양자화를 적용한 것입니다. 양자화 수준이 낮을수록 파일 크기와 메모리 사용량이 줄어들지만, 응답 품질이 일부 저하될 수 있습니다. 개발 및 테스트 목적이라면 Q4_K_M이나 Q5_K_M이 속도와 품질의 균형을 잘 잡아줍니다.

처음 모델을 실행하기 전에 REST API로 직접 요청을 보내 동작을 확인하는 과정이 권장됩니다. 다음은 `curl`로 Ollama 네이티브 엔드포인트와 OpenAI 호환 엔드포인트를 각각 호출하는 예시입니다.

```bash
# Ollama 네이티브 엔드포인트 (stream: false → 단일 JSON 응답)
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:3b",
    "messages": [{"role": "user", "content": "안녕하세요, 간단히 자기소개 해주세요."}],
    "stream": false
  }'

# OpenAI 호환 엔드포인트 — base_url만 변경하면 동일하게 동작
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "llama3.2:3b",
    "messages": [{"role": "user", "content": "안녕하세요, 간단히 자기소개 해주세요."}]
  }'
# 결과: {"id":"chatcmpl-...","object":"chat.completion",
#        "choices":[{"message":{"role":"assistant","content":"안녕하세요! 저는 Llama 3.2입니다..."}}]}
```

`stream: false`를 명시하면 전체 응답을 하나의 JSON으로 반환합니다. OpenAI 호환 엔드포인트는 `Authorization` 헤더를 요구하지만, 값은 임의의 문자열이어도 인증 검증 없이 통과합니다.

### 기본 API 호출 검증

모델이 정상적으로 응답하는 것을 확인한 후에는 `/api/tags` 엔드포인트로 현재 로컬에 설치된 모델 목록을 조회할 수 있습니다. 이 엔드포인트는 모델 이름, 크기, 수정 날짜, 사용된 양자화 정보를 반환합니다. `ollama list` CLI 명령으로도 동일한 정보를 터미널에서 확인할 수 있습니다. 현재 메모리에 로드된 모델과 사용 중인 VRAM 현황은 `/api/ps`로 조회합니다.

Modelfile을 사용하면 시스템 프롬프트, 컨텍스트 크기, 샘플링 파라미터를 버전 관리할 수 있습니다. `FROM llama3.2:3b`를 기반으로 `SYSTEM`과 `PARAMETER` 지시어를 추가한 Modelfile을 `ollama create mymodel -f Modelfile`로 빌드하면, 팀 공통의 모델 설정을 코드처럼 관리할 수 있습니다. 이 방식은 프로덕션 시스템 프롬프트를 로컬에서 검증할 때 특히 유용합니다.

> **핵심 규칙**: `Authorization: Bearer <임의값>` 헤더는 OpenAI 호환 엔드포인트에서 형식만 검증합니다. 빈 문자열은 거부되지만 `"ollama"`, `"sk-anything"` 등 임의의 값은 모두 통과합니다. 테스트 스크립트에서 이 헤더를 누락하면 401 에러가 발생합니다.

---

## OpenAI 호환 API 연동

### 엔드포인트 구조와 호환 범위

Ollama는 `/v1` 접두사 아래에 OpenAI Chat Completions API의 주요 엔드포인트를 구현합니다. `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`가 지원되며, OpenAI SDK를 사용하는 코드에서 `base_url`만 Ollama 서버 주소로 변경하면 나머지 코드는 그대로 동작합니다. 단, 모든 파라미터가 완전히 동일하게 동작하지는 않습니다. `response_format`, `tool_choice`, `parallel_tool_calls` 같은 고급 파라미터의 지원 여부는 모델과 Ollama 버전에 따라 다릅니다.

특히 **함수 호출(Function Calling)과 JSON 모드**는 모델이 이를 네이티브로 지원해야 정확하게 동작합니다. Llama 3.1 이상, Mistral, Qwen2.5 같은 최신 모델들은 함수 호출과 구조화된 출력을 지원하지만, 구형 모델에서는 예상대로 동작하지 않을 수 있습니다. 이 차이를 사전에 테스트로 검증해 두면, 프로덕션 전환 시 예상치 못한 동작 차이를 줄일 수 있습니다.

```diagram
2026-10-18-e554af31-05
```

`base_url` 변경만으로 로컬 모델과 상용 API를 교체할 수 있는 것이 OpenAI 호환 레이어의 핵심 가치입니다.

### Java/Spring 코드에서 연동하기

Spring AI나 LangChain4j 같은 Java LLM 프레임워크는 Ollama를 공식 지원합니다. 그러나 OpenAI 호환 엔드포인트를 직접 활용하면 프레임워크 의존 없이 표준 HTTP 클라이언트만으로도 연동이 가능합니다. 아래 예시는 Spring Boot 프로젝트에서 `spring-ai-openai-spring-boot-starter`를 사용해 Ollama에 연결하는 설정입니다. `application.yml`에서 `base-url`만 바꾸면 프로덕션에서 OpenAI로 전환할 수 있습니다.

```java
// application.yml 설정:
// spring.ai.openai.base-url=http://localhost:11434
// spring.ai.openai.api-key=ollama
// spring.ai.openai.chat.options.model=llama3.2:3b

@Service
public class LocalLlmService {

    private final ChatClient chatClient;

    public LocalLlmService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    // 동기 호출 — 전체 응답을 String으로 반환
    public String ask(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .content(); // 결과: 모델의 텍스트 응답 (String)
    }

    // 스트리밍 호출 — 토큰 단위로 Flux<String> 반환
    public Flux<String> stream(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content(); // 결과: 토큰 단위 스트리밍 Flux
    }
}
```

`ChatClient`는 Spring AI의 추상화 레이어로, 백엔드가 Ollama든 OpenAI든 동일한 인터페이스로 호출합니다. `application.yml`의 `base-url`을 교환하면 코드 변경 없이 모델 공급자를 전환할 수 있습니다.

### 스트리밍 응답 처리

LLM 응답은 전체 텍스트가 생성될 때까지 기다리는 것보다 스트리밍으로 수신하는 것이 사용자 경험에 훨씬 유리합니다. CPU 환경에서 7B 파라미터 모델이 100토큰을 생성하는 데 15~30초가 걸릴 수 있는데, 블로킹 방식으로 처리하면 사용자는 응답이 오는지 확인할 방법이 없습니다. OpenAI 호환 엔드포인트에서 스트리밍을 활성화하려면 요청 본문에 `"stream": true`를 추가하면 됩니다. 응답은 Server-Sent Events(SSE) 형식으로 토큰 단위로 전달됩니다.

스트리밍 처리 시 유의할 점은 스트림의 종료 신호 차이입니다. OpenAI 호환 엔드포인트(`/v1/chat/completions`)에서는 스트림이 `data: [DONE]` 라인으로 끝납니다. Ollama 네이티브 엔드포인트(`/api/chat`)에서는 마지막 청크의 `"done": true` 필드로 종료를 감지합니다. Spring AI의 `Flux<String>`은 이 종료 신호를 자동으로 처리하므로 직접 파싱할 필요가 없지만, WebClient나 OkHttp로 직접 스트리밍을 구현할 때는 이 차이를 인식해야 합니다.

| 엔드포인트 | 종료 신호 | 스트리밍 형식 | 언제 쓰나 |
|---|---|---|---|
| `/v1/chat/completions` | `data: [DONE]` | SSE (OpenAI 형식) | OpenAI SDK · Spring AI 사용 시 |
| `/api/chat` | `"done": true` | JSON Lines | Ollama 네이티브 클라이언트 |
| `/api/generate` | `"done": true` | JSON Lines | 단일 텍스트 생성, 대화 불필요 시 |

---

## 성능 특성과 기술 선택 기준

### 하드웨어별 추론 성능

Ollama의 추론 성능은 사용하는 하드웨어에 따라 크게 달라집니다. 성능의 핵심 지표는 **TPS(Tokens Per Second)**, 즉 초당 생성 토큰 수입니다. 대화 인터페이스에서 자연스럽게 느껴지려면 최소 10 TPS 이상이 필요하고, 20 TPS 이상이면 사용자가 타이핑 속도와 비슷하게 체감합니다. Apple M3 Max에서 `llama3.2:3b` 모델은 약 80~100 TPS를 달성하며, RTX 4090에서는 150 TPS를 넘기도 합니다. 반면 CPU 전용 환경(16코어 x86)에서 7B 모델은 5~15 TPS 수준으로, 인터랙티브 사용에는 다소 느립니다.

양자화 수준은 성능과 품질의 트레이드오프를 결정하는 핵심 파라미터입니다. Q2_K는 가장 작지만 품질 저하가 눈에 띄고, Q8_0은 거의 원본 품질이지만 메모리 요구량이 큽니다. 개발·테스트 환경이라면 Q4_K_M 또는 Q5_K_M이 합리적인 출발점입니다.

| 양자화 | 메모리 (7B 기준) | 품질 | 속도 | 언제 쓰나 |
|---|---|---|---|---|
| Q2_K | ~2.5GB | 낮음 | 빠름 | 메모리가 극히 제한적일 때 |
| Q4_K_M | ~4.1GB | 양호 | 균형 | 개발·테스트 기본값 |
| Q5_K_M | ~4.9GB | 좋음 | 중간 | 품질을 중시하는 테스트 |
| Q8_0 | ~7.2GB | 거의 원본 | 느림 | 품질 벤치마크 기준선 |
| FP16 | ~14GB | 원본 | 가장 느림 | VRAM 충분한 GPU 환경 |

### 대안 기술과 비교

Ollama 이외에도 로컬 LLM 서빙을 위한 도구들이 있습니다. LM Studio는 GUI 기반으로 비개발자도 쉽게 사용할 수 있지만, API 서버 기능이 상대적으로 제한적입니다. vLLM은 처리량(throughput)에 최적화된 프로덕션급 서버로, 배치 처리와 연속 배치(continuous batching)를 지원하지만 NVIDIA GPU가 필수이고 설정 복잡도가 높습니다. llama.cpp 서버를 직접 빌드하면 최대의 유연성을 얻을 수 있지만 설정 부담이 큽니다. LocalAI는 Ollama와 유사한 OpenAI 호환 레이어를 제공하지만, 커뮤니티 생태계 규모에서 Ollama에 뒤처집니다.

```diagram
2026-10-18-e554af31-06
```

도구 선택 기준은 결국 사용 목적과 환경에 따라 결정됩니다. 개발·테스트 목적이라면 Ollama가 가장 빠른 시작점을 제공합니다.

### 어떤 상황에서 선택할 것인가

Ollama가 명확한 강점을 보이는 시나리오는 크게 세 가지입니다. 첫째, 개발 초기 단계에서 LLM 기능을 빠르게 프로토타이핑할 때입니다. API 키 없이 즉시 시작할 수 있고, 비용 걱정 없이 반복 테스트가 가능합니다. 둘째, 민감한 데이터를 다루는 내부 도구 개발입니다. 고객 데이터나 내부 문서가 외부 서버로 전송되지 않아야 할 때, 로컬 추론은 선택이 아닌 필수가 됩니다. 셋째, 상용 API 비용을 최소화하면서 개발 속도를 유지하려는 팀입니다. 개발 환경에서는 Ollama, 스테이징과 프로덕션에서는 상용 API로 나누는 전략이 비용과 품질 양쪽을 챙깁니다.

반대로 Ollama가 적합하지 않은 경우도 있습니다. 수천 명의 동시 사용자를 처리해야 하는 프로덕션 환경이거나, GPT-4o나 Claude 3.7 Sonnet 수준의 추론 품질이 반드시 필요한 경우는 현재 오픈 가중치 모델만으로는 한계가 있습니다. Ollama를 처음부터 OpenAI 호환 인터페이스로 사용했다면, 이런 상황에서 상용 API로의 전환은 환경 변수 변경 하나로 처리할 수 있습니다.

---

## 운영 환경 적용 시 고려사항

### 흔한 실수와 함정

Ollama를 처음 사용할 때 가장 자주 겪는 문제는 모델 크기와 메모리 간의 불일치입니다. 8GB RAM 환경에서 7B Q4_K_M 모델(약 4.1GB)을 실행하면, 운영체제와 다른 프로세스가 이미 메모리를 상당량 점유한 상태라 OOM(Out of Memory) 오류가 발생할 수 있습니다. 모델 가중치 크기보다 20~30% 추가 메모리가 컨텍스트 처리와 KV 캐시에 필요합니다. 컨텍스트 길이를 기본값(2048)보다 크게 설정(`num_ctx: 8192`)하면 KV 캐시가 그에 비례해 늘어나므로, 긴 컨텍스트가 필요하다면 메모리 여유를 충분히 확보해야 합니다.

두 번째 함정은 멀티 GPU 환경에서의 레이어 분배 문제입니다. Ollama는 여러 GPU를 자동으로 감지하지만, GPU 메모리가 불균일하거나 PCIe 대역폭이 다를 때 성능이 예상보다 낮게 나올 수 있습니다. `OLLAMA_GPU_OVERHEAD` 환경 변수로 GPU당 예약 메모리를 조정하면 도움이 됩니다. `CUDA_VISIBLE_DEVICES` 환경 변수로 사용할 GPU를 명시적으로 지정하는 것도 문제 진단에 유용합니다. 세 번째로 흔한 실수는 모델 pull 없이 API를 호출하는 것입니다. 로컬에 모델이 없으면 404가 아닌 오류 응답이 반환되는데, 초기 설정 시 `ollama list`로 설치된 모델을 확인하는 습관이 필요합니다.

```diagram
2026-10-18-e554af31-07
```

오류 유형에 따라 진단 경로가 완전히 다릅니다. 응답 지연과 OOM은 원인과 해결책이 전혀 다릅니다.

### 모니터링과 디버깅

Ollama는 자체적인 메트릭 엔드포인트를 기본으로 제공하지 않지만, `/api/ps` 엔드포인트로 현재 로드된 모델과 메모리 사용량을 확인할 수 있습니다. 더 세밀한 모니터링이 필요하다면 `OLLAMA_DEBUG=1` 환경 변수를 설정해 상세 로그를 활성화합니다. 이 로그에는 레이어 오프로딩 결정, KV 캐시 상태, 각 요청의 처리 시간이 포함되어 있어 성능 병목을 진단하는 데 효과적입니다.

Prometheus와 연동하려면 Ollama 앞에 프록시를 두거나, 주기적으로 `/api/ps`를 폴링해 메트릭을 수집하는 사이드카를 구성하는 방식이 사용됩니다. Grafana 대시보드와 함께 TPS, 메모리 사용률, 요청 대기 큐 길이를 시각화하면 이상 징후를 빠르게 파악할 수 있습니다. 각 추론 요청의 응답에 포함된 `eval_count`(생성 토큰 수)와 `eval_duration`(처리 시간) 필드를 로깅하면, 애플리케이션 레벨에서 TPS를 직접 측정할 수도 있습니다.

> **운영 규칙**: Ollama 서버의 로그는 기본적으로 표준 에러(stderr)로 출력됩니다. `journalctl -u ollama -f`(Linux 시스템 서비스로 등록한 경우) 또는 Docker 컨테이너 로그를 통해 실시간으로 모니터링하면, 예상치 못한 모델 언로드나 CUDA 초기화 실패를 즉시 감지할 수 있습니다.

### 확장과 마이그레이션

단일 Ollama 인스턴스가 처리할 수 있는 동시 요청 수에는 한계가 있습니다. 기본적으로 Ollama는 하나의 요청을 처리하는 동안 다른 요청을 큐에 대기시킵니다. `OLLAMA_NUM_PARALLEL` 환경 변수를 사용하면 동시 추론 수를 늘릴 수 있지만, 이는 VRAM을 그에 비례해 소비합니다. 따라서 단일 GPU로 처리량을 늘리는 데는 명확한 한계가 있습니다.

처리량이 더 필요하다면 여러 Ollama 인스턴스를 두고 Nginx나 HAProxy로 라운드로빈 로드 밸런싱을 적용하는 방법이 현실적입니다. 이 구성은 별도의 오케스트레이션 없이 설정이 단순하며, 인스턴스마다 다른 모델을 올려 요청 경로에 따라 라우팅할 수도 있습니다. 한 걸음 더 나아가 프로덕션 수준의 처리량이 필요해지면 vLLM이나 TGI(Text Generation Inference)로의 마이그레이션을 고려하는 것이 좋습니다. 처음부터 OpenAI 호환 인터페이스를 표준으로 사용했다면, 이 마이그레이션에서 애플리케이션 코드 변경은 최소화됩니다.

```diagram
2026-10-18-e554af31-08
```

여러 Ollama 인스턴스 앞에 로드 밸런서를 두면 단일 인스턴스의 처리량 한계를 수평 확장으로 극복할 수 있습니다.

---

## 맺음말

### 핵심 요약

Ollama는 로컬 LLM 개발 환경 구축에 있어 현시점에서 가장 낮은 진입 장벽을 제공합니다. 단일 바이너리 설치, 모델 레이어 캐싱, OpenAI 호환 API라는 세 가지 설계 원칙이 결합되어, 비용 없이 빠르게 LLM 기능을 실험할 수 있는 환경을 만들어 줍니다. 모델 서빙부터 Java Spring Boot 연동, 스트리밍 처리, 로드 밸런싱까지 이 글에서 다룬 흐름을 따라가면, 팀의 개발 환경에 로컬 LLM 테스트 인프라를 하루 안에 구성할 수 있습니다.

핵심은 처음부터 OpenAI 호환 인터페이스를 표준으로 채택하는 것입니다. 애플리케이션 코드가 특정 공급자에 종속되지 않으면, 개발 단계의 Ollama 로컬 모델과 프로덕션의 상용 API 사이를 환경 변수 하나로 전환할 수 있습니다. Modelfile로 시스템 프롬프트와 샘플링 파라미터를 버전 관리하면 모델 설정 자체도 코드처럼 다룰 수 있어 환경 재현성이 높아집니다.

### 적용 판단 기준

Ollama를 개발 환경에 도입할 때 가장 먼저 확인해야 할 것은 하드웨어 스펙입니다. Apple Silicon Mac이나 NVIDIA GPU가 있는 환경이라면 7B 이하 모델에서 즉각 체감할 수 있는 성능을 기대할 수 있습니다. CPU 전용 환경에서는 3B 이하 소형 모델로 시작해 응답 속도를 확인한 후 용도에 맞는 모델 크기를 결정하는 것이 좋습니다.

팀 차원에서의 도입을 고려한다면, CI 파이프라인에 Ollama를 통합해 LLM 관련 기능의 통합 테스트를 자동화하는 것을 목표로 삼을 수 있습니다. GitHub Actions의 `ubuntu-latest` 러너에서도 CPU 추론으로 3B 모델을 실행할 수 있으며, 테스트마다 실제 LLM 응답이 필요한 경우 상용 API 의존을 줄일 수 있습니다. 반면 프로덕션 서비스에서 Ollama를 직접 사용하는 경우라면, 동시 요청 수와 TPS 요구사항을 먼저 측정하고 단일 인스턴스의 한계를 명확히 파악한 후에 아키텍처를 설계하는 것이 필요합니다. 개발·테스트와 프로덕션의 역할을 분리하는 것이 Ollama를 가장 효과적으로 활용하는 방법입니다.
