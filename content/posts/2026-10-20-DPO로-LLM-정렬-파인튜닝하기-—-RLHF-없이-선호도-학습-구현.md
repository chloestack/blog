---
title: "DPO로 LLM 정렬 파인튜닝하기 — RLHF 없이 선호도 학습 구현"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM 정렬", "TRL", "LoRA"]
excerpt: "보상 모델과 PPO 없이 선호도 쌍만으로 LLM을 정렬하는 DPO의 원리와 TRL DPOTrainer 구현, beta 조정, 마진 필터링, 학습 지표 읽는 법을 정리했습니다."
---

## 목차

1. 개요
2. DPO 손실 함수는 어디서 나오는가
3. TRL DPOTrainer로 구현하고 학습 지표로 확인하기
4. RLHF·IPO·KTO·ORPO 중 무엇을 고를까
5. DPO 학습 실패 진단과 메모리 최적화
6. 맺음말

---

## 개요

이 글을 읽고 나면 DPO 손실 함수가 어디서 나오는지 이해하고, TRL `DPOTrainer`로 학습을 돌리고, 학습 지표만 보고 정렬이 제대로 되는지 판단할 수 있습니다. DPO(Direct Preference Optimization)는 보상 모델과 강화학습 없이 "A가 B보다 낫다"는 선호도 쌍만으로 LLM을 정렬하는 방법이며, 마지막에는 RLHF·IPO·KTO·ORPO 중 무엇을 고를지 판단 기준을 정리합니다.

### RLHF에서 무엇이 무거운가

사전 학습과 SFT(지도 파인튜닝)만 마친 모델은 "어떤 응답이 더 나은가"라는 기준을 배우지 못합니다. 이 간극을 메우는 정렬(alignment)의 표준은 오랫동안 RLHF였습니다. RLHF는 SFT 모델 위에서 **보상 모델 학습**과 **PPO 강화학습**을 차례로 거칩니다. PPO 단계에서는 정책·참조·보상·가치 모델 네 개를 동시에 GPU에 올리고, 응답을 생성하고 채점하고 갱신하는 루프를 돌립니다. 클리핑과 KL 계수를 잘못 잡으면 보상만 올라가고 응답은 망가지는 보상 해킹(reward hacking)이 생겨 실험 횟수도 늘어납니다.

```diagram
2026-10-20-c7b9f4df-01
```

==DPO는 RLHF의 보상 모델 학습과 PPO 두 단계를, 선호도 데이터로 직접 학습하는 한 단계로 바꿉니다.== 이 아이디어는 Rafailov 등이 2023년 발표한 논문 ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290)에서 나왔습니다.

---

## DPO 손실 함수는 어디서 나오는가

결론부터 말하면, DPO는 RLHF와 같은 목표를 풀되 보상을 "학습 중인 모델과 참조 모델의 확률 비율"로 바꿔 써서 보상 모델을 없앱니다. 수식 세 줄이면 그 과정이 보입니다.

### RLHF 목표에서 DPO 손실까지

RLHF는 기대 보상을 높이되 참조 정책 π_ref(SFT 모델)에서 너무 멀어지지 않도록 KL 항으로 제약을 겁니다.

```
max_π  E[r(x, y)]  −  β · KL[π(·|x) ∥ π_ref(·|x)]
```

이 문제의 최적 정책은 닫힌 형태로 존재하고, 그 식을 보상 r에 대해 거꾸로 풀면 보상을 두 정책의 로그 비율로 쓸 수 있습니다.

```
r(x, y)  =  β · log(π*(y|x) / π_ref(y|x))  +  β · log Z(x)
```

선호 확률을 보상 차이의 시그모이드로 보는 **Bradley-Terry 모델** P(y_w ≻ y_l) = σ(r(x, y_w) − r(x, y_l))에 이 식을 넣으면, 프롬프트 x에만 의존하는 Z(x)가 빼기에서 상쇄됩니다. 남는 것이 DPO 손실입니다. y_w는 선호 응답(chosen), y_l은 비선호 응답(rejected)입니다.

```
L_DPO  =  −E[ log σ( β log(π_θ(y_w|x)/π_ref(y_w|x))  −  β log(π_θ(y_l|x)/π_ref(y_l|x)) ) ]
```

### 손실이 실제로 하는 일

