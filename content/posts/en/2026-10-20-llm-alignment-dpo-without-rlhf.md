---
title: "Fine-Tuning LLM Alignment with DPO — Preference Learning Without RLHF"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM alignment", "TRL", "LoRA"]
excerpt: "A practical guide to DPO for developers new to LLM training: how it works, how to run it with TRL DPOTrainer, and how to read the training metrics."
koSlug: "2026-10-20-DPO로-LLM-정렬-파인튜닝하기-—-RLHF-없이-선호도-학습-구현"
---

## Table of Contents

1. Overview
2. What DPO Actually Learns
3. Implementing with TRL DPOTrainer and Reading the Metrics
4. Choosing Between RLHF, IPO, KTO, and ORPO
5. What to Check When DPO Training Fails
6. Closing Thoughts

---

## Overview

After reading this post you'll understand what DPO does, be able to run training yourself with the TRL library, and know how to judge the results from the training metrics. DPO (Direct Preference Optimization) is a training method that improves LLM response quality using only pairwise comparison data — "this answer is better than that one." This is written for developers who have used LLMs through an API but haven't trained one themselves.

### Why You Need to Teach "Better Answers" Separately

LLMs are built in two stages. First, the model is trained to predict the next word on internet-scale text (pre-training). Then it's trained again on question–answer pairs to learn how to respond to prompts. That second stage is called SFT (supervised fine-tuning).

A model that has been through SFT can answer questions, but it doesn't know which answer is better when multiple valid ones exist. For example, when asked "how do I remove duplicates from a Python list?", both answers below are correct, but people generally prefer A.

| | Answer | Human preference |
|---|---|---|
| A (chosen) | Using `dict.fromkeys()` removes duplicates while preserving order. | Preferred |
| B (rejected) | You can loop through with a for loop. | Not preferred |

The process of tuning a model to match human preferences like this is called **alignment**.

### Why the Existing Approach, RLHF, Is So Heavy

RLHF was the standard for alignment. It first trains a separate **reward model** that scores responses using comparison data like the above, then runs a **reinforcement learning (PPO)** loop where the model generates a response, the reward model scores it, and the model is updated to increase that score. This requires four model copies on the GPU simultaneously, and a slightly wrong configuration can cause the score to rise while the actual responses become nonsensical.

```diagram
en/2026-10-20-c7b9f4df-01
```

==DPO eliminates the reward model and reinforcement learning, reducing the whole thing to a single training step directly on the comparison data.== It comes from the 2023 paper ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290) by Rafailov et al.

---

## What DPO Actually Learns

In one sentence, ==DPO increases the probability of the preferred answer and decreases the probability of the rejected answer, while keeping the model from drifting too far from what it was before training.==

### Intuition: Movement Is Measured Relative to the Original Model

When a language model generates a response, it computes the probability of each token. For every comparison pair, DPO looks at "the probability of A" and "the probability of B" and nudges the model so A's probability grows.

The anchor for this is the **reference model** — a frozen copy of the SFT model taken before training starts. DPO compares not absolute probabilities, but "how much did this go up relative to the reference model?" That means it barely touches answers the model was already getting right, and makes larger updates on pairs the original model was getting wrong. Having a reference point also reduces the risk of losing pre-existing language ability while fitting the preference data.

| Term | Meaning |
|---|---|
| Policy model (π_θ) | The model currently being trained |
| Reference model (π_ref) | A frozen copy of the SFT model before training. The comparison baseline. |
| β (beta) | Controls how tightly the model is held to the reference. Higher = smaller moves, lower = larger moves. |
| chosen / rejected | The preferred / rejected response in a comparison pair |

> Start with TRL's default β=0.1. Increase it if responses start sounding unnatural; decrease it if alignment effects are too weak.

### The Math (You Can Skip This)

The DPO loss is a direct translation of that intuition into a formula. x is the prompt, y_w is chosen, y_l is rejected.

