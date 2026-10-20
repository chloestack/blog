---
title: "DPO로 LLM 정렬 파인튜닝하기 — RLHF 없이 선호도 학습 구현"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM 정렬", "TRL", "LoRA"]
excerpt: "채점 모델과 강화학습 없이 비교 데이터만으로 LLM을 다듬는 DPO를 입문 개발자 눈높이로 설명하고, TRL DPOTrainer로 학습해 rewards/accuracies로 결과를 확인하는 법까지 정리했습니다."
---

## 목차

1. 개요
2. DPO는 무엇을 학습하는가
3. TRL DPOTrainer로 구현하고 학습 지표로 확인하기
4. RLHF·IPO·KTO·ORPO 중 무엇을 고를까
5. DPO 학습이 실패할 때 확인할 것
6. 맺음말

---

## 개요

이 글을 읽고 나면 DPO가 무엇을 하는지 이해하고, TRL 라이브러리로 직접 학습을 돌려 학습 지표로 결과를 판단할 수 있습니다. DPO(Direct Preference Optimization)는 "이 답변이 저 답변보다 낫다"는 비교 데이터만으로 LLM의 답변 품질을 다듬는 학습 방법입니다. LLM을 API로 써 봤지만 직접 학습시켜 본 적은 없는 개발자를 기준으로 설명합니다.

### 왜 "더 나은 답변"을 따로 가르쳐야 하나

LLM은 두 단계를 거쳐 만들어집니다. 먼저 인터넷 규모의 글로 다음 단어를 예측하도록 학습하고(사전 학습), 그다음 "질문 → 모범 답안" 쌍으로 한 번 더 학습해 질문에 답하는 법을 익힙니다. 뒤 단계를 SFT(지도 파인튜닝)라고 부릅니다.

SFT까지 마친 모델은 답은 하지만, 정답이 여러 개일 때 어느 쪽이 더 좋은지는 모릅니다. 예를 들어 "파이썬 리스트 중복 제거 방법"을 물었을 때 아래 두 답변은 둘 다 틀리지 않았지만, 사람은 대개 A를 더 낫다고 고릅니다.

| | 답변 | 사람의 선택 |
|---|---|---|
| A (chosen) | `dict.fromkeys()`를 쓰면 순서를 유지한 채 중복을 제거합니다. | 선호 |
| B (rejected) | for문으로 돌리면 됩니다. | 비선호 |

이렇게 사람의 선호에 맞춰 모델을 다듬는 작업을 **정렬**(alignment)이라고 합니다.

### 기존 방법 RLHF는 왜 무거운가

정렬의 표준은 RLHF였습니다. RLHF는 먼저 위와 같은 비교 데이터로 답변에 점수를 매기는 **채점 모델**(보상 모델)을 따로 학습하고, 그다음 모델이 답변을 생성하면 채점 모델이 점수를 매기고 그 점수가 오르도록 모델을 고치는 **강화학습**(PPO) 루프를 돌립니다. 이 과정에서 모델 네 벌을 동시에 GPU에 올려야 하고, 설정을 조금만 잘못 잡아도 점수만 오르고 답변은 이상해지는 문제가 생깁니다.

```diagram
2026-10-20-c7b9f4df-01
```

==DPO는 채점 모델과 강화학습을 없애고, 비교 데이터로 모델을 직접 학습하는 한 단계로 줄인 방법입니다.== Rafailov 등이 2023년 발표한 논문 ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290)에서 나왔습니다.

---

## DPO는 무엇을 학습하는가

한 문장으로 줄이면, ==DPO는 선호 답변이 나올 확률은 올리고 비선호 답변이 나올 확률은 내리되, 학습 전 모델에서 너무 멀어지지 않게 합니다.==

### 직관: 원래 모델과 비교해서 움직인다

언어 모델은 답변을 만들 때 각 문장이 나올 확률을 계산합니다. DPO는 비교 쌍마다 "A가 나올 확률"과 "B가 나올 확률"을 보고 A 쪽이 더 커지도록 모델을 조금씩 고칩니다.

이때 기준이 되는 것이 **참조 모델**입니다. 참조 모델은 학습을 시작하기 전의 SFT 모델을 그대로 얼려 둔 복사본입니다. DPO는 확률의 절댓값이 아니라 "참조 모델보다 얼마나 올랐나"를 비교합니다. 그래서 원래도 잘 만들던 답변은 거의 건드리지 않고, 원래 모델이 잘못 고르던 쌍에서 크게 움직입니다. 비교 기준이 있기 때문에 선호 데이터에 맞추려다 원래 갖고 있던 언어 능력을 잃는 일도 줄어듭니다.

| 용어 | 뜻 |
|---|---|
| 학습 모델 (π_θ) | 지금 고치고 있는 모델 |
| 참조 모델 (π_ref) | 학습 전 SFT 모델의 얼린 복사본. 비교 기준 |
| β (beta) | 참조 모델에 얼마나 붙잡아 둘지 정하는 값. 크면 덜 움직이고 작으면 많이 움직임 |
| chosen / rejected | 비교 쌍에서 선호 답변 / 비선호 답변 |

