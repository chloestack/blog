---
title: "DPO로 LLM 정렬 파인튜닝하기 — RLHF 없이 선호도 학습 구현"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM 정렬", "TRL", "LoRA"]
excerpt: "보상 모델과 PPO 없이 선호도 쌍만으로 LLM을 정렬하는 DPO의 원리와 TRL DPOTrainer 구현, beta 조정, 마진 필터링, 학습 지표 읽는 법을 정리했습니다."
---

## 목차

1. 개요
2. DPO의 수학적 원리
3. 선호도 데이터 준비와 DPO 구현
4. 성능 특성과 기술 비교
5. DPO 적용 시 흔한 오류와 메모리 최적화
6. 맺음말

---

## 개요

### 선호도 학습이 필요한 이유

DPO(Direct Preference Optimization)는 보상 모델과 강화학습 없이 "A가 B보다 낫다"는 선호도 쌍만으로 LLM을 정렬합니다. 이 글에서는 DPO 손실 함수가 어디서 나오는지, TRL `DPOTrainer`로 어떻게 구현하는지, 학습 지표로 정렬이 제대로 되는지 어떻게 판단하는지, RLHF·IPO·KTO 중 무엇을 고를지를 차례로 정리합니다.

사전 학습(pretraining)만 마친 모델은 인간의 지시를 따르거나 해로운 내용을 피하는 방식을 스스로 유추하지 못합니다. 다음 토큰의 확률을 최대화하는 방향으로만 학습되었기 때문입니다. 이 간극을 메우는 과정이 **정렬(alignment)**입니다. 정렬은 단순히 모델을 "순하게" 만드는 것이 아닙니다. 같은 질문에도 더 정확하고, 더 간결하며, 특정 형식을 준수하는 응답을 생성하도록 모델의 행동 분포를 조정합니다. 기업 환경에서는 브랜드 톤, 보안 정책, 특정 포맷 규약을 언어 모델에 이식하는 수단으로 활용됩니다.

정렬 기술이 없던 시절에는 방대한 지시 데이터를 수집해 지도 학습(SFT, Supervised Fine-Tuning)만으로 이 문제를 해결하려 했습니다. 그러나 SFT는 "어떤 응답이 더 좋은가"라는 비교 정보를 활용하지 못합니다. "이것이 좋은 응답이다"가 아니라 "이것이 저것보다 낫다"는 정보가 훨씬 더 자연스럽게 수집됩니다. 인간 평가자는 빈 화면에서 좋은 응답을 작성하기보다, 두 응답을 나란히 보고 더 나은 쪽을 선택하는 작업이 훨씬 일관성 있고 빠릅니다. 이 비교 기반 선호도 신호를 효과적으로 활용하는 것이 현대 정렬 기법의 핵심입니다.

### RLHF의 구조적 복잡성

RLHF는 세 단계로 구성됩니다. 첫 번째는 지도 학습 방식의 SFT, 두 번째는 인간 레이블로 보상 모델(Reward Model)을 학습하는 단계, 세 번째는 PPO(Proximal Policy Optimization)로 언어 모델을 강화학습하는 단계입니다. 각 단계가 이전 단계의 품질에 종속되어 오류가 누적되기 쉽고, 특히 PPO 단계에서는 SFT 모델, 보상 모델, 현재 정책 모델, 가치 함수(value function) 네 개 모델을 동시에 메모리에 올려야 합니다. 같은 크기의 모델 네 개가 GPU 메모리를 나눠 쓰므로, 모델이 커질수록 단일 GPU로는 감당하기 어려워집니다.

```diagram
2026-10-20-c7b9f4df-01
```

RLHF는 보상 모델이 필요하고 PPO는 불안정합니다. DPO는 두 단계를 하나로 압축합니다.

