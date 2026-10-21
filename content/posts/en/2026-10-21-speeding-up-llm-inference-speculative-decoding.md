---
title: "Speeding Up LLM Inference with Speculative Decoding"
date: "2026-10-21 10:40"
category: "AI"
tags: ["Speculative Decoding", "LLM inference optimization", "Draft model", "vLLM"]
excerpt: "Speculative Decoding speeds up LLM responses by letting a small model guess ahead while the large model checks the guesses in one pass. Why bad guesses make it slower, and how to pick the draft model and guess length."
koSlug: "2026-10-21-Speculative-Decoding으로-LLM-추론-속도-높이기"
---

## Table of Contents

1. Overview
2. How Speculative Decoding speeds up inference
3. Choosing a draft model and implementing the verification step
4. The acceptance rate and throughput tradeoff
5. Pitfalls in production and how to handle them
6. Closing thoughts

---

## Overview

Chatbot replies trickle out one word at a time because a large model has to re-read tens of gigabytes of weights from GPU memory for every token it produces. Speculative Decoding lets a small model guess the next few tokens and has the large model grade those guesses in a single pass, so responses get faster while the output stays exactly the same. The paper that introduced it reported a 2–3x speedup with identical outputs ([Leviathan et al., 2023](https://arxiv.org/abs/2211.17192)). But when the small model guesses wrong too often, the wasted work piles up and it ends up slower. This post covers how to pick the small model, how many tokens to let it guess at once, and how to check whether it is actually helping after you turn it on.

Speculative Decoding is a technique for speeding up LLM inference. Large models like GPT-4o or Llama 70B generate tokens one at a time, in sequence (autoregressive), which means even generating a single sentence of response accumulates noticeable latency. Speculative Decoding works around this. A small draft model rapidly predicts several tokens ahead, then the large target model verifies those predictions in a single forward pass in parallel. Because verification runs in parallel, overall throughput increases compared to running the target model sequentially every step.

This post covers how the verification step mathematically guarantees output quality, how to choose a draft model, and what settings affect throughput in a real serving environment. It also lays out criteria for distinguishing task types where Speculative Decoding is effective — like code completion and document summarization — from those where it isn't.

---

## How Speculative Decoding speeds up inference

### The structural bottleneck of autoregressive decoding

An LLM computes the probability distribution for the next single token by referring to every token it has already generated. This process must proceed in order and cannot be parallelized. No matter how much GPU compute you have, the "generate token → feed back as input" cycle repeating in sequence is the ceiling.

The interesting part is that this bottleneck comes from **memory bandwidth** more than raw compute. Reading billions of parameters from GPU memory takes longer than the actual matrix math. Processing one token at a time means those parameters have to be re-read each step. ==Verifying multiple tokens at once amortizes the parameter-loading cost, which meaningfully increases throughput on the same hardware.==

### Speculative execution and rejection sampling

Speculative Decoding works exactly as its name suggests — speculatively. The draft model generates k tokens, then the target model takes those k tokens as input and computes the probability distributions for k+1 positions simultaneously in a single forward pass.

At each position, the target model's probability is compared against the draft model's probability to decide whether to accept. The key detail is that this acceptance criterion isn't a simple threshold. It uses **rejection sampling** designed so that the final output follows the target model's probability distribution exactly. Even if the draft model proposes a wrong token, the final output distribution is mathematically identical to what the target model would have produced alone.

```diagram
en/2026-10-21-39f56a15-01
```

When the target model accepts a draft token, it uses it as-is. When it rejects one, it samples a new token from the target model's distribution and restarts from that position. This mechanism means Speculative Decoding raises speed without sacrificing output quality at all.

---

## Choosing a draft model and implementing the verification step

### The draft model must share the target's vocabulary

The most common mistake when choosing a draft model is thinking "any small model will do." ==The draft model and target model must share the same tokenizer and the same vocabulary space for the verification step to be meaningful.== If the vocabulary distributions differ, draft tokens and target probability distributions can't be compared on the same axis, and rejection sampling doesn't work at all.

Here are practical combinations for real projects:

| Target model | Recommended draft model | Notes |
|---|---|---|
| Llama 3.1 70B | Llama 3.2 1B / 3B | Same architecture, officially supported |
| Llama 3.1 8B | Llama 3.2 1B | Benefit may shrink — measure first |
| Gemma 2 27B | Gemma 2 2B | Google's official draft model |
| Mistral 7B | — | No official draft; custom required |

If the draft model is too weak, acceptance rates drop and you end up slower than the target alone. If it's too large, draft generation itself becomes the bottleneck. The right size — where acceptance rate and speed gain are balanced — depends on the target model's characteristics, the domain, and actual acceptance rate measurements you run yourself.

### Verifying behavior with Hugging Face

The fastest way to see this for yourself is to pass `assistant_model` to the `generate` method in Hugging Face `transformers`. It has the rejection sampling verification logic built in, so you can observe the behavior without writing it yourself.

With a Llama-family model downloaded locally, use `num_assistant_tokens` to specify how many tokens the draft proposes at once.

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

# Baseline: target model generating alone
t0 = time.perf_counter()
out_base = target_model.generate(**inputs, max_new_tokens=100)
t_base   = time.perf_counter() - t0

# Speculative Decoding: draft proposes 5 tokens at a time
t1 = time.perf_counter()
out_spec = target_model.generate(
    **inputs,
    assistant_model=draft_model,
    num_assistant_tokens=5,    # k value: draft proposes 5 at a time
    max_new_tokens=100,
)
t_spec = time.perf_counter() - t1

# Results vary by GPU, but the output text is identical
print(f"Baseline generation:   {t_base:.2f}s")
print(f"Speculative Decoding:  {t_spec:.2f}s")
```

The output text from both paths is equivalent in meaning — Speculative Decoding doesn't change the output distribution. Try running with `num_assistant_tokens` set to 1, 3, 5, and 10 to see firsthand at what point the benefit disappears or reverses.

---

## The acceptance rate and throughput tradeoff

### Why acceptance rate is the key metric

The real-world speed benefit of Speculative Decoding is determined by the **acceptance rate** — the fraction of draft-proposed tokens that the target model actually adopts.

A high acceptance rate means multiple tokens get confirmed in a single target forward pass. A low acceptance rate means you're just paying the draft model's compute cost for almost no gain. ==If tokens/s with Speculative Decoding is lower than the target model alone, the acceptance rate is too low to pay off. Swap the draft model for a larger one from the same family or one tuned to your domain.==

Acceptance rate varies significantly by prompt type. It's higher for tasks where the next token is reasonably predictable, like code completion, and lower for tasks with many valid continuations, like creative writing or open-ended questions. Hugging Face `generate()` doesn't report the acceptance rate directly, but what ultimately matters is speed. The code below runs the same prompt once without and once with the draft model and measures the speedup for each task type.

```python
import time
from transformers import AutoTokenizer, AutoModelForCausalLM
import torch

target = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.1-8B-Instruct", torch_dtype=torch.float16, device_map="auto"
)
# Same Llama 3 family, so the vocabulary (tokenizer) is shared
draft = AutoModelForCausalLM.from_pretrained(
    "meta-llama/Llama-3.2-1B-Instruct", torch_dtype=torch.float16, device_map="auto"
)
tokenizer = AutoTokenizer.from_pretrained("meta-llama/Llama-3.1-8B-Instruct")

prompts = {
    "Code completion": "def binary_search(arr, target):",
    "Factual query": "What is the capital of France? Explain its history briefly.",
    "Creative writing": "Write a poem about autumn leaves.",
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
    tokens_per_sec(inputs, max_new_tokens=8)  # Throw away one run to exclude warm-up cost
    base = tokens_per_sec(inputs)
    spec = tokens_per_sec(inputs, assistant_model=draft, num_assistant_tokens=5)
    print(f"[{label}] alone {base:.1f} tok/s, speculative {spec:.1f} tok/s, speedup {spec / base:.2f}")
```

Read one number: the speedup. Above 1, it's worth turning on for that task; around or below 1, the draft model is guessing wrong often enough that you're only adding work. The same draft model often splits across task types, so the place to start is a few dozen real prompts from your own service.

### Balancing draft length k against throughput

Increasing the draft length k raises the payoff when tokens are accepted, but also raises the waste when they're rejected. You always have to look at this together with acceptance rate.

```diagram
en/2026-10-21-39f56a15-02
```

Larger k means bigger gains when accepted — but on tasks with frequent rejection it's a net loss. In serving environments, a common approach is to start k between 3 and 7, measure acceptance rate, and tune from there.

Batch processing adds another wrinkle. When requests within a batch have different acceptance rates, some requests confirm k tokens while others get rejected mid-sequence, producing unequal token lengths. That imbalance creates head-of-line blocking within the batch, so larger batches tend to see diminishing returns from Speculative Decoding. The effect is most pronounced with small batches or streaming single-request workloads.

---

## Pitfalls in production and how to handle them

### Memory and first-token latency

Introducing Speculative Decoding increases GPU memory usage because the target model and draft model both need to be loaded simultaneously. Attaching a 3B draft model to a 70B target means extra memory for the draft model's parameters and KV cache.

==If you add Speculative Decoding without enough memory headroom, the cost of OOM restarts can outweigh the throughput gains.== As a rough lower bound for parameter storage in fp16: parameter count (billions) × 2 GB. A 3B draft model needs roughly 6 GB, a 7B roughly 14 GB — but KV cache and activation memory are on top of that. Actual VRAM requirements can be considerably higher than these lower bounds depending on batch size and sequence length.

TTFT (Time-to-First-Token) also needs attention. Speculative Decoding increases overall throughput; it doesn't reduce first-response latency. Because the draft generation step adds overhead, the first token can actually arrive later. If your service cares about how quickly the first character appears in a streaming response, you must measure this.

```diagram
en/2026-10-21-39f56a15-03
```

If memory is tight, quantizing the draft model to 4-bit is one option. Acceptance rate may drop slightly, but it reduces the memory burden.

### Checking the effect after you turn it on

Whether Speculative Decoding actually helps in production can **only be known by comparing against the numbers from before you turned it on**. Measure in this order and you'll also know what to change.

| Step | What to measure | If you see this |
|---|---|---|
| 1. Before | Target-only tokens/s and TTFT (time to first token) | These two values are the baseline for every comparison after |
| 2. After | tokens/s on the same traffic | Below baseline: go to 3. Above: go to 4 |
| 3. Acceptance rate | Share of draft tokens that were accepted | If low, shorten the guess length k or swap the draft model |
| 4. TTFT | TTFT after turning it on | If it went up and streaming responsiveness matters, decide which matters more: the throughput gain or the first-character delay |

Say you attached it to an internal code assistant on vLLM. The first step is to split a day of traffic into before and after and compare tokens/s. If code requests with high acceptance are mixed with free-form questions with low acceptance, split by request type — otherwise the average hides where you're losing.

### Choosing a framework

You'll rarely need to implement rejection sampling yourself. Start by checking whether the serving framework you already use supports a separate draft model. The table below follows each project's official docs (checked October 2026).

| Framework | Separate draft model | How to turn it on | Good fit when |
|---|---|---|---|
| vLLM | Supported | `--speculative-config '{"method": "draft_model", "model": "<draft model>", "num_speculative_tokens": 5}'` ([docs](https://docs.vllm.ai/en/latest/features/speculative_decoding/)) | You already serve with vLLM. One setting gets you started |
| TensorRT-LLM | Supported (Draft-Target) | Configure the draft and target models to run separately ([docs](https://nvidia.github.io/TensorRT-LLM/advanced/speculative-decoding.html)) | You need to squeeze latency on NVIDIA GPUs |
| llama.cpp (`llama-server`) | Supported | `-md <draft model file>`, guess length via `--spec-draft-n-max` ([docs](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)) | Local, CPU, or edge setups |
| TGI (Hugging Face) | Not supported | Only Medusa-head models or n-gram (`--speculate`) ([docs](https://huggingface.co/docs/text-generation-inference/conceptual/speculation)) | If you need a separate draft model, pick another framework |

The decision usually ends with the stack you already run. If you serve with vLLM, add one `--speculative-config` line and compare in the order above. If you're on TGI, try n-gram speculation first instead of a separate draft model — for repetitive code and document work, that alone can help. If you're choosing fresh and need to push latency as low as possible on NVIDIA GPUs, TensorRT-LLM is a candidate, though it takes more setup than vLLM.

---

## Closing thoughts

Speculative Decoding increases inference speed without changing the target model's output distribution at all. The structure — draft model proposes candidates quickly, target model verifies in parallel in a single forward pass — lets you raise throughput in LLM serving environments where memory bandwidth is the bottleneck.

Three checks to run when deciding whether to adopt it: First, does a draft model exist that shares vocabulary with your target? Second, is there enough memory on the GPU to load the draft model on top of everything else (including KV cache and activation memory beyond just parameter storage)? Third, does your service prioritize maximizing overall throughput, or minimizing first-token latency?

For tasks where the next token is reasonably predictable — code completion, document summarization — acceptance rates are high and the benefit is clear. For tasks with diverse distributions — creative generation, open-ended conversation — measure acceptance rate first before assuming any benefit. Speculative Decoding isn't a universal accelerator; it's a conditional optimization that only pays off when tokens/s with it turned on comes out higher than the target alone.