> TRL의 기본값 β=0.1에서 시작해, 답변 문장이 어색해지면 올리고 정렬 효과가 약하면 내립니다.

### 수식으로 보기 (건너뛰어도 됩니다)

위 직관을 그대로 식으로 옮긴 것이 DPO 손실입니다. x는 질문, y_w는 chosen, y_l은 rejected입니다.

```
L_DPO  =  −log σ( β·log(π_θ(y_w|x) / π_ref(y_w|x))  −  β·log(π_θ(y_l|x) / π_ref(y_l|x)) )
```

괄호 안 앞쪽은 "chosen이 참조 모델보다 얼마나 더 잘 나오나", 뒤쪽은 "rejected가 얼마나 더 잘 나오나"이고, 손실은 앞쪽이 뒤쪽보다 클수록 작아집니다. 논문의 핵심은 RLHF의 채점 점수를 이 확률 비율로 바꿔 쓸 수 있음을 보인 데 있습니다. 그래서 채점 모델을 따로 만들 필요가 없습니다. 여기서 σ(시그모이드)는 점수 차이를 0~1 사이 "A를 고를 확률"로 바꾸는 함수이고, 이 계산 방식을 Bradley-Terry 모델이라고 부릅니다.

---

## TRL DPOTrainer로 구현하고 학습 지표로 확인하기

코드는 짧습니다. 결과를 가르는 것은 **어떤 비교 쌍을 넣느냐**와 **학습 중 지표를 읽는 법**입니다.

### 데이터: 차이가 분명한 쌍만 남긴다

DPO 데이터는 `prompt`(질문), `chosen`, `rejected` 세 열로 된 표입니다. 사람이 직접 고르거나([HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf)), 강한 모델에게 채점을 맡겨 만듭니다([UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback)). 모델 채점은 싸지만 채점한 모델의 취향이 그대로 옮겨옵니다.

==두 답변의 품질 차이가 작은 쌍은 학습 전에 뺍니다.== 둘이 거의 같으면 모델이 "어느 쪽으로 가라"는 방향을 배울 수 없어 신호가 아니라 잡음이 되기 때문입니다. 기준 점수 차이는 정해진 값이 없으니 몇 가지로 나눠 학습해 보고 같은 평가 질문 세트로 비교해 정합니다.

### 핵심 구현

이미 SFT를 마친 모델에서 시작합니다. 아래 코드는 모델 전체가 아니라 **LoRA**라는 작은 추가 가중치만 학습합니다. 원래 가중치는 그대로 두고 일부 층에 얇은 보정 층을 붙여 그것만 고치는 방식이라, 일반 GPU에서도 돌릴 수 있습니다.

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

학습률(`learning_rate`, 한 번에 가중치를 얼마나 고칠지)을 SFT보다 훨씬 낮게 잡는 이유는, DPO가 이미 쓸 만한 모델을 조금만 다듬는 단계이기 때문입니다.

### 학습 지표로 정렬이 되는지 판단하기

학습 중에는 DPO가 계산한 점수가 로그로 찍힙니다. 이 점수는 위에서 본 "참조 모델 대비 확률이 얼마나 올랐나"이며, 채점 모델 없이 얻는 점수라는 뜻에서 **암묵적 보상**이라고 부릅니다.

==가장 먼저 볼 지표는 `rewards/accuracies`이고, 0.5 아래에 계속 머물면 모델이 거꾸로 배우고 있다는 뜻입니다.== 0.5는 동전 던지기와 같은 수준입니다.

| 지표 | 뜻 | 정상 | 이상 신호 |
|---|---|---|---|
| `rewards/accuracies` | chosen 점수가 rejected보다 높은 쌍의 비율 | 0.5에서 꾸준히 오름 | 0.5 아래로 하락 |
| `rewards/margins` | chosen과 rejected 점수의 평균 차이 | 꾸준히 벌어짐 | 줄어들거나 음수 |
| `rewards/chosen` | chosen 답변의 점수 | 오르거나 rejected보다 덜 내려감 | rejected와 같이 크게 떨어짐 |
| `train/loss` | DPO 손실 | 이론상 log 2(약 0.69) 근처에서 시작해 감소 | 급등 또는 NaN |

손실이 log 2 근처에서 시작하는 것은 처음에는 학습 모델과 참조 모델이 같아 chosen과 rejected를 구분하지 못하기 때문입니다. 반대로 `rewards/accuracies`가 초반에 1 가까이 치솟으면 데이터를 외우는 중일 수 있으니, 학습에 쓰지 않은 쌍에서도 같은 지표를 봅니다.

---

## RLHF·IPO·KTO·ORPO 중 무엇을 고를까

==비교 쌍 데이터와 SFT 모델이 있고 데이터가 비교적 깨끗하다면 DPO가 기본 선택입니다.== 다른 방법은 이 전제 중 하나가 깨질 때 고릅니다.

```diagram
2026-10-20-c7b9f4df-05
```

