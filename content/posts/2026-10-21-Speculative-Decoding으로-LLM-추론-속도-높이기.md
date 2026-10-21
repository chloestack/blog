---
title: "Speculative Decoding으로 LLM 추론 속도 높이기"
date: "2026-10-21 10:40"
category: "AI"
tags: ["Speculative Decoding", "LLM 추론 최적화", "Draft 모델", "vLLM"]
excerpt: "Draft 모델 수용률이 충분히 높지 않으면 Speculative Decoding은 오히려 느려집니다. 어휘 공유 조건, k값 설정, TTFT 트레이드오프, 프레임워크 선택 기준까지 실제 적용에 필요한 판단 기준을 정리합니다."
---

## 목차

1. 개요
2. Speculative Decoding이 추론을 빠르게 만드는 원리
3. Draft 모델 선택과 검증 단계 구현
4. 수용률과 처리량의 트레이드오프
5. 운영 환경에서 겪는 함정과 대응
6. 맺음말

---

## 개요

Draft 모델 수용률이 충분히 높지 않으면, Speculative Decoding은 타깃 모델 단독보다 오히려 느려집니다. 어휘 공유 조건, k값 설정, TTFT 트레이드오프까지 실제로 적용할 때 필요한 판단 기준을 먼저 잡아야 효과를 볼 수 있습니다.

Speculative Decoding은 LLM 추론 속도를 높이는 기법입니다. GPT-4o나 Llama 70B 같은 대형 모델은 토큰을 하나씩 순서대로 생성하는 구조(자기회귀, autoregressive)로 만들어져, 응답 한 문장을 생성하는 데도 체감할 수 있는 지연이 쌓입니다. Speculative Decoding은 이 한계를 우회합니다. 작은 Draft 모델이 토큰 여러 개를 먼저 빠르게 예측하고, 큰 타깃 모델은 그 예측이 맞는지를 한 번의 포워드 패스로 병렬 검증합니다. 검증이 병렬로 이루어지기 때문에, 타깃 모델을 매번 순차 실행하는 것보다 전체 처리량이 늘어납니다.

이 글은 검증 단계가 어떻게 수학적으로 출력 품질을 보장하는지, Draft 모델을 어떻게 골라야 하는지, 그리고 실제 서빙 환경에서 어떤 설정이 처리량에 영향을 미치는지를 다룹니다. 코드 자동완성이나 문서 요약처럼 Speculative Decoding이 효과적인 작업 유형과 그렇지 않은 경우를 구분하는 판단 기준도 함께 정리합니다.

---

## Speculative Decoding이 추론을 빠르게 만드는 원리

### 자기회귀 디코딩의 구조적 한계

LLM은 이전에 생성한 토큰을 참고해 다음 토큰 하나의 확률 분포를 계산합니다. 이 과정은 반드시 순서대로 진행돼야 하고 병렬화가 불가능합니다. GPU 연산 능력이 아무리 높아도, "토큰 생성 → 다음 입력" 사이클이 반복되는 구조 자체가 벽입니다.

흥미로운 점은 이 병목이 연산량보다 **메모리 대역폭**에서 비롯된다는 것입니다. 수십억 개 파라미터를 GPU 메모리에서 읽어오는 시간이 실제 행렬 연산보다 오래 걸립니다. 토큰을 하나씩 처리하면 그때마다 파라미터를 새로 읽어야 합니다. ==여러 토큰을 한 번에 검증하면 파라미터 로딩 비용을 분산할 수 있어서, 같은 하드웨어에서도 처리량이 의미 있게 늘어납니다.==

### 투기적 실행과 기각 샘플링

Speculative Decoding은 이름 그대로 "투기적(speculative)"으로 동작합니다. Draft 모델이 k개의 토큰을 먼저 생성하면, 타깃 모델은 이 k개의 토큰을 입력으로 받아 한 번의 포워드 패스로 k+1개 위치의 확률 분포를 동시에 계산합니다.

각 위치에서 타깃 모델의 확률과 Draft 모델의 확률을 비교해 수용 여부를 결정합니다. 이 수용 기준이 단순한 임계값이 아니라는 점이 핵심입니다. 타깃 모델의 확률 분포를 그대로 따르도록 설계된 **기각 샘플링(rejection sampling)** 방식입니다. Draft 모델이 틀린 토큰을 제안해도 최종 출력 분포는 타깃 모델로만 생성한 것과 수학적으로 동일합니다.