PPO의 불안정성은 현업에서 자주 보고되는 문제입니다. 보상이 폭발(reward hacking)하거나 KL 페널티가 학습을 억압하는 현상을 방지하기 위해 클리핑 파라미터와 엔트로피 보너스를 세밀하게 조정해야 합니다. 이 과정에서 실험 횟수가 늘어나고 전체 파이프라인 유지 비용이 급증합니다. DPO는 Rafailov 등이 2023년 발표한 논문 ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290)에서 처음 제안되었습니다. KL 제약이 걸린 RLHF 목적함수와 같은 최적 정책을 갖는다는 것을 보이면서, 보상 모델을 언어 모델 자체에 내재화해 파이프라인 단계를 줄입니다.

---

## DPO의 수학적 원리

### RLHF 목적함수와 최적 정책의 닫힌 해

RLHF의 핵심은 다음 목적함수를 최대화하는 정책 π_θ를 찾는 것입니다. 기대 보상을 높이되, 참조 정책 π_ref(SFT 모델)에서 너무 멀어지지 않도록 KL 발산 항으로 제약을 겁니다.

```
max_π  E[r(x, y)]  −  β · KL[π(·|x) ∥ π_ref(·|x)]
```

β가 클수록 참조 모델에서 벗어나기 어려워지므로, β는 정렬 강도와 언어 능력 보존 사이의 균형을 조절합니다. β가 0에 가까워지면 보상을 극대화하기 위해 모델이 비정상적인 텍스트를 생성하는 "보상 해킹(reward hacking)" 현상이 나타납니다. KL 발산 항은 이를 방지합니다.

이 목적함수를 분석하면 최적 정책이 닫힌 형태로 존재합니다.

```
π*(y|x)  ∝  π_ref(y|x) · exp(r(x, y) / β)
```

최적 정책은 참조 정책을 보상에 비례하여 리스케일링한 것입니다. DPO의 핵심 통찰은 이 표현식을 역으로 풀어 보상 r을 두 정책의 비율로 표현하는 데 있습니다.

```
r(x, y)  =  β · log(π*(y|x) / π_ref(y|x))  +  β · log Z(x)
```

여기서 Z(x)는 x에만 의존하는 정규화 상수입니다. Bradley-Terry 선호도 모델에 이 보상 표현식을 대입하면 Z(x) 항이 상쇄되고, 보상 모델 없이 언어 모델의 로그 확률 비율만으로 선호도를 직접 모델링할 수 있게 됩니다.

```diagram
2026-10-20-c7b9f4df-02
```

RLHF 목적함수의 닫힌 해가 DPO 손실 함수 유도의 핵심 근거입니다.

### DPO 손실 함수의 직관적 해석

최종 DPO 손실 함수는 다음과 같이 정리됩니다. π_θ는 학습 중인 정책, π_ref는 참조 정책, y_w는 선호 응답(chosen), y_l은 비선호 응답(rejected), σ는 시그모이드 함수입니다.

```
L_DPO  =  −E[(x,y_w,y_l)] [log σ( β log(π_θ(y_w|x)/π_ref(y_w|x))  −  β log(π_θ(y_l|x)/π_ref(y_l|x)) )]
```

이 수식의 직관은 명확합니다. 선호 응답의 **참조 모델 대비 상대적 로그 확률 증가**가 비선호 응답의 상대적 증가보다 높아지도록 학습합니다. 단순히 "선호 응답의 확률을 높여라"가 아니라는 점이 중요합니다. 참조 모델 대비 비율을 비교하기 때문에, 이미 참조 모델이 잘 생성하는 응답에 대해서는 과도하게 업데이트하지 않습니다. 반대로 참조 모델이 잘 못하는 응답을 개선할 때는 더 큰 그래디언트 신호를 받습니다.

> β는 KL 페널티 계수이자 학습 민감도 조절기입니다. TRL `DPOConfig`의 기본값 0.1에서 시작해, 언어 능력이 무너지면 올리고 정렬 효과가 약하면 내립니다.

### Bradley-Terry 모델과의 연결