```
L_DPO  =  −log σ( β·log(π_θ(y_w|x) / π_ref(y_w|x))  −  β·log(π_θ(y_l|x) / π_ref(y_l|x)) )
```

The first term inside the parentheses is "how much better does the chosen response come out compared to the reference model?", and the second is "how much better does the rejected response come out?" The loss decreases when the first term is larger than the second. The key insight of the paper is showing that RLHF's reward scores can be replaced with these probability ratios — which is why you don't need a separate reward model. Here σ (sigmoid) converts the score difference into a probability between 0 and 1 of "choosing A", a formulation known as the Bradley-Terry model.

---

## Implementing with TRL DPOTrainer and Reading the Metrics

The code is short. What determines outcomes is **what comparison pairs you feed in** and **how you read the training metrics**.

### Data: Keep Only Pairs with a Clear Difference

DPO data is a table with three columns: `prompt`, `chosen`, and `rejected`. Pairs are either labeled by humans ([HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf)) or generated by having a stronger model score outputs ([UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback)). Model-scored labels are cheap but inherit the scoring model's preferences.

==Remove pairs where the quality difference between the two responses is small before training.== If the two responses are nearly the same, the model can't learn a direction — it becomes noise rather than signal. There's no universal threshold for score difference; try a few values, train on each, and compare on the same evaluation question set.

### Core Implementation

Start from a model that has already been through SFT. The code below trains only **LoRA** — small additional weights, not the full model. It attaches thin correction layers to certain layers and trains only those, leaving the original weights untouched, which makes it feasible to run on consumer GPUs.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from datasets import load_dataset
from peft import LoraConfig, get_peft_model

model_name = "meta-llama/Llama-3.2-3B-Instruct"

# Train only a small adapter with LoRA. Practically required for larger models.
lora_cfg = LoraConfig(r=16, lora_alpha=32, target_modules=["q_proj", "v_proj"])
model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype="auto")
model = get_peft_model(model, lora_cfg)

# When passing a PEFT model, ref_model=None is fine.
# TRL computes reference probabilities with the adapter disabled, so no second model copy is loaded.
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
# Output: LoRA adapter and training state are saved to ./llama3-dpo/checkpoint-*
```

The reason `learning_rate` is set much lower than in SFT is that DPO is a fine adjustment on an already functional model.

### Using Training Metrics to Judge Alignment

During training, DPO logs scores that represent "how much did the probability go up relative to the reference model?" These are called **implicit rewards** because they're obtained without a separate reward model.

==The first metric to watch is `rewards/accuracies`. If it stays below 0.5, the model is learning in the wrong direction.== 0.5 is the same as a coin flip.

| Metric | Meaning | Normal | Warning sign |
|---|---|---|---|
| `rewards/accuracies` | Fraction of pairs where chosen score > rejected score | Steadily rises from 0.5 | Drops below 0.5 |
| `rewards/margins` | Average difference between chosen and rejected scores | Keeps growing | Shrinks or goes negative |
| `rewards/chosen` | Score for chosen responses | Rises, or drops less than rejected | Drops sharply along with rejected |
| `train/loss` | DPO loss | Starts near log 2 (~0.69) and decreases | Spikes or NaN |

The loss starting near log 2 happens because at the beginning the training model and reference model are identical, so the model can't yet distinguish chosen from rejected. Conversely, if `rewards/accuracies` spikes close to 1 early in training, the model may be memorizing — check the same metric on pairs not used in training.

---

## Choosing Between RLHF, IPO, KTO, and ORPO

==If you have pairwise comparison data, an SFT model, and reasonably clean data, DPO is the default choice.== Pick a different method when one of those conditions breaks down.

```diagram
en/2026-10-20-c7b9f4df-05
```

| Method | One-line description | Required data | When to use it |
|---|---|---|---|
| RLHF + PPO | Train a reward model, then use RL to maximize its score | Comparison pairs | When scoring criteria change frequently and you have plenty of GPU headroom |
| DPO | Train directly on comparison pairs | Comparison pairs | When you want to iterate quickly |
| IPO | Adds a constraint on top of DPO to prevent over-fitting | Comparison pairs | When a significant fraction of pairs have noisy labels |
| KTO | Trains on individual responses labeled good/bad, no pairing needed | Response + good/bad label | When collecting two responses to the same prompt is difficult |
| ORPO | Combines SFT and alignment into a single training pass | Comparison pairs | When you don't have an SFT model yet |

KTO's biggest advantage is that you can use feedback that's already accumulated — like satisfaction/dissatisfaction buttons in a support chat log. On the other hand, if your scoring criteria can be defined precisely in code and change often, the overhead of RLHF may be worth it.

---

## What to Check When DPO Training Fails

DPO failures usually look like one of three things. Working through them in the order below narrows down the cause quickly.

```diagram
en/2026-10-20-c7b9f4df-06
```

### Three Failure Modes and Fixes

1. **Responses become unnatural.** The preference direction is right but general response quality degrades. Caused by a learning rate that's too high or comparison data concentrated in one domain. Lower the learning rate and compare responses to general questions (unrelated to the alignment task) before and after training.
2. **Learning in reverse.** `rewards/accuracies` stays below 0.5. First check whether the chosen and rejected columns are swapped, then revisit the learning rate and β. ==The reference model must be an SFT-trained model. Using a pre-training-only model breaks the comparison baseline entirely.==
3. **Responses keep getting longer.** This is a leftover bias from humans tending to prefer the more detailed answer. Add explicit guidance to annotators to select based on accuracy rather than length.

### Computing Scores Per Pair Directly

Running the trained model on pairs it wasn't trained on and computing scores manually can reveal problems hidden behind metric averages. If you trained with LoRA as in the code above, the same model with the adapter disabled is the reference model.

```python
import torch