```diagram
2026-10-21-39f56a15-01
```

타깃 모델이 Draft 토큰을 수용하면 그대로 쓰고, 거부하면 타깃 모델의 분포에서 새로 샘플링해 그 위치부터 다시 시작합니다. 이 메커니즘 덕분에 Speculative Decoding은 출력 품질을 전혀 희생하지 않고 속도만 높입니다.

---

## Draft 모델 선택과 검증 단계 구현

### Draft 모델은 타깃의 어휘를 공유해야 합니다

Draft 모델 선택에서 가장 흔한 실수는 "작은 모델이면 뭐든 된다"고 생각하는 것입니다. ==Draft 모델과 타깃 모델이 같은 토크나이저, 같은 어휘 공간을 공유해야 검증 단계가 의미 있어집니다.== 어휘 분포가 다르면 Draft 토큰과 타깃 확률 분포를 같은 축에서 비교할 수 없어, 기각 샘플링 자체가 성립하지 않습니다.

실제 프로젝트에서 쓸 수 있는 조합을 정리하면 다음과 같습니다.

| 타깃 모델 | 추천 Draft 모델 | 비고 |
|---|---|---|
| Llama 3.1 70B | Llama 3.2 1B / 3B | 동일 아키텍처, 공식 지원 |
| Llama 3.1 8B | Llama 3.2 1B | 이점이 줄어들 수 있어 측정 필요 |
| Gemma 2 27B | Gemma 2 2B | Google 공식 Draft 모델 |
| Mistral 7B | — | 공식 Draft 없음, 커스텀 필요 |

Draft 모델이 너무 약하면 수용률이 떨어져 타깃 모델 단독보다 오히려 느려집니다. 반대로 Draft 모델이 너무 크면 Draft 생성 자체가 병목이 됩니다. 어느 크기가 수용률과 속도 이점의 균형을 잘 맞추는지는 타깃 모델의 특성, 도메인, 실제 수용률을 직접 측정해 결정해야 합니다.

### Hugging Face로 동작 확인하기

개념을 직접 확인하는 가장 빠른 방법은 Hugging Face `transformers`의 `generate` 메서드에 `assistant_model`을 넘기는 것입니다. 내부적으로 기각 샘플링 검증 로직을 구현하고 있어서 별도 구현 없이 동작을 관찰할 수 있습니다.

Llama 계열 모델을 로컬에 내려받은 환경에서, `num_assistant_tokens`로 Draft가 한 번에 제안할 토큰 수를 지정합니다.

```python
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch, time

target_id = "meta-llama/Llama-3.1-8B-Instruct"
draft_id  = "meta-llama/Llama-3.2-1B-Instruct"

tokenizer    = AutoTokenizer.from_pretrained(target_id)
target_model = AutoModelForCausalLM.from_pretrained(
    target_id, torch_dtype=torch.float16, device_map="auto"
)
draft_model  = AutoModelForCausalLM.from_pretrained(
    draft_id,  torch_dtype=torch.float16, device_map="auto"
)

prompt = "Explain the difference between TCP and UDP in simple terms."
inputs = tokenizer(prompt, return_tensors="pt").to(target_model.device)

# 기준: 타깃 모델 단독 생성
t0 = time.perf_counter()
out_base = target_model.generate(**inputs, max_new_tokens=100)
t_base   = time.perf_counter() - t0

# Speculative Decoding: Draft가 5개씩 제안
t1 = time.perf_counter()
out_spec = target_model.generate(
    **inputs,
    assistant_model=draft_model,
    num_assistant_tokens=5,    # k값: Draft 한 번에 5개 제안
    max_new_tokens=100,
)
t_spec = time.perf_counter() - t1

# 결과: GPU 사양에 따라 다르지만 출력 내용은 동일합니다
print(f"기본 생성:             {t_base:.2f}s")
print(f"Speculative Decoding: {t_spec:.2f}s")
```

두 경로의 출력 텍스트는 의미가 동일합니다. Speculative Decoding이 출력 분포를 바꾸지 않기 때문입니다. `num_assistant_tokens` 값을 1, 3, 5, 10으로 바꿔가며 실행해 보면, 어느 지점부터 이점이 사라지거나 역전되는지 직접 확인할 수 있습니다.

---

## 수용률과 처리량의 트레이드오프

### 수용률이 핵심 지표인 이유

