---
title: "Fine-Tuning LLM Alignment with DPO — Preference Learning Without RLHF"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM alignment", "TRL", "LoRA"]
excerpt: "A practical guide to DPO: how the loss is derived, implementing it with TRL DPOTrainer, tuning beta, filtering by margin, and reading training metrics."
koSlug: "2026-10-20-DPO로-LLM-정렬-파인튜닝하기-—-RLHF-없이-선호도-학습-구현"
---

## Table of Contents

1. Overview
2. Where Does the DPO Loss Come From
3. Implementing with TRL DPOTrainer and Reading Training Metrics
4. Choosing Between RLHF, IPO, KTO, and ORPO
5. Diagnosing DPO Training Failures and Optimizing Memory
6. Closing Thoughts

---

## Overview

After reading this post you will understand where the DPO loss comes from, be able to run training with TRL `DPOTrainer`, and judge from training metrics alone whether alignment is working. DPO (Direct Preference Optimization) aligns an LLM using only preference pairs of the form "A is better than B," with no reward model and no reinforcement learning. At the end, I cover how to decide between RLHF, IPO, KTO, and ORPO.

### What Makes RLHF Heavy

A model that has only gone through pre-training and SFT (supervised fine-tuning) has never learned what "a better response" means. The standard way to close that gap — alignment — has long been RLHF. RLHF runs **reward model training** followed by **PPO reinforcement learning** on top of the SFT model. During the PPO phase you keep four models on GPU simultaneously — policy, reference, reward, and value — and loop through generating responses, scoring them, and updating. Get the clipping or KL coefficient wrong and you get reward hacking: the reward goes up while the responses fall apart, which multiplies the number of experiments you need to run.

```diagram
en/2026-10-20-c7b9f4df-01
```

==DPO collapses the two RLHF stages — reward model training and PPO — into a single step that trains directly on preference data.== The idea comes from Rafailov et al.'s 2023 paper ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290).

---

## Where Does the DPO Loss Come From

The short answer: DPO solves the same objective as RLHF but rewrites the reward as a log probability ratio between the model being trained and the reference model, which eliminates the need for a separate reward model. Three lines of math make this clear.

### From the RLHF Objective to the DPO Loss

RLHF maximizes expected reward while staying close to the reference policy π_ref (the SFT model) via a KL penalty.

```
max_π  E[r(x, y)]  −  β · KL[π(·|x) ∥ π_ref(·|x)]
```

This problem has a closed-form optimal policy, and solving that expression backwards for the reward r lets you write the reward as a log ratio of the two policies.

```
r(x, y)  =  β · log(π*(y|x) / π_ref(y|x))  +  β · log Z(x)
```

Plug this into the **Bradley-Terry model** P(y_w ≻ y_l) = σ(r(x, y_w) − r(x, y_l)), which treats preference probability as the sigmoid of the reward gap, and the Z(x) terms — which depend only on prompt x — cancel in the subtraction. What remains is the DPO loss. y_w is the preferred response (chosen) and y_l is the dispreferred response (rejected).

```
L_DPO  =  −E[ log σ( β log(π_θ(y_w|x)/π_ref(y_w|x))  −  β log(π_θ(y_l|x)/π_ref(y_l|x)) ) ]
```

### What the Loss Actually Does

==DPO does not simply push the probability of the preferred response up; it trains the model so that the probability increase relative to the reference model is larger for the preferred response than for the dispreferred one.== Responses the reference model already handles well see little change in their ratio, so they move less. The signal is strongest where the reference model was wrong.

β is the KL coefficient multiplied into that ratio. Higher β keeps the model closer to the reference; lower β lets it move further toward the preference signal.

> Start with the default β=0.1 in TRL `DPOConfig`. If language quality degrades, raise it. If alignment is too weak, lower it.

The Bradley-Terry model handles poorly cases where responses trade off on multiple dimensions (accurate but verbose vs. concise but inaccurate). IPO and KTO address this limitation; I compare them in section 4.

---

## Implementing with TRL DPOTrainer and Reading Training Metrics

The implementation itself is short. What separates good results from bad is **data margin** and **knowing how to read training metrics**, not the code.

### Data: Drop Pairs With Small Quality Gaps

