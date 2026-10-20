---
title: "Fine-Tuning LLM Alignment with DPO — Preference Learning Without RLHF"
date: "2026-10-20 11:17"
category: "AI"
tags: ["DPO", "RLHF", "LLM alignment", "TRL", "LoRA"]
excerpt: "How DPO aligns language models from preference pairs alone, without a reward model or PPO — covering the math, TRL DPOTrainer, beta tuning, margin filtering, and reading training metrics."
koSlug: "2026-10-20-DPO로-LLM-정렬-파인튜닝하기-—-RLHF-없이-선호도-학습-구현"
---

## Table of Contents

1. Overview
2. The Math Behind DPO
3. Preparing Preference Data and Implementing DPO
4. Performance Characteristics and Algorithm Comparison
5. Common Mistakes and Memory Optimization
6. Closing Thoughts

---

## Overview

### Why Preference Learning Matters

DPO (Direct Preference Optimization) aligns an LLM using only "A is better than B" preference pairs, with no reward model and no reinforcement learning. This post covers where the DPO loss function comes from, how to implement it with TRL's `DPOTrainer`, how to judge from training metrics whether alignment is working, and how to choose among RLHF, IPO, and KTO.

A model that has only been pretrained cannot infer on its own how to follow human instructions or avoid harmful content. It was trained purely to maximize the probability of the next token. Closing that gap is **alignment**. Alignment is not just about making a model "tame." It adjusts the model's output distribution so that, for the same question, it produces responses that are more accurate, more concise, and consistent with specific formatting requirements. In enterprise settings, it is the mechanism for embedding brand tone, security policies, and format conventions into a language model.

Before alignment techniques existed, the only approach was to collect large amounts of instruction data and rely entirely on supervised fine-tuning (SFT). But SFT cannot use comparative information — the signal "this response is better than that one." That kind of signal is far more natural to collect than "this is a good response." Human annotators work faster and more consistently when they compare two responses side by side and pick the better one than when they write a good response from scratch. Making effective use of these comparison-based preference signals is the core of modern alignment.

### The Structural Complexity of RLHF

RLHF consists of three stages. First, SFT via supervised learning. Second, training a reward model on human labels. Third, fine-tuning the language model with PPO (Proximal Policy Optimization). Each stage depends on the quality of the previous one, so errors accumulate easily. The PPO stage in particular requires four models in memory at once: the SFT model, the reward model, the current policy, and the value function. Four models of the same size sharing GPU memory means that as models grow larger, a single GPU cannot handle it.

```diagram
en/2026-10-20-c7b9f4df-01
```

RLHF requires a reward model and PPO is unstable. DPO compresses both stages into one.