| 방법 | 한 줄 설명 | 필요한 데이터 | 언제 고르나 |
|---|---|---|---|
| RLHF + PPO | 채점 모델을 만들고 강화학습으로 점수를 올림 | 비교 쌍 | 채점 기준을 계속 바꿔 가며 반영해야 하고 GPU 여유가 클 때 |
| DPO | 비교 쌍으로 직접 학습 | 비교 쌍 | 빠르게 여러 번 실험하고 싶을 때 |
| IPO | DPO에 과하게 맞추지 않도록 제약을 더함 | 비교 쌍 | 잘못 고른 쌍이 많이 섞여 있을 때 |
| KTO | 쌍 없이 답변 하나마다 좋음/나쁨만 보고 학습 | 답변 + 좋음/나쁨 | 같은 질문에 대한 두 답변을 모으기 어려울 때 |
| ORPO | SFT와 정렬을 한 번에 학습 | 비교 쌍 | 아직 SFT 모델이 없을 때 |

KTO는 상담 로그의 만족/불만족 버튼처럼 이미 쌓인 피드백을 그대로 쓸 수 있다는 점이 가장 큰 장점입니다. 반대로 채점 기준을 코드로 명확히 정의할 수 있고 그 기준이 자주 바뀐다면, RLHF의 무게를 감수할 이유가 생깁니다.

---

## DPO 학습이 실패할 때 확인할 것

DPO가 실패하는 모습은 대부분 세 가지입니다. 아래 순서대로 보면 원인을 빨리 좁힐 수 있습니다.

```diagram
2026-10-20-c7b9f4df-06
```

### 세 가지 실패와 대처

1. **문장이 어색해짐.** 선호 방향은 맞는데 일반 답변 품질이 떨어집니다. 학습률이 높거나 비교 데이터가 한 분야에 몰렸을 때 생깁니다. 학습률을 낮추고, 정렬과 관계없는 일반 질문으로 학습 전후 답변을 비교해 봅니다.
2. **거꾸로 학습.** `rewards/accuracies`가 0.5 아래에 머뭅니다. chosen과 rejected 열이 뒤바뀌지 않았는지 먼저 보고, 학습률과 β를 다시 봅니다. ==참조 모델은 반드시 SFT를 마친 모델이어야 하며, 사전 학습만 한 모델을 쓰면 비교 기준 자체가 틀어집니다.==
3. **답변이 점점 길어짐.** 사람이 "더 자세한 쪽"을 고르는 경향이 데이터에 남은 결과입니다. 비교 기준에 길이가 아니라 정확성으로 고르라는 지침을 넣습니다.

### 쌍마다 점수를 직접 확인하기

학습이 끝난 모델로 학습에 쓰지 않은 쌍의 점수를 직접 계산해 보면, 지표 평균에 가려진 문제를 찾을 수 있습니다. 위 코드처럼 LoRA로 학습했다면 LoRA를 끈 같은 모델이 곧 참조 모델입니다.

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

chosen보다 rejected 점수가 높게 나온 쌍의 비율을 기록해 두고, 다음 학습에서 그 비율이 오르면 데이터나 β를 다시 봅니다.

### GPU 메모리가 부족할 때

| 기법 | 하는 일 | 대가 |
|---|---|---|
| LoRA + `ref_model=None` | 작은 보정 층만 학습하고, 참조 모델을 따로 올리지 않음 | 모델 전체를 고칠 때보다 바꿀 수 있는 폭이 좁음 |
| gradient checkpointing | 학습 중간 계산값을 저장하지 않고 필요할 때 다시 계산 | 학습이 느려짐 |
| Flash Attention 2 | 어텐션 계산을 메모리를 덜 쓰는 방식으로 바꿈 | 지원하는 GPU가 정해져 있음 |

얼마나 줄어드는지는 모델 크기와 입력 길이에 따라 다르므로, 같은 설정에서 `torch.cuda.max_memory_allocated()`로 켜기 전후를 직접 비교합니다([Hugging Face 학습 메모리 최적화 문서](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

---

## 맺음말

### 핵심 요약

- DPO는 "A가 B보다 낫다"는 비교 쌍으로, 학습 전 모델과 비교해 A 쪽 확률을 올리는 방법입니다. 채점 모델과 강화학습이 필요 없습니다.
- 결과를 가르는 것은 코드보다 데이터입니다. 품질 차이가 분명한 쌍만 남깁니다.
- 학습 중에는 `rewards/accuracies`와 `rewards/margins`를 먼저 보고, 0.5 아래로 떨어지면 데이터 방향·학습률·β를 점검합니다.

### 적용 판단 기준

==DPO를 시작하기 전에 SFT를 마친 모델, 차이가 분명한 비교 쌍, 무엇을 고치고 싶은지 세 가지가 있는지 확인합니다.== SFT 모델이 없으면 ORPO를, 비교 쌍을 만들 수 없고 좋음/나쁨 피드백만 있으면 KTO를 먼저 검토합니다. 일반 어시스턴트 답변을 다듬는 것이 목적이라면 공개 비교 데이터셋과 DPO 한 번으로 시작해 결과를 보며 반복하는 편이 가장 빠릅니다.