DPO data has three columns: `prompt`, `chosen`, `rejected`. Pairs are produced either by human comparison ([HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf)) or by scoring with a strong model such as GPT-4 ([UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback)). AI judges are cheap but transfer the judge model's biases directly.

==Filter out pairs where the score gap is small before training.== When two responses are nearly equal in quality, the preference probability in the Bradley-Terry formulation stays near 0.5, giving the model almost no directional signal. There is no fixed threshold; try a few values, train separate runs, and compare on the same held-out eval set. Also check that prompt types are not skewed toward one category.

### Core Implementation

This assumes you have an SFT checkpoint. `trl-lib/ultrafeedback_binarized` is a public dataset that converts UltraFeedback into the paired format.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from datasets import load_dataset
from peft import LoraConfig, get_peft_model

model_name = "meta-llama/Llama-3.2-3B-Instruct"

# Train only a small LoRA adapter. Practically required for large models.
lora_cfg = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "v_proj"])
model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype="auto")
model = get_peft_model(model, lora_cfg)

# When passing a PEFT model, ref_model=None is fine.
# TRL computes reference probabilities with the adapter disabled, so no second copy of the model is loaded.
ref_model = None
tokenizer = AutoTokenizer.from_pretrained(model_name)
tokenizer.pad_token = tokenizer.eos_token

dataset = load_dataset("trl-lib/ultrafeedback_binarized", split="train")

training_args = DPOConfig(
    output_dir="./llama3-dpo",
    num_train_epochs=1,
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    learning_rate=5e-7,       # Start much lower than SFT
    beta=0.1,                 # KL coefficient — the first thing to tune
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
    processing_class=tokenizer,  # Older TRL versions use tokenizer=
)
trainer.train()
# Output: LoRA adapter and training state saved to ./llama3-dpo/checkpoint-*
```

The learning rate is much lower than SFT because DPO is a stage that nudges an already-capable model by a small amount.

### Judging Alignment From Training Metrics

==The first metric to check is `rewards/accuracies`. If it stays below 0.5 consistently, the model is learning in the wrong direction.== 0.5 is the same as random selection. Look at the trend, not the noise in the first few steps.

| Metric | Meaning | Healthy | Warning sign |
|---|---|---|---|
| `rewards/accuracies` | Fraction of pairs where chosen reward > rejected reward | Steady climb from 0.5 | Drops below 0.5 |
| `rewards/margins` | Mean difference between chosen and rejected rewards | Widens steadily | Shrinks or goes negative |
| `rewards/chosen` | Implicit reward of chosen responses | Rises, or falls less than rejected | Drops sharply alongside rejected |
| `train/loss` | DPO loss | Decreases from starting value of log 2 | Spikes or NaN |

The loss starts at log 2 because the trained model begins identical to the reference model, making the loss −log σ(0). Conversely, if `rewards/accuracies` jumps close to 1 early in training, the model may be memorizing; check the same metrics on a held-out eval set.

---

## Choosing Between RLHF, IPO, KTO, and ORPO

==If you have paired data, an SFT checkpoint, and reasonably clean labels, DPO is the default choice.== The other methods are for when one of those conditions breaks down.

```diagram
en/2026-10-20-c7b9f4df-05
```

| Method | Reward model | Training data | When to use it | Caveats |
|---|---|---|---|---|
| RLHF + PPO | Required | Pairs | Reward signal needs continuous updates and infrastructure is available | Four models on GPU simultaneously; heavy to tune |
| DPO | Not required | Pairs | Paired data exists and you want fast iteration | Prone to overfitting with noisy data |
| IPO | Not required | Pairs | Label noise is high | Adds a regularization term to the loss |
| KTO | Not required | Single responses + good/bad labels | Hard to form pairs from the same prompt | Based on prospect theory instead of Bradley-Terry |
| ORPO | Not required | Pairs | No SFT stage available | Combines SFT and alignment into one objective |

KTO's biggest advantage is that it works directly with data where each response has only a good/bad label — like satisfaction flags on customer service logs — without needing matched pairs. On the other hand, if you can define a reward function precisely and need to keep reflecting a changing reward signal, the overhead of RLHF becomes worth it.

---

## Diagnosing DPO Training Failures and Optimizing Memory

DPO failures fall into three categories most of the time. Checking them in the order below narrows down the cause quickly.

```diagram
en/2026-10-20-c7b9f4df-06
```

### Three Failure Modes and How to Handle Them

1. **Language quality degradation.** Alignment improves but general text quality drops. Caused by a high learning rate or preference data concentrated in a narrow domain. Lower the learning rate; if the problem persists, compare responses before and after alignment on a general-purpose question set unrelated to the preference data to check for domain skew.
2. **Learning in reverse.** `rewards/accuracies` stays below 0.5. Re-examine learning rate and beta, and verify that chosen and rejected are not swapped in the data. ==The reference model must be an SFT checkpoint; using a base model that has only been pre-trained makes the KL term ineffective.==
3. **Length bias.** Responses grow longer over training. This is the result of annotators tending to pick "more detailed" as "better," leaving that bias in the data. Add explicit guidance to your labeling instructions to judge on accuracy and relevance, not length.

### Verifying Training Direction With Implicit Rewards

Because a DPO model implicitly contains a reward model, you can score any response by computing the log probability ratio between the trained model and the reference model. If you trained with `ref_model=None` as in the code above, reference probabilities come from the same model with the adapter disabled.

```python
import torch