DPO가 전제하는 선호도 모델은 **Bradley-Terry 모델**입니다. 이 모델은 응답 A가 B보다 선호될 확률을 두 응답의 보상 점수 차이의 시그모이드 함수로 표현합니다.

```
P(y_w ≻ y_l | x)  =  σ(r(x, y_w) − r(x, y_l))
```

Bradley-Terry 모델은 선호도가 확률적임을 인정합니다. 품질 차이가 클수록 확률이 1에 가까워지고, 두 응답이 비슷하면 0.5에 수렴합니다. 이 특성이 실제 인간 레이블 데이터의 특성과 잘 맞습니다. 동일한 두 응답에 대해 레이블러마다 다른 판단을 내리고, 같은 레이블러도 문맥에 따라 일관성이 달라지는 현실을 잘 포착합니다.

```diagram
2026-10-20-c7b9f4df-03
```

선호도 품질 차이가 클수록 DPO 학습 신호가 명확해지며, 품질이 비슷한 쌍은 필터링하는 것이 유리합니다.

이 전제가 항상 성립하는 것은 아닙니다. 응답이 여러 측면에서 각각 우열이 갈릴 때, 예를 들어 한 응답은 정확하지만 너무 길고 다른 응답은 간결하지만 부정확할 때, Bradley-Terry 모델은 한계를 보입니다. 이 한계를 다루는 IPO·KTO 같은 변형은 뒤의 비교 섹션에서 정리합니다.

---

## 선호도 데이터 준비와 DPO 구현

### 데이터 형식과 수집 전략

DPO 학습에 필요한 데이터는 세 열로 구성됩니다. **프롬프트(prompt)**, **선호 응답(chosen)**, **비선호 응답(rejected)**입니다. 이 단순한 구조 뒤에는 데이터 품질을 결정하는 여러 선택지가 있습니다. 수집 방법은 크게 두 가지입니다.

첫 번째는 **인간 레이블** 방식입니다. 여러 모델이 생성한 응답 쌍을 사람이 직접 비교하여 더 나은 응답을 선택합니다. Anthropic의 [HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf) 데이터셋이 대표적 예시입니다. 일관성이 높고 신뢰할 수 있지만 비용이 많이 듭니다.

두 번째는 **AI 심판(AI judge)** 방식입니다. GPT-4나 Claude 같은 강력한 모델을 심판으로 활용해 자동으로 선호도를 생성합니다. [UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback) 데이터셋은 여러 모델의 응답을 GPT-4가 채점해 만든 대표적인 예이며, 아래 코드에서 쓰는 `trl-lib/ultrafeedback_binarized`는 이를 chosen/rejected 쌍으로 바꾼 것입니다. 비용이 적게 들지만 심판 모델의 편향이 그대로 이식될 수 있습니다.

```diagram
2026-10-20-c7b9f4df-04
```

선호도 데이터 수집 후 반드시 마진 기반 필터링을 거쳐야 학습 신호 품질이 보장됩니다.

데이터 품질을 판단하는 핵심 기준은 **마진(margin)**입니다. 심판 모델이 각 응답에 점수를 매겼다면, chosen과 rejected의 점수 차이가 작은 쌍은 제거합니다. 두 응답이 거의 같은 품질이면 앞의 Bradley-Terry 식에서 선호 확률이 0.5 근처에 머물러, 모델에게 방향이 거의 없는 신호만 주기 때문입니다. 임계값은 정해진 값이 없으므로 몇 가지 값으로 데이터를 나눠 학습해 보고, 같은 평가 세트에서 비교해 정합니다. 또한 **프롬프트 다양성**도 중요합니다. 비슷한 유형의 프롬프트가 반복되면 모델이 특정 패턴에만 최적화되고 일반 능력이 저하됩니다.

### TRL 라이브러리를 이용한 핵심 구현