==DPO는 선호 응답의 확률을 무작정 올리는 것이 아니라, 참조 모델 대비 상승폭이 비선호 응답보다 커지도록 학습합니다.== 참조 모델이 이미 잘 만드는 응답은 비율이 크게 변하지 않아 덜 움직이고, 참조 모델이 못하던 쪽을 고칠 때 신호가 커집니다.

β는 이 비율에 곱해지는 KL 계수입니다. 크면 참조 모델 근처에 머물고, 작으면 선호도 쪽으로 더 멀리 움직입니다.

> TRL `DPOConfig`의 기본값 β=0.1에서 시작해, 언어 능력이 무너지면 올리고 정렬 효과가 약하면 내립니다.

Bradley-Terry 모델은 응답이 여러 측면에서 우열이 엇갈리는 경우(정확하지만 장황한 응답 대 간결하지만 부정확한 응답)를 잘 표현하지 못합니다. 이 한계를 다루는 IPO·KTO는 4장에서 비교합니다.

---

## TRL DPOTrainer로 구현하고 학습 지표로 확인하기

구현 자체는 짧습니다. 품질을 가르는 것은 코드보다 **데이터 마진**과 **학습 지표를 읽는 법**입니다.

### 데이터: 품질 차이가 작은 쌍은 뺀다

DPO 데이터는 `prompt`, `chosen`, `rejected` 세 열입니다. 사람이 두 응답을 비교해 고르거나([HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf)), GPT-4 같은 강한 모델이 채점해 만듭니다([UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback)). AI 심판은 싸지만 심판 모델의 편향이 그대로 옮겨옵니다.

==채점 점수 차이가 작은 쌍은 학습 전에 뺍니다.== 두 응답의 품질이 거의 같으면 Bradley-Terry 식에서 선호 확률이 0.5 근처에 머물러, 모델에게 방향이 거의 없는 신호만 주기 때문입니다. 임계값은 정해진 값이 없으므로 몇 가지 값으로 나눠 학습하고 같은 평가 세트에서 비교해 정합니다. 프롬프트 유형이 한쪽에 몰려 있지 않은지도 함께 봅니다.

### 핵심 구현

SFT 체크포인트가 있다고 가정합니다. `trl-lib/ultrafeedback_binarized`는 UltraFeedback을 쌍 형식으로 바꾼 공개 데이터셋입니다.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from datasets import load_dataset
from peft import LoraConfig, get_peft_model

model_name = "meta-llama/Llama-3.2-3B-Instruct"

# LoRA로 작은 어댑터만 학습한다. 모델이 클수록 사실상 필수다.
lora_cfg = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "v_proj"])
model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype="auto")
model = get_peft_model(model, lora_cfg)

# PEFT 모델을 넘기면 ref_model=None으로 두어도 된다.
# TRL이 어댑터를 끈 상태로 참조 확률을 계산하므로 모델을 한 벌 더 올리지 않는다.
ref_model = None
tokenizer = AutoTokenizer.from_pretrained(model_name)
tokenizer.pad_token = tokenizer.eos_token

dataset = load_dataset("trl-lib/ultrafeedback_binarized", split="train")

training_args = DPOConfig(
    output_dir="./llama3-dpo",
    num_train_epochs=1,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    learning_rate=5e-7,       # SFT보다 훨씬 낮게 시작한다
    beta=0.1,                 # KL 계수 — 가장 먼저 조정할 값
    max_length=1024,
    max_prompt_length=512,
    bf16=True,
    logging_steps=10,
)