def compute_implicit_reward(model, tokenizer, prompt, response, beta=0.1):
    """Implicit reward r(x,y) = β · log(π_θ / π_ref) — summed over response tokens only.
    model is the PEFT model trained above. The same model with the adapter disabled is the reference model."""
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
chosen = "You can convert to a set() or use dict.fromkeys(). If order matters, the latter is recommended."
rejected = "Just loop through with a for loop."

r_chosen = compute_implicit_reward(model, tokenizer, prompt, chosen)
r_rejected = compute_implicit_reward(model, tokenizer, prompt, rejected)
# If r_chosen > r_rejected, the model learned the correct preference direction for this pair
```

Track the fraction of pairs where rejected scores higher than chosen, and if that fraction rises in the next training run, revisit the data or β.

### When You're Running Low on GPU Memory

| Technique | What it does | Trade-off |
|---|---|---|
| LoRA + `ref_model=None` | Trains only small correction layers; no separate reference model copy loaded | Less headroom for change than full-model training |
| Gradient checkpointing | Discards intermediate activations during training and recomputes them when needed | Slower training |
| Flash Attention 2 | Replaces the attention computation with a memory-efficient implementation | Only supported on certain GPUs |

How much memory each saves depends on model size and sequence length, so measure `torch.cuda.max_memory_allocated()` before and after enabling each one under the same settings ([Hugging Face training memory optimization docs](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

---

## Closing Thoughts

### Key Takeaways

- DPO uses comparison pairs ("A is better than B") to raise the probability of A relative to what the model would have produced before training. No reward model, no reinforcement learning.
- Data matters more than code. Keep only pairs with a clear quality difference.
- During training, watch `rewards/accuracies` and `rewards/margins` first. If accuracies drop below 0.5, inspect data direction, learning rate, and β.

### Deciding Whether to Use DPO

==Before starting DPO, confirm you have three things: an SFT-trained model, comparison pairs with clear differences, and a specific behavior you want to fix.== If you don't have an SFT model, look at ORPO first. If you can't create comparison pairs and only have good/bad feedback, look at KTO first. If your goal is improving a general-purpose assistant, starting with a public comparison dataset and one round of DPO, then iterating based on results, is usually the fastest path forward.