Hugging Face의 TRL(Transformer Reinforcement Learning) 라이브러리는 `DPOTrainer` 클래스를 제공합니다. 다음은 LLaMA-3 기반 모델에 DPO를 적용하는 예제입니다. SFT 체크포인트가 이미 준비되어 있고, 학습 데이터는 `prompt`, `chosen`, `rejected` 열을 포함하는 Hugging Face Dataset 형식을 사용합니다.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from datasets import load_dataset
from peft import LoraConfig, get_peft_model

model_name = "meta-llama/Llama-3.2-3B-Instruct"

# LoRA 설정으로 메모리 절약 (70B 이상에서는 필수)
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
    beta=0.1,                 # KL 페널티 계수 — 핵심 하이퍼파라미터
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
# 결과: ./llama3-dpo/checkpoint-*에 LoRA 어댑터와 훈련 상태 저장
```

`beta` 값이 가장 중요한 하이퍼파라미터입니다. `learning_rate`는 SFT 때보다 훨씬 낮게 잡습니다. DPO는 이미 쓸 만한 SFT 모델을 조금만 움직이는 단계이므로, 높으면 참조 모델에서 크게 벗어나 일반 언어 생성 품질이 저하됩니다.

### 학습 지표 해석과 수렴 판단

DPO 학습에서 추적해야 할 지표는 손실(loss) 외에 세 가지가 더 있습니다. `rewards/chosen`은 선호 응답의 암묵적 보상 평균, `rewards/rejected`는 비선호 응답의 평균, `rewards/accuracies`는 선호 응답의 보상이 비선호 응답보다 높은 비율입니다.

| 지표 | 초기값 | 수렴 목표 | 이상 신호 |
|---|---|---|---|
| rewards/chosen | ~0 | 지속 증가 | 감소 또는 NaN |
| rewards/rejected | ~0 | 지속 감소 | 증가 또는 chosen과 동반 증가 |
| rewards/accuracies | ~0.50 | 0.50보다 꾸준히 높아짐 | 0.50 이하로 하락 |
| train/loss | 초기 큰 값 | 점진 감소 | 급등 후 NaN |

`rewards/accuracies`가 0.5 이하로 떨어지면 모델이 거꾸로 학습되고 있다는 신호입니다. 즉시 학습률과 beta를 재점검해야 합니다. 0.5는 무작위로 고른 것과 같은 수준이기 때문입니다. 반대로 학습 초반에 1 가까이 치솟으면 모델이 데이터를 외우고 있을 수 있으므로, 학습에 쓰지 않은 평가 세트에서도 같은 지표를 계산해 차이를 봅니다.

---

## 성능 특성과 기술 비교

### RLHF, DPO, IPO, KTO 비교

DPO 이후 다양한 선호도 최적화 알고리즘이 제안되었으며, 각 방법은 서로 다른 전제와 트레이드오프를 가집니다. RLHF는 현재까지도 상용 대형 모델이 채택하는 가장 강력한 방법이지만, 구현 복잡성과 컴퓨팅 요구사항이 높습니다. DPO는 구현이 단순하고 학습이 안정적이지만, 데이터에 노이즈가 많으면 오버피팅 경향이 있습니다.

| 방법 | 보상 모델 | 학습 데이터 | 안정성 | 컴퓨팅 비용 | 권장 시나리오 |
|---|---|---|---|---|---|
| RLHF+PPO | 필요 | 쌍(pair) | 낮음 | 매우 높음 | 최고 수준 정렬, 충분한 인프라 |
| DPO | 불필요 | 쌍(pair) | 높음 | 낮음 | 명확한 선호도 데이터, 빠른 반복 |
| IPO | 불필요 | 쌍(pair) | 높음 | 낮음 | 노이즈 많은 데이터, 오버피팅 방지 |
| KTO | 불필요 | 단일 응답 | 높음 | 낮음 | 쌍 데이터 구성이 어려울 때 |
| ORPO | 불필요 | 쌍(pair) | 높음 | 낮음 | SFT와 정렬을 단일 단계로 결합 |

IPO는 DPO 손실 함수에 정규화 항을 추가하여 `rewards/accuracies`가 너무 빠르게 1에 수렴하는 문제를 완화합니다. KTO는 Bradley-Terry 가정을 버리고 각 응답에 독립적으로 "좋음/나쁨" 신호를 줄 수 있어, 쌍을 이루지 않은 응답 데이터도 활용할 수 있습니다. ORPO(Odds Ratio Preference Optimization)는 SFT 손실과 선호도 손실을 단일 목적함수에 결합하여 별도의 SFT 단계 없이 정렬이 가능합니다.

```diagram
2026-10-20-c7b9f4df-05
```

데이터 상황과 기존 파이프라인 구성에 따라 알고리즘 선택이 달라집니다.

### 데이터 규모보다 품질이 중요한 이유

DPO는 손실 함수가 chosen과 rejected의 차이만 보므로, 쌍 하나하나가 주는 신호가 분명한지가 데이터 양보다 먼저입니다. 여기서 "품질"은 두 가지를 의미합니다. 첫째, chosen과 rejected 응답의 **품질 격차**입니다. 두 응답이 비슷한 품질이면 모델에게 혼란스러운 신호만 줄 뿐입니다. 둘째, **프롬프트의 도메인 분포**입니다. 챗봇 정렬이 목적이라면 실제 사용자 질문 분포를 최대한 반영한 프롬프트가 필요합니다.

데이터 필터링 전략으로는 보상 마진 기반 방법이 가장 효과적입니다. 심판 모델에게 각 응답에 점수를 매기게 한 뒤, 점수 차이가 임계값 이하인 쌍을 제거합니다. 데이터가 꽤 줄어들더라도 남은 쌍의 신호가 분명해지므로, 필터링 전후를 같은 평가 세트로 비교해 효과를 직접 확인합니다.

### 기술 선택 기준

DPO를 선택할 시나리오: 선호도 데이터가 확보되어 있고 학습 인프라가 제한적이며, 빠른 반복 실험이 필요한 경우입니다. LoRA와 함께 쓰면 학습 모델 한 벌만 올리면 되므로, RLHF로는 엄두가 안 나던 규모의 모델도 단일 GPU에서 시도해 볼 수 있습니다.

RLHF를 선택할 시나리오: 보상 함수를 명확하게 정의할 수 있고, 지속적으로 업데이트되는 보상 신호가 있으며, 최고 수준의 정렬 품질이 요구될 때입니다. 충분한 GPU 클러스터와 엔지니어링 리소스가 있을 때 적합합니다.

KTO를 선택할 시나리오: 기존 로그에서 좋은 응답과 나쁜 응답을 분류할 수 있지만, 동일 프롬프트에 대한 쌍을 구성하기 어려울 때 유리합니다. 고객 서비스 대화 로그에서 만족/불만족 레이블이 있는 경우가 대표적입니다.

---

## DPO 적용 시 흔한 오류와 메모리 최적화

### 흔한 실수와 함정

DPO를 처음 적용할 때 가장 자주 발생하는 문제는 **언어 능력 저하(language degradation)**입니다. DPO 이후 정렬은 잘 되었지만 일반 텍스트 생성 품질이 낮아지는 현상입니다. 원인은 주로 두 가지입니다. 학습률이 너무 높거나, 선호도 데이터가 특정 도메인에 치우쳐 있을 때 발생합니다. 학습률이 높으면 참조 모델에서 크게 이탈하므로, 낮은 값에서 시작해 `rewards/accuracies`가 오르지 않을 때만 조금씩 올립니다. 데이터 편중 문제는 정렬 이후 모델을 MMLU나 HellaSwag 같은 일반 벤치마크로 평가하면 조기에 발견할 수 있습니다.

두 번째 함정은 **참조 모델 선택 오류**입니다. DPO의 참조 모델은 반드시 SFT 이후 체크포인트여야 합니다. 사전 학습 기본 모델(base model)을 참조 모델로 사용하면 KL 발산 항이 의도한 역할을 하지 못하고 학습이 불안정해집니다. `ref_model=None`일 때 TRL은 PEFT 모델이면 어댑터를 끈 상태를, 아니면 학습 시작 시점의 복사본을 참조 모델로 씁니다. 어느 쪽이든 참조 정책은 학습 내내 고정되며, 그래서 시작 모델이 SFT 체크포인트여야 합니다.

```diagram
2026-10-20-c7b9f4df-06
```

DPO 문제 증상별 원인과 조치가 명확하게 분기됩니다.

세 번째는 **길이 편향(length bias)**입니다. 선호도 데이터에서 더 긴 응답이 일관되게 선호 응답으로 선택되면, DPO 이후 모델이 더 길고 장황한 응답을 생성하는 방향으로 편향됩니다. 이는 사람이 레이블할 때 "더 자세한 응답 = 더 좋은 응답"이라는 암묵적 편향 때문에 발생합니다. 데이터 수집 단계에서 레이블러에게 길이가 아닌 정확성과 관련성 기준으로 평가하도록 명시적으로 지침을 제공해야 합니다.

### 암묵적 보상으로 학습 방향 검증하기

배포된 DPO 모델의 품질을 지속적으로 추적하려면 **암묵적 보상(implicit reward)** 모니터링이 효과적입니다. DPO가 보상 모델을 내재화했기 때문에, 언어 모델 자체로 응답의 품질 점수를 계산할 수 있습니다. 다음은 두 응답 중 어떤 것을 모델이 더 선호하는지 수치로 검증하는 코드입니다.

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

def compute_implicit_reward(model, ref_model, tokenizer, prompt, response, beta=0.1):
    """암묵적 보상 r(x,y) = β · log(π_θ / π_ref) 계산"""
    prompt_len = len(tokenizer(prompt)["input_ids"])
    inputs = tokenizer(prompt + response, return_tensors="pt")

    with torch.no_grad():
        logits = model(**inputs).logits
        ref_logits = ref_model(**inputs).logits

    log_p = torch.nn.functional.log_softmax(logits, dim=-1)
    ref_log_p = torch.nn.functional.log_softmax(ref_logits, dim=-1)

    # 위치 i의 로짓이 토큰 i+1을 예측한다. 응답 토큰만 더한다.
    token_ids = inputs["input_ids"][0, 1:]
    log_ratio = (log_p[0, :-1] - ref_log_p[0, :-1])
    per_token = log_ratio.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    reward = beta * per_token[prompt_len - 1:].sum()
    return reward.item()

prompt = "파이썬에서 리스트 중복을 제거하는 방법은?"
chosen  = "set()으로 변환하거나 dict.fromkeys()를 사용합니다. 순서 유지가 필요하면 후자를 추천합니다."
rejected = "그냥 for문으로 반복하면 됩니다."

r_chosen   = compute_implicit_reward(model, ref_model, tokenizer, prompt, chosen)
r_rejected = compute_implicit_reward(model, ref_model, tokenizer, prompt, rejected)
# 결과: r_chosen > r_rejected 이면 이 쌍에 대해 선호 방향을 제대로 학습한 것
```