trainer = DPOTrainer(
    model=model,
    ref_model=ref_model,
    args=training_args,
    train_dataset=dataset,
    processing_class=tokenizer,  # 이전 버전 TRL에서는 tokenizer=
)
trainer.train()
# 결과: ./llama3-dpo/checkpoint-*에 LoRA 어댑터와 학습 상태가 저장된다
```

학습률을 SFT보다 훨씬 낮게 잡는 이유는 DPO가 이미 쓸 만한 모델을 조금만 움직이는 단계이기 때문입니다.

### 학습 지표로 정렬이 되는지 판단하기

==가장 먼저 볼 지표는 `rewards/accuracies`이고, 0.5 아래에 계속 머물면 모델이 거꾸로 배우고 있다는 뜻입니다.== 0.5는 무작위로 고른 것과 같은 수준입니다. 학습 초반 몇 스텝의 흔들림이 아니라 추세로 봅니다.

| 지표 | 뜻 | 정상 | 이상 신호 |
|---|---|---|---|
| `rewards/accuracies` | chosen 보상이 rejected보다 높은 쌍의 비율 | 0.5에서 꾸준히 올라감 | 0.5 아래로 하락 |
| `rewards/margins` | chosen과 rejected 보상의 평균 차이 | 꾸준히 벌어짐 | 줄어들거나 음수 |
| `rewards/chosen` | chosen 응답의 암묵적 보상 | 오르거나 rejected보다 덜 내려감 | rejected와 같이 크게 떨어짐 |
| `train/loss` | DPO 손실 | 시작값 log 2에서 감소 | 급등 또는 NaN |

손실이 log 2에서 시작하는 것은 학습 모델이 참조 모델과 같은 상태에서 출발해 손실이 −log σ(0)이 되기 때문입니다. 반대로 `rewards/accuracies`가 초반에 1 가까이 치솟으면 데이터를 외우는 중일 수 있으니, 학습에 쓰지 않은 평가 세트에서도 같은 지표를 봅니다.

---

## RLHF·IPO·KTO·ORPO 중 무엇을 고를까

==쌍 데이터와 SFT 체크포인트가 있고 레이블이 비교적 깨끗하다면 DPO가 기본 선택입니다.== 나머지 방법은 이 전제 중 하나가 깨질 때 고릅니다.

```diagram
2026-10-20-c7b9f4df-05
```

| 방법 | 보상 모델 | 학습 데이터 | 언제 고르나 | 주의점 |
|---|---|---|---|---|
| RLHF + PPO | 필요 | 쌍 | 보상 신호를 계속 갱신해야 하고 인프라가 충분할 때 | 모델 4개 동시 적재, 튜닝 부담이 큼 |
| DPO | 불필요 | 쌍 | 쌍 데이터가 있고 빠르게 반복하고 싶을 때 | 노이즈가 많으면 과적합 |
| IPO | 불필요 | 쌍 | 레이블 노이즈가 많을 때 | 손실에 정규화 항이 추가됨 |
| KTO | 불필요 | 단일 응답 + 좋음/나쁨 | 같은 프롬프트의 쌍을 만들기 어려울 때 | Bradley-Terry 대신 전망 이론 기반 |
| ORPO | 불필요 | 쌍 | SFT 단계가 없을 때 | SFT와 정렬을 한 목적함수로 학습 |

KTO는 상담 로그의 만족/불만족처럼 응답마다 좋음·나쁨만 붙어 있는 데이터를 그대로 쓸 수 있다는 점이 가장 큰 장점입니다. 반대로 보상 함수를 명확히 정의할 수 있고 계속 바뀌는 보상 신호를 반영해야 한다면 RLHF의 무게를 감수할 이유가 생깁니다.

---

## DPO 학습 실패 진단과 메모리 최적화

DPO가 실패하는 모습은 대부분 세 가지로 나뉩니다. 아래 순서대로 확인하면 원인을 빨리 좁힐 수 있습니다.

```diagram
2026-10-20-c7b9f4df-06
```

### 세 가지 실패와 대처

1. **언어 능력 저하.** 정렬은 됐는데 일반 텍스트 품질이 떨어집니다. 학습률이 높거나 선호 데이터가 특정 도메인에 몰렸을 때 생깁니다. 학습률을 낮추고, 그래도 같으면 정렬과 관계없는 일반 질문 세트로 정렬 전후 응답을 비교해 데이터 편중을 확인합니다.
2. **거꾸로 학습.** `rewards/accuracies`가 0.5 아래에 계속 머뭅니다. 학습률과 beta를 다시 보고, 데이터에서 chosen과 rejected가 뒤바뀌지 않았는지도 확인합니다. ==참조 모델은 반드시 SFT 체크포인트여야 하며, 사전 학습만 한 base 모델을 쓰면 KL 항이 제 역할을 못 합니다.==
3. **길이 편향.** 학습할수록 응답이 길어집니다. 레이블러가 "더 자세한 쪽이 더 좋다"고 고르는 경향이 데이터에 남은 결과입니다. 레이블 지침에 길이가 아니라 정확성과 관련성으로 판단하라는 기준을 넣습니다.


### 암묵적 보상으로 학습 방향 검증하기

DPO 모델은 보상 모델을 품고 있으므로, 학습 모델과 참조 모델의 로그 확률 비율로 응답마다 점수를 낼 수 있습니다. 위 학습 코드처럼 `ref_model=None`으로 학습했다면 참조 확률은 어댑터를 끈 같은 모델로 구합니다.

```python
import torch