Speculative Decoding의 실질적인 속도 이점은 **수용률(acceptance rate)**에 따라 결정됩니다. 수용률이란 Draft 모델이 제안한 토큰 중 타깃 모델이 실제로 채택하는 비율입니다.

수용률이 높으면 한 번의 타깃 포워드 패스로 여러 토큰을 확정할 수 있습니다. 수용률이 낮으면 Draft 모델의 연산 비용만 추가로 발생하고 이득은 거의 없습니다. ==수용률이 충분히 높지 않아 타깃 단독보다 처리량이 낮다면, Draft 모델을 더 크거나 도메인에 특화된 모델로 교체해야 합니다.==

수용률은 프롬프트 유형에 따라 크게 달라집니다. 코드 자동완성처럼 다음 토큰이 어느 정도 예측 가능한 작업에서는 높아지고, 창의적 글쓰기나 오픈 엔드 질문처럼 여러 경로가 가능한 작업에서는 낮아집니다. 아래 코드로 워크로드별 수용률을 빠르게 비교할 수 있습니다.

```python
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch

model = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.1-8B-Instruct",
    torch_dtype=torch.float16, device_map="auto"
)
draft_model = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.2-1B-Instruct",
    torch_dtype=torch.float16, device_map="auto"
)
tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-3.1-8B-Instruct")

# 작업 유형별로 수용률이 어떻게 달라지는지 확인합니다
prompts = {
    "코드 자동완성": "def binary_search(arr, target):",
    "사실 질의":    "What is the capital of France?",
    "창의적 글쓰기": "Write a poem about autumn leaves.",
}

for label, prompt in prompts.items():
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    out = model.generate(
        **inputs,
        assistant_model=draft_model,
        num_assistant_tokens=5,
        max_new_tokens=60,
        return_dict_in_generate=True,
    )
    # 생성된 토큰 수로 처리 경향을 간접 확인합니다
    n_new = out.sequences.shape[1] - inputs["input_ids"].shape[1]
    print(f"[{label}] 생성 토큰: {n_new}")
```

코드 자동완성에서 생성 속도가 가장 빠른 경향이 있고, 창의적 글쓰기에서는 이점이 줄어드는 경향을 관찰할 수 있습니다.

### Draft 길이 k와 처리량의 균형

Draft 길이(k)를 늘리면 수용될 때의 이득이 커지지만, 거부됐을 때의 낭비도 함께 커집니다. 이 관계는 항상 수용률과 함께 봐야 합니다.

```diagram
2026-10-21-39f56a15-02
```

k를 크게 잡을수록 이득이 커지는 구조이지만, 거부가 잦은 작업에서는 오히려 손실입니다. 서빙 환경에서는 k를 3~7 사이로 시작해 수용률을 측정하면서 조정하는 방식이 일반적입니다.

배치 처리 환경에서는 추가 고려가 필요합니다. 배치 안에서 요청마다 수용률이 다르면 일부는 k개를 확정하고 나머지는 중간에 거부돼 토큰 길이가 달라집니다. 이 불균형이 배치 내 대기를 만들기 때문에, 배치 크기가 클수록 Speculative Decoding의 이점이 줄어드는 경향이 있습니다. 소규모 배치나 스트리밍 단일 요청 환경에서 효과가 더 뚜렷합니다.

---

## 운영 환경에서 겪는 함정과 대응

### 메모리와 첫 토큰 지연

Speculative Decoding을 도입하면 GPU 메모리 사용량이 늘어납니다. 타깃 모델과 Draft 모델을 동시에 올려야 하기 때문입니다. 70B 타깃 모델에 3B Draft 모델을 붙이면 Draft 모델의 파라미터와 KV 캐시가 추가로 필요합니다.

==메모리 여유 없이 Speculative Decoding을 붙이면 OOM 재시작 비용이 속도 이점을 넘어설 수 있습니다.== fp16 기준으로 파라미터 수(십억) × 2GB가 파라미터 스토리지만의 하한 추정값입니다. 3B Draft 모델은 약 6GB, 7B는 약 14GB가 기준이 되지만, KV 캐시와 활성화 메모리는 별도로 잡아야 합니다. 실제 VRAM 요구량은 배치 크기와 시퀀스 길이에 따라 이 하한보다 상당히 커질 수 있습니다.

