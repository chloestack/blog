---
title: "Speculative Decoding으로 LLM 추론 속도 높이기"
date: "2026-10-21 10:40"
category: "AI"
tags: ["Speculative Decoding", "LLM 추론 최적화", "Draft 모델", "vLLM"]
excerpt: "Speculative Decoding은 작은 모델이 먼저 짐작하고 큰 모델이 한 번에 채점해 LLM 응답을 빠르게 만듭니다. 짐작이 자주 틀리면 오히려 느려지는 이유와, Draft 모델·짐작 길이를 고르는 기준을 정리합니다."
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

챗봇 응답이 한 글자씩 느리게 찍히는 건, 큰 모델이 토큰 하나를 만들 때마다 수십 GB의 가중치를 GPU 메모리에서 다시 읽어야 하기 때문입니다. Speculative Decoding은 작은 모델이 다음 몇 토큰을 먼저 짐작하고 큰 모델이 그 짐작을 한 번에 채점하게 해서, 출력은 그대로 두고 응답만 빠르게 만듭니다. 이 기법을 제안한 논문은 같은 출력을 내면서 2~3배 빨라졌다고 보고했습니다([Leviathan et al., 2023](https://arxiv.org/abs/2211.17192)). 다만 작은 모델의 짐작이 자주 틀리면 버려지는 계산만 늘어 오히려 느려집니다. 이 글은 어떤 작은 모델을 고르고 한 번에 몇 토큰을 짐작하게 할지, 켠 뒤 효과가 있는지 어떻게 확인할지를 다룹니다.

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

수용률이 높으면 한 번의 타깃 포워드 패스로 여러 토큰을 확정할 수 있습니다. 수용률이 낮으면 Draft 모델의 연산 비용만 추가로 발생하고 이득은 거의 없습니다. ==Speculative Decoding을 켠 뒤의 tokens/s가 타깃 모델 단독보다 낮다면, 수용률이 이득을 낼 만큼 높지 않다는 뜻입니다. Draft 모델을 타깃과 같은 계열의 더 큰 모델이나 도메인에 맞춘 모델로 바꿔야 합니다.==

수용률은 프롬프트 유형에 따라 크게 달라집니다. 코드 자동완성처럼 다음 토큰이 어느 정도 예측 가능한 작업에서는 높아지고, 창의적 글쓰기나 오픈 엔드 질문처럼 여러 경로가 가능한 작업에서는 낮아집니다. 수용률 자체는 Hugging Face `generate()`가 따로 돌려주지 않지만, 결과적으로 중요한 것은 속도입니다. 아래 코드는 같은 프롬프트를 Draft 모델 없이 한 번, 있이 한 번 돌려 작업 유형별 속도비를 잽니다.

```python
import time
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch

target = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.1-8B-Instruct", torch_dtype=torch.float16, device_map="auto"
)
# 같은 Llama 3 계열이라 어휘(토크나이저)를 공유합니다
draft = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.2-1B-Instruct", torch_dtype=torch.float16, device_map="auto"
)
tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-3.1-8B-Instruct")

prompts = {
    "코드 자동완성": "def binary_search(arr, target):",
    "사실 질의": "What is the capital of France? Explain its history briefly.",
    "창의적 글쓰기": "Write a poem about autumn leaves.",
}

def tokens_per_sec(inputs, **kwargs):
    torch.cuda.synchronize()
    start = time.perf_counter()
    out = target.generate(**inputs, max_new_tokens=128, do_sample=False, **kwargs)
    torch.cuda.synchronize()
    new_tokens = out.shape[1] - inputs["input_ids"].shape[1]
    return new_tokens / (time.perf_counter() - start)

for label, prompt in prompts.items():
    inputs = tokenizer(prompt, return_tensors="pt").to(target.device)
    tokens_per_sec(inputs, max_new_tokens=8)  # 첫 실행의 워밍업 비용을 빼기 위해 한 번 버립니다
    base = tokens_per_sec(inputs)
    spec = tokens_per_sec(inputs, assistant_model=draft, num_assistant_tokens=5)
    print(f"[{label}] 단독 {base:.1f} tok/s, Speculative {spec:.1f} tok/s, 속도비 {spec / base:.2f}")
```

읽는 법은 속도비 하나입니다. 1보다 크면 그 작업에서는 켤 이유가 있고, 1 근처거나 1보다 작으면 Draft 모델이 짐작을 자주 틀려 계산만 늘고 있다는 뜻입니다. 같은 Draft 모델이라도 작업 유형에 따라 속도비가 갈리는 경우가 많으니, 자기 서비스의 실제 프롬프트 몇십 개로 재 보는 것이 출발점입니다.

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

### 켠 뒤 효과를 확인하는 순서

운영 환경에서 Speculative Decoding이 실제로 도움이 되는지는 **켜기 전 값과 비교해야만** 알 수 있습니다. 아래 순서대로 재면 무엇을 바꿔야 하는지까지 정해집니다.

| 순서 | 무엇을 재나 | 이렇게 나오면 |
|---|---|---|
| 1. 켜기 전 | 타깃 단독 tokens/s와 TTFT(첫 토큰까지 걸리는 시간) | 이 두 값이 이후 모든 비교의 기준입니다 |
| 2. 켠 뒤 | 같은 트래픽에서 tokens/s | 기준보다 낮으면 3번으로, 높으면 4번으로 |
| 3. 수용률 확인 | Draft 토큰 중 채택된 비율 | 낮으면 짐작 길이 k를 줄이거나 Draft 모델을 바꿉니다 |
| 4. TTFT 비교 | 켠 뒤 TTFT | 늘었는데 스트리밍 응답이 중요한 서비스라면, 처리량 이득과 첫 글자 지연 중 무엇이 중요한지 정합니다 |

예를 들어 사내 코드 어시스턴트에 vLLM으로 붙였다면, 하루 트래픽을 켜기 전과 켠 뒤로 나눠 tokens/s를 비교하는 것이 첫 단계입니다. 수용률이 높게 나오는 코드 요청과 낮게 나오는 자유 질문이 섞여 있다면, 요청 유형별로 나눠 봐야 평균에 가려진 손해를 찾을 수 있습니다.

### 프레임워크 선택

직접 기각 샘플링을 구현할 일은 거의 없습니다. 이미 쓰고 있는 서빙 프레임워크가 별도 Draft 모델을 지원하는지부터 확인하면 됩니다. 아래 표는 각 공식 문서 기준입니다(2026년 10월 확인).

| 프레임워크 | 별도 Draft 모델 | 켜는 방법 | 이런 경우에 |
|---|---|---|---|
| vLLM | 지원 | `--speculative-config '{"method": "draft_model", "model": "<Draft 모델>", "num_speculative_tokens": 5}'` ([문서](https://docs.vllm.ai/en/latest/features/speculative_decoding/)) | 이미 vLLM으로 서빙 중일 때. 설정 한 줄로 시작할 수 있습니다 |
| TensorRT-LLM | 지원 (Draft-Target) | Draft·타깃 두 모델을 따로 띄우도록 설정 ([문서](https://nvidia.github.io/TensorRT-LLM/advanced/speculative-decoding.html)) | NVIDIA GPU에서 지연을 끝까지 줄여야 할 때 |
| llama.cpp (`llama-server`) | 지원 | `-md <Draft 모델 파일>`, 짐작 길이는 `--spec-draft-n-max` ([문서](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) | 로컬·CPU·엣지 환경 |
| TGI (Hugging Face) | 미지원 | Medusa 헤드가 붙은 모델이나 n-gram(`--speculate`)만 ([문서](https://huggingface.co/docs/text-generation-inference/conceptual/speculation)) | 별도 Draft 모델 방식이 필요하면 다른 프레임워크를 고릅니다 |

결정은 대개 지금 쓰는 스택에서 끝납니다. 이미 vLLM으로 서빙 중이라면 `--speculative-config` 한 줄을 추가하고 위 순서대로 비교해 보면 됩니다. TGI를 쓰고 있다면 별도 Draft 모델 대신 n-gram 방식을 먼저 시험해 볼 수 있습니다. 반복이 많은 코드·문서 작업에서는 이것만으로도 효과를 볼 수 있습니다. 새로 고르는 상황이고 NVIDIA GPU에서 지연을 끝까지 줄여야 한다면 TensorRT-LLM이 후보지만, vLLM보다 설정할 것이 많습니다.

---

## 맺음말

Speculative Decoding은 타깃 모델의 출력 분포를 전혀 바꾸지 않으면서 추론 속도를 높이는 방법입니다. Draft 모델이 후보를 빠르게 제안하고 타깃 모델이 한 번의 포워드 패스로 병렬 검증하는 구조 덕분에, 메모리 대역폭이 병목인 LLM 서빙 환경에서 처리량을 끌어올릴 수 있습니다.

적용 여부를 판단할 때 체크해야 할 기준은 세 가지입니다. 첫째, 타깃 모델과 어휘를 공유하는 Draft 모델이 존재하는가. 둘째, GPU에 Draft 모델을 추가로 올릴 메모리 여유가 있는가(파라미터 스토리지 하한 외에 KV 캐시·활성화 메모리까지 포함해서). 셋째, 서비스가 전체 처리량 최대화를 우선하는가, 아니면 첫 토큰 지연을 최소화하는가.

코드 자동완성이나 문서 요약처럼 다음 토큰이 어느 정도 예측 가능한 작업에서는 수용률이 높아 이점이 뚜렷합니다. 창의적 생성이나 오픈 엔드 대화처럼 분포가 다양한 작업에서는 수용률을 먼저 측정해야 실제 이점을 확인할 수 있습니다. Speculative Decoding은 만능 가속기가 아니라, 켠 뒤 tokens/s가 타깃 단독보다 높게 나올 때 비로소 효과가 나타나는 조건부 최적화 기법입니다.