def compute_implicit_reward(model, tokenizer, prompt, response, beta=0.1):
    """암묵적 보상 r(x,y) = β · log(π_θ / π_ref) — 응답 토큰만 합산한다.
    model은 위에서 학습한 PEFT 모델이다. 어댑터를 끈 같은 모델이 참조 모델이다."""
    prompt_len = len(tokenizer(prompt)["input_ids"])
    inputs = tokenizer(prompt + response, return_tensors="pt").to(model.device)

    with torch.no_grad():
        logits = model(**inputs).logits
        with model.disable_adapter():
            ref_logits = model(**inputs).logits

    log_p = torch.nn.functional.log_softmax(logits, dim=-1)
    ref_log_p = torch.nn.functional.log_softmax(ref_logits, dim=-1)

    # 위치 i의 로짓이 토큰 i+1을 예측한다. 응답 토큰만 더한다.
    token_ids = inputs["input_ids"][0, 1:]
    log_ratio = (log_p[0, :-1] - ref_log_p[0, :-1])
    per_token = log_ratio.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    reward = beta * per_token[prompt_len - 1:].sum()
    return reward.item()

prompt = "파이썬에서 리스트 중복을 제거하는 방법은?"
chosen = "set()으로 변환하거나 dict.fromkeys()를 사용합니다. 순서 유지가 필요하면 후자를 추천합니다."
rejected = "그냥 for문으로 반복하면 됩니다."

r_chosen = compute_implicit_reward(model, tokenizer, prompt, chosen)
r_rejected = compute_implicit_reward(model, tokenizer, prompt, rejected)
# 결과: r_chosen > r_rejected 이면 이 쌍에 대해 선호 방향을 제대로 학습한 것
```

학습에 쓰지 않은 쌍으로 역전 비율을 기록해 두고, 다음 학습에서 그 비율이 오르면 데이터나 beta를 다시 봅니다.

### 메모리 줄이기

| 기법 | 줄이는 것 | 대가 |
|---|---|---|
| LoRA + `ref_model=None` | 옵티마이저 상태, 참조 모델 한 벌 | 학습 가능한 파라미터가 어댑터로 제한됨 |
| gradient checkpointing | 중간 활성값 저장 | 역전파 때 다시 계산해 학습이 느려짐 |
| Flash Attention 2 | 어텐션 행렬 전체 저장 | 지원 GPU·dtype이 정해져 있음, 시퀀스가 길수록 효과가 큼 |

얼마나 줄어드는지는 모델·배치·시퀀스 길이에 따라 다르므로, 같은 설정에서 `torch.cuda.max_memory_allocated()`로 켜기 전후를 비교합니다([Hugging Face 학습 메모리 최적화 문서](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

---

## 맺음말

### 핵심 요약

- DPO는 보상을 학습 모델과 참조 모델의 확률 비율로 바꿔 써서, RLHF의 보상 모델 학습과 PPO를 한 번의 지도 학습 같은 단계로 줄입니다.
- 품질을 가르는 것은 코드보다 데이터 마진입니다. 품질 차이가 작은 쌍은 빼고, 프롬프트 분포를 함께 봅니다.
- 학습 중에는 `rewards/accuracies`와 `rewards/margins`를 먼저 보고, 0.5 아래로 떨어지면 학습률·beta·데이터 방향을 점검합니다.

### 적용 판단 기준

==DPO를 시작하기 전에 SFT 체크포인트, 마진이 충분한 선호도 쌍, 분명한 정렬 목표 세 가지가 있는지 확인합니다.== 셋 중 SFT가 없으면 ORPO를, 쌍을 만들 수 없으면 KTO를 먼저 검토합니다. 안전성이 최우선이거나 형식을 엄격히 지켜야 한다면 DPO를 여러 라운드 반복하거나 RLHF를 검토합니다. 일반 어시스턴트 품질을 높이는 것이 목적이라면 공개 선호도 데이터셋과 DPO 한 라운드로 시작해 결과를 보며 반복하는 편이 가장 빠릅니다.