TTFT(Time-to-First-Token), 즉 첫 토큰까지 걸리는 시간도 주의해야 합니다. Speculative Decoding은 전체 처리량을 높이는 방법이지 첫 응답 지연을 줄이는 방법이 아닙니다. Draft 생성 단계가 추가되기 때문에 오히려 첫 토큰이 늦어질 수 있습니다. 스트리밍 응답에서 사용자가 첫 글자를 보기까지의 시간이 중요한 서비스라면 반드시 측정해야 합니다.

```diagram
2026-10-21-39f56a15-03
```

메모리가 빠듯한 환경이라면 Draft 모델을 4비트 양자화해 올리는 것도 하나의 선택입니다. 수용률이 조금 낮아질 수 있지만 메모리 부담을 줄일 수 있습니다.

### 모니터링해야 할 지표

운영 환경에서 Speculative Decoding이 실제로 도움이 되는지 판단하려면 다음 지표를 함께 봐야 합니다.

| 지표 | 의미 | 목표 방향 |
|---|---|---|
| Acceptance Rate | Draft 토큰 수용 비율 | 50% 이상 권장 |
| Tokens/s (타깃 단독) | 기준값 | 먼저 측정 필요 |
| Tokens/s (Speculative) | 도입 후 처리량 | 기준보다 높아야 의미 있음 |
| Draft Overhead | Draft 생성에 쓰는 시간 비율 | 낮을수록 좋음 |
| TTFT | 첫 토큰까지 걸리는 시간 | 도입 후 증가 여부 반드시 확인 |

### 프레임워크 선택

현업 서빙 환경에서는 직접 구현보다 프로덕션 프레임워크의 Speculative Decoding 지원을 활용하는 경우가 많습니다.

| 프레임워크 | 지원 여부 | 특징 | 권장 상황 |
|---|---|---|---|
| vLLM | ✅ (0.3+) | `--speculative-model` 파라미터, 배치 최적화 | 배치 최적화가 필요할 때 |
| TGI (Hugging Face) | ✅ | Docker 인자로 Draft 모델 지정 | 빠른 실험·프로토타이핑 |
| TensorRT-LLM | ✅ | NVIDIA 환경 최적화, Draft-Target 통합 | NVIDIA GPU 전용 최대 성능 |
| llama.cpp | 부분 지원 | `--draft` 플래그, CPU 환경 포함 | CPU·엣지 환경 |

배치 최적화가 필요하면 vLLM, NVIDIA GPU 전용 환경에서 최대 성능을 끌어내려면 TensorRT-LLM이 적합합니다. vLLM을 쓴다면 서버 실행 시 `--speculative-model`과 `--num-speculative-tokens`를 지정하면 됩니다. 배치 스케줄링, KV 캐시 공유, 수용률에 따른 동적 조정을 프레임워크가 대부분 처리해 줍니다. 직접 기각 샘플링 로직을 구현할 일은 연구 목적이나 커스텀 Draft 모델을 쓰는 경우에 한합니다.

---

## 맺음말

Speculative Decoding은 타깃 모델의 출력 분포를 전혀 바꾸지 않으면서 추론 속도를 높이는 방법입니다. Draft 모델이 후보를 빠르게 제안하고 타깃 모델이 한 번의 포워드 패스로 병렬 검증하는 구조 덕분에, 메모리 대역폭이 병목인 LLM 서빙 환경에서 처리량을 끌어올릴 수 있습니다.

적용 여부를 판단할 때 체크해야 할 기준은 세 가지입니다. 첫째, 타깃 모델과 어휘를 공유하는 Draft 모델이 존재하는가. 둘째, GPU에 Draft 모델을 추가로 올릴 메모리 여유가 있는가(파라미터 스토리지 하한 외에 KV 캐시·활성화 메모리까지 포함해서). 셋째, 서비스가 전체 처리량 최대화를 우선하는가, 아니면 첫 토큰 지연을 최소화하는가.

코드 자동완성이나 문서 요약처럼 다음 토큰이 어느 정도 예측 가능한 작업에서는 수용률이 높아 이점이 뚜렷합니다. 창의적 생성이나 오픈 엔드 대화처럼 분포가 다양한 작업에서는 수용률을 먼저 측정해야 실제 이점을 확인할 수 있습니다. Speculative Decoding은 만능 가속기가 아니라, 수용률이 충분히 높을 때 비로소 효과가 나타나는 조건부 최적화 기법입니다.