PPO instability is a frequently reported problem in practice. Preventing reward hacking and KL penalty suppression requires careful tuning of clipping parameters and entropy bonuses, which multiplies the number of experiments and drives up the cost of maintaining the whole pipeline. DPO was first proposed by Rafailov et al. in their 2023 paper ["Direct Preference Optimization: Your Language Model is Secretly a Reward Model"](https://arxiv.org/abs/2305.18290). They showed that DPO achieves the same optimal policy as the KL-constrained RLHF objective, internalizing the reward model into the language model itself and reducing the number of pipeline stages.

---

## The Math Behind DPO

### The RLHF Objective and the Closed-Form Optimal Policy

The core of RLHF is finding a policy π_θ that maximizes the following objective: maximize expected reward while staying close to the reference policy π_ref (the SFT model), constrained by a KL divergence term.

```
max_π  E[r(x, y)]  −  β · KL[π(·|x) ∥ π_ref(·|x)]
```

A larger β makes it harder to deviate from the reference model, so β controls the trade-off between alignment strength and preserving language ability. As β approaches zero, the model starts producing pathological text to maximize reward — "reward hacking." The KL divergence term prevents this.

Analyzing this objective reveals that the optimal policy exists in closed form.

```
π*(y|x)  ∝  π_ref(y|x) · exp(r(x, y) / β)
```

The optimal policy is a rescaling of the reference policy proportional to the reward. The key insight of DPO is to invert this expression and write the reward r as a ratio of the two policies.

```
r(x, y)  =  β · log(π*(y|x) / π_ref(y|x))  +  β · log Z(x)
```

Here Z(x) is a normalizing constant that depends only on x. Substituting this reward expression into the Bradley-Terry preference model causes the Z(x) term to cancel, making it possible to model preferences directly from the log-probability ratio of the language model, without any separate reward model.

```diagram
en/2026-10-20-c7b9f4df-02
```

The closed-form solution to the RLHF objective is the key justification for deriving the DPO loss.

### Intuition Behind the DPO Loss Function

The final DPO loss is as follows. π_θ is the policy being trained, π_ref is the reference policy, y_w is the preferred response (chosen), y_l is the dispreferred response (rejected), and σ is the sigmoid function.

```
L_DPO  =  −E[(x,y_w,y_l)] [log σ( β log(π_θ(y_w|x)/π_ref(y_w|x))  −  β log(π_θ(y_l|x)/π_ref(y_l|x)) )]
```

The intuition is clear. Training pushes the **relative log-probability increase of the preferred response over the reference model** to exceed that of the dispreferred response. The important point is that this is not simply "increase the probability of the preferred response." Because the comparison is made in terms of ratios relative to the reference model, the update is not excessive for responses the reference model already generates well. Conversely, when improving responses the reference model handles poorly, the gradient signal is stronger.

> β is both the KL penalty coefficient and a learning sensitivity dial. Start from the default of 0.1 in TRL's `DPOConfig`, raise it if language ability degrades, and lower it if the alignment effect is too weak.

### Connection to the Bradley-Terry Model

The preference model underlying DPO is the **Bradley-Terry model**. It expresses the probability that response A is preferred over B as a sigmoid of the difference in their reward scores.

```
P(y_w ≻ y_l | x)  =  σ(r(x, y_w) − r(x, y_l))
```

The Bradley-Terry model acknowledges that preferences are probabilistic. The larger the quality gap, the closer the probability gets to 1; when two responses are similar, it converges to 0.5. This matches the properties of real human label data well. It captures the reality that different annotators reach different conclusions about the same two responses, and that the same annotator is inconsistent depending on context.

```diagram
en/2026-10-20-c7b9f4df-03
```

The larger the quality gap between preference pairs, the clearer the DPO training signal. Pairs with similar quality are better filtered out.

This assumption does not always hold. When responses differ across multiple dimensions — for example, one is accurate but too long while the other is concise but inaccurate — the Bradley-Terry model shows its limits. Variants such as IPO and KTO that address this limitation are covered in the comparison section below.

---

## Preparing Preference Data and Implementing DPO

### Data Format and Collection Strategy

The data needed for DPO training has three columns: **prompt**, **chosen** (preferred response), and **rejected** (dispreferred response). Behind this simple structure are several choices that determine data quality. There are two main collection approaches.

The first is **human labeling**. People directly compare pairs of responses generated by different models and select the better one. Anthropic's [HH-RLHF](https://huggingface.co/datasets/Anthropic/hh-rlhf) dataset is a representative example. This is consistent and reliable but expensive.

The second is the **AI judge** approach. A powerful model such as GPT-4 or Claude is used as a judge to automatically generate preferences. The [UltraFeedback](https://huggingface.co/datasets/openbmb/UltraFeedback) dataset is a well-known example where GPT-4 scores responses from multiple models; `trl-lib/ultrafeedback_binarized`, used in the code below, converts these into chosen/rejected pairs. This costs less but can transfer the judge model's biases directly into the data.

```diagram
en/2026-10-20-c7b9f4df-04
```

Margin-based filtering after collecting preference data is essential to guarantee training signal quality.

The key criterion for data quality is **margin**. If a judge model has scored each response, remove pairs where the score difference between chosen and rejected is small. When two responses are nearly equal in quality, the preference probability in the Bradley-Terry formula stays near 0.5, giving the model almost no directional signal. There is no fixed threshold; split the data at several values, train on each, and compare on the same evaluation set to decide. **Prompt diversity** also matters. If similar prompt types repeat, the model over-fits to specific patterns and general capability degrades.

### Core Implementation with TRL

Hugging Face's TRL (Transformer Reinforcement Learning) library provides the `DPOTrainer` class. The following is an example applying DPO to a LLaMA-3-based model. It assumes an SFT checkpoint is already available and the training data is in Hugging Face Dataset format with `prompt`, `chosen`, and `rejected` columns.

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import DPOTrainer, DPOConfig
from datasets import load_dataset
from peft import LoraConfig, get_peft_model

model_name = "meta-llama/Llama-3.2-3B-Instruct"

# LoRA config to save memory (required for 70B+)
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
    beta=0.1,                 # KL penalty coefficient — the key hyperparameter
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
    processing_class=tokenizer,  # older TRL versions use tokenizer=
)
trainer.train()
# Output: LoRA adapter and training state saved to ./llama3-dpo/checkpoint-*
```

`beta` is the most important hyperparameter. Set `learning_rate` much lower than during SFT. DPO is a stage that nudges an already-functional SFT model only slightly; a high learning rate causes large deviations from the reference model and degrades general language generation quality.

### Interpreting Training Metrics and Judging Convergence

Beyond loss, there are three more metrics to track during DPO training. `rewards/chosen` is the mean implicit reward for preferred responses, `rewards/rejected` is the mean for dispreferred responses, and `rewards/accuracies` is the fraction of steps where the preferred response's reward exceeds the dispreferred response's.

| Metric | Initial value | Convergence target | Warning signal |
|---|---|---|---|
| rewards/chosen | ~0 | Steadily increasing | Decreasing or NaN |
| rewards/rejected | ~0 | Steadily decreasing | Increasing, or rising together with chosen |
| rewards/accuracies | ~0.50 | Consistently above 0.50 | Dropping below 0.50 |
| train/loss | Large initial value | Gradually decreasing | Sudden spike then NaN |

If `rewards/accuracies` drops below 0.5, the model is learning in reverse — revisit the learning rate and beta immediately. 0.5 is no better than random. Conversely, if it shoots near 1 early in training, the model may be memorizing the data, so compute the same metric on a held-out evaluation set and check the gap.

---

## Performance Characteristics and Algorithm Comparison

### Comparing RLHF, DPO, IPO, and KTO

Since DPO was proposed, a variety of preference optimization algorithms have emerged, each with different assumptions and trade-offs. RLHF remains the most powerful method adopted by large commercial models, but it has high implementation complexity and compute requirements. DPO is simpler to implement and trains stably, but tends to overfit when data is noisy.

| Method | Reward model | Training data | Stability | Compute cost | Recommended scenario |
|---|---|---|---|---|---|
| RLHF+PPO | Required | Pairs | Low | Very high | Top-tier alignment, sufficient infrastructure |
| DPO | Not required | Pairs | High | Low | Clear preference data, fast iteration |
| IPO | Not required | Pairs | High | Low | Noisy data, preventing overfitting |
| KTO | Not required | Individual responses | High | Low | When constructing pairs is difficult |
| ORPO | Not required | Pairs | High | Low | Combining SFT and alignment in a single stage |

IPO adds a regularization term to the DPO loss to mitigate `rewards/accuracies` converging to 1 too quickly. KTO drops the Bradley-Terry assumption and can assign independent "good/bad" signals to individual responses, so it can use unpaired response data. ORPO (Odds Ratio Preference Optimization) combines the SFT loss and the preference loss into a single objective, enabling alignment without a separate SFT stage.

```diagram
en/2026-10-20-c7b9f4df-05
```

Algorithm choice depends on the data situation and the existing pipeline structure.

### Why Quality Matters More Than Data Volume

Because the DPO loss only looks at the difference between chosen and rejected, the clarity of the signal from each pair matters more than the total number of pairs. "Quality" here means two things. First, the **quality gap** between chosen and rejected responses. When two responses are similar in quality, they only send a confusing signal to the model. Second, the **domain distribution of prompts**. If the goal is chatbot alignment, the prompts need to reflect the actual distribution of user queries as closely as possible.

Among data filtering strategies, reward margin-based filtering is the most effective. Have a judge model score each response, then remove pairs where the score difference falls below a threshold. Even if this significantly reduces the dataset, the remaining pairs have clearer signals, so compare the same evaluation set before and after filtering to verify the effect directly.

### Choosing the Right Approach

Scenarios for choosing DPO: preference data is available, training infrastructure is limited, and fast iterative experimentation is needed. Combined with LoRA, only one model copy needs to be loaded, making it possible to attempt model scales on a single GPU that would be out of reach with RLHF.

Scenarios for choosing RLHF: the reward function can be defined clearly, there is a continuously updated reward signal, and the highest level of alignment quality is required. Appropriate when sufficient GPU clusters and engineering resources are available.

Scenarios for choosing KTO: existing logs contain good and bad responses that can be classified, but it is difficult to construct pairs for the same prompt. A representative case is customer service conversation logs with satisfaction/dissatisfaction labels.

---

## Common Mistakes and Memory Optimization

### Common Pitfalls

The most frequent problem when first applying DPO is **language degradation** — alignment improves after DPO, but general text generation quality drops. There are two main causes: the learning rate is too high, or the preference data is skewed toward a specific domain. A high learning rate causes large deviations from the reference model, so start from a low value and only increase it incrementally when `rewards/accuracies` fails to rise. Data skew can be caught early by evaluating the post-alignment model on general benchmarks such as MMLU or HellaSwag.

The second pitfall is **wrong reference model**. The reference model for DPO must be the post-SFT checkpoint. Using a pretrained base model as the reference prevents the KL divergence term from playing its intended role and destabilizes training. When `ref_model=None`, TRL uses the model with the adapter disabled (for PEFT models) or a copy of the model at the start of training as the reference. Either way, the reference policy is frozen throughout training, which is why the starting model must be the SFT checkpoint.

```diagram
en/2026-10-20-c7b9f4df-06
```

DPO symptoms map cleanly to specific causes and fixes.

The third pitfall is **length bias**. If longer responses are consistently selected as preferred in the preference data, DPO will bias the model toward generating longer, more verbose responses. This happens because annotators often carry an implicit assumption that "more detailed = better." During data collection, give annotators explicit instructions to evaluate based on accuracy and relevance, not length.

### Verifying Training Direction with Implicit Rewards

For ongoing quality monitoring of a deployed DPO model, tracking **implicit rewards** is effective. Because DPO internalizes the reward model, the language model itself can compute a quality score for any response. The following code numerically verifies which of two responses the model prefers.

```python
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

def compute_implicit_reward(model, ref_model, tokenizer, prompt, response, beta=0.1):
    """Compute implicit reward r(x,y) = β · log(π_θ / π_ref)"""
    prompt_len = len(tokenizer(prompt)["input_ids"])
    inputs = tokenizer(prompt + response, return_tensors="pt")

    with torch.no_grad():
        logits = model(**inputs).logits
        ref_logits = ref_model(**inputs).logits

    log_p = torch.nn.functional.log_softmax(logits, dim=-1)
    ref_log_p = torch.nn.functional.log_softmax(ref_logits, dim=-1)

    # Logits at position i predict token i+1. Sum over response tokens only.
    token_ids = inputs["input_ids"][0, 1:]
    log_ratio = (log_p[0, :-1] - ref_log_p[0, :-1])
    per_token = log_ratio.gather(-1, token_ids.unsqueeze(-1)).squeeze(-1)
    reward = beta * per_token[prompt_len - 1:].sum()
    return reward.item()

prompt = "What is the best way to remove duplicates from a list in Python?"
chosen  = "You can convert to a set() or use dict.fromkeys(). If order matters, the latter is recommended."
rejected = "Just loop through with a for loop."

r_chosen   = compute_implicit_reward(model, ref_model, tokenizer, prompt, chosen)
r_rejected = compute_implicit_reward(model, ref_model, tokenizer, prompt, rejected)
# If r_chosen > r_rejected, the model has learned the correct preference for this pair
```

If `r_chosen > r_rejected`, the model has learned the correct preference for that response pair. Compute this on several pairs not used in training, record the fraction of reversed pairs, and if that fraction increases in a newly trained model, revisit the data or beta.

### Scaling and Migration Strategy

Applying DPO to large models (30B+) requires a memory strategy. Loading the training model and reference model separately doubles GPU memory requirements. Combining with LoRA means only the small adapter matrices are trained, greatly reducing optimizer state, and reference probabilities are computed using the same model with the adapter disabled, so only one model copy is loaded. Gradient checkpointing trades memory for compute by recomputing intermediate activations during backpropagation instead of storing them; Flash Attention 2 avoids materializing the full attention matrix in memory, with greater benefit as sequence length grows. The actual savings depend on model, batch size, and sequence length, so compare `torch.cuda.max_memory_allocated()` before and after enabling each option with the same configuration (see the [Hugging Face training memory optimization documentation](https://huggingface.co/docs/transformers/perf_train_gpu_one)).

When migrating from an existing RLHF pipeline to DPO, the SFT checkpoint can be reused as-is. The preference pair data used to train the reward model can be applied directly to DPO. Simplifying the pipeline is just a matter of removing the reward model training stage and the PPO reinforcement learning stage.

| | RLHF+PPO | DPO (LoRA) |
|---|---|---|
| What occupies GPU memory | 4 models + generation buffers | 1 model copy + LoRA adapter |
| Training loop | Generate responses → score → PPO update | Supervised-style iteration over fixed data |
| Models needed simultaneously | SFT, reward, policy, value function | Training + reference: 2 |
| Hyperparameter sensitivity | Very high | Moderate |
| Debugging difficulty | High | Low |

---

## Closing Thoughts

### Key Takeaways

DPO reinterprets the RLHF mathematical objective to eliminate reward model training and PPO, aligning the language model directly from preference pair data. The core insight is that expressing the reward function as the log of a policy ratio causes the normalizing constant Z(x) to cancel in the Bradley-Terry model, allowing an objective equivalent to RLHF to be implemented as a simple classification loss. It can be implemented in a few dozen lines with TRL's `DPOTrainer`, and combined with LoRA — which avoids loading a separate reference model — it can be attempted on a single GPU. The biggest variables determining training quality are the beta value and data margin; noisy preference pairs are better removed.

### Decision Criteria for Adoption

Before deciding to adopt DPO, check three things. First, **is a high-quality SFT checkpoint available?** DPO is applied after SFT, and a model without basic instruction-following ability will see minimal alignment benefit. Second, **is the margin in the preference data sufficient?** If auto-labeling with an AI judge, margin filtering is mandatory. Third, **is the alignment goal well-defined?** If safety is the top priority or strict format adherence is required, consider applying DPO over multiple rounds or introducing RLHF. For general assistant quality improvement, a public preference dataset and a single DPO round are often sufficient. DPO is the alignment technique best suited to an experiment-driven approach: start fast, observe results, iterate.