def compute_implicit_reward(model, tokenizer, prompt, response, beta=0.1):
    """Implicit reward r(x,y) = β · log(π_θ / π_ref) — summed over response tokens only.
    model is the PEFT model trained above. The same model with the adapter disabled is the reference."""
    prompt_len = len(tokenizer(prompt)["input_ids"])
    inputs = tokenizer(prompt + response, return_tensors="pt").to(model.device)

    with torch.no_grad():
        logits = model(**inputs).logits
        with model.disable_adapter():
            ref_logits = model(**inputs).logits

    log_p = torch.nn.functional.log_softmax(logits, dim=-1)
    ref_log_p = torch.nn.functional.log_softmax(ref_logits, dim=-1)

    # Logits at position i predict token i+1. Sum over response tokens only.
    token_ids = inputs["input_ids"][0, 1:]
    log_ratio = (log_p[0, :-1] - ref_log_p[0, :-1])
    per_token = log_ratio.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    reward = beta * per_token[prompt_len - 1:].sum()
    return reward.item()

prompt = "How do you remove duplicates from a list in Python?"
chosen = "Convert to set(), or use dict.fromkeys(). The latter is recommended if you need to preserve order."
rejected = "Just loop through it with a for loop."

r_chosen = compute_implicit_reward(model, tokenizer, prompt, chosen)
r_rejected = compute_implicit_reward(model, tokenizer, prompt, rejected)
# Result: r_chosen > r_rejected means the model learned the preference direction correctly for this pair
```

Track the reversal rate on pairs not used in training. If it rises in the next training run, revisit the data or beta.

### Reducing Memory Usage

| Technique | What it reduces | Cost |
|---|---|---|
| LoRA + `ref_model=None` | Optimizer state, one full copy of the reference model | Trainable parameters are limited to the adapter |
| Gradient checkpointing | Storing intermediate activations | Recomputes on the backward pass, slowing training |
| Flash Attention 2 | Storing the full attention matrix | Requires specific GPU and dtype; benefit grows with sequence length |

How much each technique saves depends on model size, batch size, and sequence length, so compare `torch.cuda.max_memory_allocated()` with and without each one under the same settings ([Hugging Face single-GPU training memory optimization docs](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

---

## Closing Thoughts

### Key Takeaways

- DPO rewrites the reward as a probability ratio between the trained model and the reference model, reducing RLHF's reward model training and PPO into a single supervised-learning-like step.
- Data margin matters more than code. Filter out pairs with small quality gaps and check the prompt distribution.
- During training, watch `rewards/accuracies` and `rewards/margins` first. If accuracies drop below 0.5, inspect learning rate, beta, and data label direction.

### Decision Criteria

==Before starting DPO, confirm you have three things: an SFT checkpoint, preference pairs with sufficient margin, and a clear alignment goal.== If you are missing the SFT checkpoint, consider ORPO first. If you cannot construct pairs, consider KTO first. If safety is the top priority or strict output formatting is required, run multiple rounds of DPO or consider RLHF. If the goal is improving general assistant quality, starting with a public preference dataset and one round of DPO, then iterating on results, is the fastest path forward.