`r_chosen > r_rejected`가 성립하면 모델이 해당 응답 쌍에 대해 올바른 선호도를 학습했음을 의미합니다. 학습에 쓰지 않은 쌍 여러 개로 이 값을 계산해 역전된 쌍의 비율을 기록해 두고, 새로 학습한 모델에서 그 비율이 이전보다 높아지면 데이터나 beta를 다시 봅니다.

### 확장과 마이그레이션 전략

대규모 모델(30B 이상)에 DPO를 적용할 때는 메모리 전략이 필수입니다. 학습 모델과 참조 모델을 각각 전체 로드하면 GPU 메모리가 두 배 필요합니다. LoRA(Low-Rank Adaptation)와 결합하면 작은 어댑터 행렬만 학습하므로 옵티마이저 상태가 크게 줄고, 참조 확률은 어댑터를 끈 같은 모델로 계산하므로 모델을 한 벌만 올립니다. gradient checkpointing은 중간 활성값을 저장하지 않고 역전파 때 다시 계산해 메모리를 시간과 바꾸고, Flash Attention 2는 어텐션 행렬 전체를 메모리에 만들지 않아 시퀀스가 길수록 효과가 커집니다. 실제로 얼마나 줄어드는지는 모델·배치·시퀀스 길이에 따라 다르므로, 같은 설정에서 `torch.cuda.max_memory_allocated()`로 켜기 전후를 비교합니다([Hugging Face 학습 메모리 최적화 문서](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

기존 RLHF 파이프라인에서 DPO로 마이그레이션할 때는 SFT 체크포인트를 그대로 재사용할 수 있습니다. 보상 모델 학습에 사용했던 선호도 쌍 데이터도 DPO에 직접 적용 가능합니다. 보상 모델 학습 단계와 PPO 강화학습 단계를 제거하는 것만으로 파이프라인이 단순화됩니다.

| 구분 | RLHF+PPO | DPO (LoRA) |
|---|---|---|
| GPU 메모리를 차지하는 것 | 모델 4개와 생성용 버퍼 | 모델 1벌과 LoRA 어댑터 |
| 학습 루프 | 응답 생성 → 채점 → PPO 업데이트 | 정해진 데이터로 지도 학습처럼 반복 |
| 동시에 필요한 모델 | SFT·보상·정책·가치 함수 | 학습·참조 2개 |
| 하이퍼파라미터 민감도 | 매우 높음 | 중간 |
| 디버깅 난이도 | 높음 | 낮음 |

---

## 맺음말

### 핵심 요약

DPO는 RLHF의 수학적 목적함수를 재해석하여 보상 모델 학습과 PPO 강화학습을 제거하고, 선호도 쌍 데이터만으로 언어 모델을 직접 정렬합니다. 핵심은 보상 함수를 정책 비율의 로그로 표현하면 Bradley-Terry 모델에서 정규화 상수 Z(x)가 상쇄된다는 수학적 관찰입니다. 이를 통해 RLHF와 동치인 목적함수를 단순한 분류 손실로 구현할 수 있습니다. TRL 라이브러리의 `DPOTrainer`로 수십 줄 안에 구현할 수 있고, LoRA와 결합하면 참조 모델을 따로 올리지 않아 단일 GPU에서도 시도할 수 있습니다. 학습 품질을 결정하는 가장 큰 변수는 beta 값과 데이터 마진이며, 노이즈가 많은 선호도 쌍은 제거하는 것이 유리합니다.

### 적용 판단 기준

DPO 도입을 결정하기 전 세 가지를 확인합니다. 첫째, **고품질 SFT 체크포인트가 준비되어 있는가**입니다. DPO는 SFT 이후에 적용되며, 기본 지시 이해 능력이 없는 모델은 정렬 효과가 미미합니다. 둘째, **선호도 데이터의 마진이 충분한가**입니다. AI 심판으로 자동 레이블링했다면 마진 필터링을 반드시 적용해야 합니다. 셋째, **정렬 목표가 명확한가**입니다. 안전성(safety)이 최우선이거나 특정 형식을 정확히 지켜야 한다면 DPO를 여러 라운드 반복 적용하거나 RLHF 도입을 검토해야 합니다. 일반 어시스턴트 품질 향상이 목적이라면 공개 선호도 데이터셋과 단일 DPO 라운드로 충분한 경우가 많습니다. DPO는 "빠르게 시작하고 결과를 보면서 반복한다"는 실험 주도적 접근에 가장 잘 맞는 정렬 기법입니다.
