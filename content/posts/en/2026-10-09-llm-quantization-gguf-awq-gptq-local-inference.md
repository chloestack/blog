---
title: "Optimizing Local LLM Inference with Quantization (GGUF, AWQ, GPTQ)"
date: "2026-10-09 02:06"
category: "AI"
tags: ["LLM quantization", "GGUF", "AWQ", "GPTQ", "local inference"]
excerpt: "A practical guide to GGUF, AWQ, and GPTQ quantization formats for running large open-source models on consumer hardware without sacrificing usability."
koSlug: "2026-10-09-LLM-양자화(GGUF·AWQ·GPTQ)로-오픈소스-모델-로컬-추론-최적화"
---

## Table of Contents

1. Overview
2. Core Principles of Quantization
3. Comparing GGUF, AWQ, and GPTQ
4. Setting Up a Local Inference Environment
5. Performance Benchmarks and Trade-offs
6. Considerations for Production Deployment
7. Closing Thoughts

---

## Overview

### The Problem: Why Quantization Matters

LLM quantization is the key compression technique that makes it possible to run large language models with tens of billions of parameters on consumer hardware. Storing Llama 3.1 70B at FP16 (16-bit floating point) precision requires roughly 140 GB of VRAM - you need two NVIDIA A100 80 GB GPUs just to load it, which translates to tens of dollars per hour in cloud costs. Apply 4-bit quantization and the same model compresses to about 35 GB, making it runnable on a single RTX 4090 or an Apple M2 Max Mac Studio. That difference determines whether you can self-host an open-source LLM on a production server or a personal research machine at all.

### The Limitation of the Old Approach: FP16 Models

Before quantization, the standard workaround was **CPU offloading**: when GPU VRAM runs short, park some layers in system RAM or on an NVMe SSD and move only the layers you need into the GPU at inference time. But this approach can never escape the PCIe bandwidth bottleneck between the GPU and CPU, and token generation often drops to 0.5-2 tokens per second. In a real conversational application that means response latency measured in tens of seconds - unacceptable from a usability standpoint. Quantization solves this at the root by shrinking the model's representation size directly.

```diagram
en/2026-10-09-b59c2a84-01
```

The quantization format you choose has a large impact on what hardware the same model can run on.

---

## Core Principles of Quantization

### The Weight Compression Mechanism

Mathematically, quantization **approximates values from a continuous real-number space onto a finite integer grid**. A single FP32 weight takes 32 bits (4 bytes); quantized to INT4 it takes 4 bits (0.5 bytes) - an 8× compression ratio. The fundamental formula is:

`W_q = round(W / scale) + zero_point`

Here `scale` is the factor that maps the original weight range onto the integer range, and `zero_point` is an offset that corrects for asymmetric distributions. At inference time the inverse operation `W ≈ (W_q - zero_point) × scale` reconstructs an approximation of the original value. The **quantization error** introduced by this round-trip is what degrades model quality.

A key point is that modern techniques do not quantize all weights uniformly. They use **group quantization**, grouping, say, 128 or 64 weights together and computing a separate scale factor per group. Smaller group sizes improve precision but increase the overhead of storing scale metadata.

```diagram
en/2026-10-09-b59c2a84-02
```

Per-group scale factors reduce quantization error significantly compared to a single global scale for the whole model.

### Bit-Width vs. Precision Trade-offs

The choice of bit width is the central trade-off between inference performance and model quality. Here is a summary of the bit widths most commonly used in practice:

| Bit width | Integer range | 70B model size | Quality loss | Primary use |
|---|---|---|---|---|
| FP16 | — (floating point) | ~140 GB | None | Baseline, servers |
| INT8 | 0–255 | ~70 GB | Negligible | Servers, production |
| INT4 | 0–15 | ~35 GB | Small (~1–3%) | Consumer GPUs |
| INT3 | 0–7 | ~26 GB | Noticeable | Extreme VRAM savings |
| INT2 | 0–3 | ~18 GB | Severe | Experimental |

INT4 is the practical choice for most real-world cases. Measured in perplexity, 4-bit quantization typically incurs a 1–3% degradation compared to FP16, while cutting memory by more than half. INT8 loses almost nothing in quality but saves less memory than INT4. In most situations the decision comes down to which side of that line your VRAM budget puts you on.

### The Calibration Step

Post-training quantization (PTQ) applies quantization to an already-trained model, and it requires a **calibration dataset**. The calibration process runs a small number of samples (128–512) through the model, measures the activation distributions of each layer, and uses those statistics to determine optimal scale factors. The closer the calibration data is to your actual service domain, the better the quantization quality; a domain mismatch can produce erratic outputs on certain input types. GGUF distributes pre-quantized files so users never have to do calibration themselves, but when you quantize from scratch with AWQ or GPTQ, your choice of calibration data directly affects the result.

---

## Comparing GGUF, AWQ, and GPTQ

### GGUF: The Standard for the llama.cpp Ecosystem

**GGUF (GPT-Generated Unified Format)** is the model file format defined by the llama.cpp project. Introduced in the second half of 2023 to address the limitations of its predecessor GGML, it is now one of the most widely distributed quantization formats on HuggingFace. Its defining feature is **native support for both CPU and GPU inference**. When VRAM is insufficient, a hybrid mode that keeps some layers in CPU RAM while putting the rest on the GPU is supported out of the box. This makes practical inference speeds possible even on a GPU-less MacBook or an ordinary PC.

The quantization type is encoded in the GGUF filename. `Q4_K_M` means 4-bit, K-quants method, Medium group size. `Q5_K_S` means 5-bit, Small group size. K-quants is a mixed-precision scheme that keeps certain critical layers (embeddings, output layer) at a higher bit width, giving better quality than simple uniform quantization. Beyond llama.cpp itself, local LLM clients like Ollama, LM Studio, and Jan all use GGUF as their default format, which makes the installation experience the simplest of all the options.

```diagram
en/2026-10-09-b59c2a84-03
```

GGUF guarantees the model will at least run even when VRAM is tight, through layer offloading.

### AWQ: Activation-Aware Weight Quantization

**AWQ (Activation-aware Weight Quantization)** was published by MIT in 2023. Its strategy is to infer weight importance from the activation distribution and protect the important weights selectively. The core insight is that not all weights are equal. Empirically, roughly 1% of weights - those corresponding to channels with large activation values (salient channels) - account for most of the model's performance. AWQ either keeps that 1% in FP16 or adjusts its scale so it is represented at higher resolution within the INT4 range.

The practical advantage of AWQ is its **tight integration with the AutoAWQ library and vLLM**. vLLM is currently the most widely used high-performance LLM serving framework, with PagedAttention, continuous batching, and CUDA graph optimizations built in. Because vLLM supports AWQ natively, you can drop AWQ models directly into a production serving pipeline. Compared to GGUF, AWQ also delivers higher throughput and better concurrent request handling in GPU-only inference settings.

### GPTQ: A Layer-wise Optimization Strategy

**GPTQ (Generative Pre-trained Transformer Quantization)** was published in early 2023. It extends the OBQ (Optimal Brain Quantization) algorithm to LLMs, computing the optimal quantized weights layer by layer using the **Hessian matrix** to minimize quantization error. A technique called Lazy Batch Updates incrementally compensates other weights to spread the quantization error and reduce it overall.

GPTQ is currently supported by **AutoGPTQ, ExLlamaV2, and HuggingFace Transformers**. ExLlamaV2 provides highly optimized CUDA kernels specifically for GPTQ models, enabling roughly 20–30 tokens per second for Llama 2 70B GPTQ 4-bit on a single RTX 3090. The quantization process itself is slower and more memory-hungry than AWQ, but the resulting model quality is comparable and sometimes better on specific tasks.

```diagram
en/2026-10-09-b59c2a84-04
```

The three formats are each optimized for a different runtime environment; your serving stack choice effectively determines your format choice.

---

## Setting Up a Local Inference Environment

### Running GGUF Models with llama.cpp

llama.cpp is written in C/C++ and runs from a single binary with no Python environment required. On macOS, `brew install llama.cpp` is the entire installation. Building from source on Linux or Windows is also straightforward. For model files, download validated GGUF files from community accounts such as `TheBloke` or `bartowski` on HuggingFace.

The example below launches a Q4_K_M GGUF of Llama 3.1 8B Instruct as a llama.cpp server. Tune `-ngl` (number of GPU layers) to control VRAM usage.

```bash
# Download the GGUF model (using huggingface-cli)
huggingface-cli download \
  bartowski/Meta-Llama-3.1-8B-Instruct-GGUF \
  Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --local-dir ./models

# Start llama-server
# -ngl: number of layers to offload to the GPU (set higher than total layers to put everything on GPU)
# -c:   context length (directly affects memory usage)
llama-server \
  --model ./models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf \
  --port 8080 \
  --ctx-size 4096 \
  --n-gpu-layers 33 \
  --threads 8

# Output: INFO [main] model loaded // Q4_K_M, 4.65 GB, 33 layers on GPU
# Output: INFO [main] server listening at http://127.0.0.1:8080
```

`-ngl 33` tells llama.cpp to put all layers of Llama 3.1 8B (32 transformer layers + embeddings) on the GPU. On an RTX 3060 12 GB this uses 6–7 GB of VRAM and produces roughly 40–60 tokens per second at a 4096-token context. If you run out of VRAM, drop it to something like `-ngl 20` to keep some layers on the CPU.

> **Key rule**: set `-ngl` to the highest value your GPU can accommodate. Even a single layer pushed to the CPU will noticeably reduce token generation speed.

### Serving AWQ/GPTQ with vLLM

vLLM is a high-performance LLM serving engine that runs in Python. Specify an AWQ or GPTQ model from HuggingFace Hub and it will automatically load the appropriate quantization kernels. The example below serves a Qwen2.5 7B AWQ model through vLLM's OpenAI-compatible server.

```python
# vLLM OpenAI-compatible server (Python script or CLI)
# pip install vllm autoawq

from vllm import LLM, SamplingParams

# Load AWQ model: specify awq for the quantization parameter
llm = LLM(
    model="Qwen/Qwen2.5-7B-Instruct-AWQ",
    quantization="awq",           # enable AWQ kernels
    max_model_len=8192,
    gpu_memory_utilization=0.85,  # use up to 85% of VRAM
    dtype="float16",
)

sampling_params = SamplingParams(
    temperature=0.7,
    top_p=0.9,
    max_tokens=512,
)

prompts = ["What is the capital of South Korea? Please explain in detail."]
outputs = llm.generate(prompts, sampling_params)

for output in outputs:
    print(output.outputs[0].text)
# Output: "The capital of South Korea is Seoul. Seoul is located in the mid-western part of the Korean Peninsula..."
```

To run vLLM from the CLI: `python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq --port 8000` spins up an OpenAI-compatible endpoint in one command. This is especially convenient for switching an application that already uses the OpenAI SDK to a local model by changing only `base_url`.

### Optimal Configuration by Hardware

The right configuration varies by hardware. VRAM capacity relative to model size is the most critical factor.

```diagram
en/2026-10-09-b59c2a84-05
```

VRAM capacity is the starting point for your serving strategy; even without a GPU, CPU inference is perfectly practical for models at 7B and below.

For Apple Silicon there is no separate VRAM; it uses unified memory. An M2 Pro with 16 GB can run a 7B Q4 model; an M2 Max with 32 GB can run a 13B Q4 or a 7B FP16 model at practical speeds. Metal GPU acceleration is natively supported in llama.cpp, so you can use `-ngl 999` to put all layers on the GPU and expect roughly 30–50 tokens per second.

---

## Performance Benchmarks and Trade-offs

### Inference Speed and Memory Usage

Inference performance differs across quantization formats. On the same model and the same hardware, tokens-per-second can vary by more than 2× depending on the format and runtime. Here are rough figures for Llama 3 8B on a single RTX 4090:

| Format | Runtime | VRAM usage | Generation speed (t/s) | Batch handling | Key strength |
|---|---|---|---|---|---|
| FP16 | vLLM | ~16 GB | ~120 | Excellent | Quality baseline |
| INT8 (GPTQ) | vLLM | ~10 GB | ~90 | Excellent | Quality-speed balance |
| INT4 AWQ | vLLM | ~6 GB | ~110 | Excellent | Best for GPU serving |
| INT4 GPTQ | ExLlamaV2 | ~6 GB | ~130 | Moderate | Fast single requests |
| Q4_K_M (GGUF) | llama.cpp | ~5.5 GB | ~80 | Limited | CPU compatibility |
| Q4_K_M (GGUF) | Ollama | ~5.5 GB | ~75 | Limited | Easy installation |

AWQ beats GPTQ on batch throughput in vLLM because AWQ's CUDA kernels have a more efficient memory access pattern when combined with PagedAttention. GPTQ is fast for single-stream inference thanks to ExLlamaV2, but throughput drops off relatively quickly as concurrent requests increase.

### Evaluating Quality Loss

Quality degradation from quantization is measured with perplexity (PPL). Lower perplexity means the language model predicts text better; a PPL increase of within 5% relative to the original is generally imperceptible in practice.

```diagram
en/2026-10-09-b59c2a84-06
```

For most tasks, INT8 and INT4 AWQ show no statistically significant difference from the original.

One caveat: perplexity does not represent every task. For math reasoning or code generation, INT4 can show meaningfully lower accuracy than INT8. For summarization, translation, and general conversation, the difference is almost nil. So when deploying to a specific domain, running your own evaluation on a domain-appropriate benchmark dataset is important.

### Choosing the Right Quantization

The choice comes down to four factors. First, **hardware environment**: if you have no GPU or setting up a CUDA environment is impractical, GGUF is your only realistic option. If you have a GPU and are running a serving server, AWQ + vLLM is the most solid combination. Second, **concurrent request volume**: a single-user interactive setup is fine with GGUF, but a multi-user API server needs vLLM's batch processing. Third, **ability to re-quantize**: if you want to use domain-specific calibration data, you need to quantize yourself with AWQ or GPTQ. Fourth, **operational complexity**: if your team's capacity or maintenance bandwidth is limited, serving GGUF through Ollama carries the lowest operational burden.

---

## Considerations for Production Deployment

### Common Mistakes and Pitfalls

The most frequent problem is **underestimating context length and KV cache memory**. The KV cache stores the key and value matrices from previous tokens during inference, and it grows linearly with context length. For example, the Llama 3.1 8B Q4 model itself uses 5.5 GB of VRAM, but at a context of 32,768 tokens the KV cache needs an additional 8–12 GB. This is the root cause of most OOM (out-of-memory) errors that happen after the model has loaded successfully and then processes a long request.

The second pitfall is **ignoring the relationship between batch size and memory**. Setting vLLM's `gpu_memory_utilization` too high causes GPU memory fragmentation that actually reduces throughput. The recommended range is 0.80–0.90; start at 0.85 and adjust based on measured load.

The third is **version mismatches between the quantization format and the runtime**. ExLlamaV2, AutoGPTQ, and AutoAWQ are each maintained independently, and certain version combinations cause models to load incorrectly or produce corrupted output. Check the recommended library versions on the HuggingFace model card first, and pin versions in isolated virtual environments.

```diagram
en/2026-10-09-b59c2a84-07
```

When something goes wrong in production, it is most efficient to diagnose in this order: OOM → output quality → speed.

### Monitoring and Debugging

There are specific metrics you must track in production. **TTFT (Time to First Token)** is the time from receiving a request to producing the first token; it reflects prefill performance and grows as system prompts or context lengths accumulate. **TPOT (Time per Output Token)** is the speed of the decoding phase and reveals how well you are utilizing VRAM bandwidth for loading model weights.

vLLM exposes Prometheus-compatible metrics at the `/metrics` endpoint. Visualizing metrics like `vllm:num_requests_running`, `vllm:gpu_cache_usage_perc`, and `vllm:time_to_first_token_seconds` in a Grafana dashboard lets you catch anomalies quickly. In a GGUF + llama.cpp environment, running with `--verbose` prints per-request latency and VRAM usage to stdout.

```diagram
2026-10-09-b59c2a84-08
```

Just these two metrics - TTFT and KV cache utilization - are enough to catch most performance problems early.

### Scaling and Migration

When moving from a single GPU to multiple GPUs or multiple nodes, there are things to consider. **Tensor parallelism** splits model layers across GPUs and is configured in vLLM with something like `--tensor-parallel-size 2`. GGUF + llama.cpp does not natively support multi-GPU tensor parallelism, so you should plan a migration to vLLM when you reach that scale.

When upgrading a model - say from Llama 3.1 to Llama 3.2 - you either wait for a new quantized version at the same bit width to appear on HuggingFace, or you quantize it yourself. Self-quantizing uses AutoAWQ or AutoGPTQ scripts; on an RTX 4090, quantizing a 70B model takes roughly 1–2 hours. Preparing calibration data that matches your service domain during that process will lift quality noticeably.

Quantized models can also be combined with fine-tuning. **QLoRA (Quantized Low-Rank Adaptation)** trains LoRA adapters on top of an INT4-quantized model, enabling domain-specific fine-tuning with minimal GPU memory. The trained adapters are stored separately from the quantized model and merged dynamically at serving time. This approach makes it possible to fine-tune a 70B model on a single 24 GB VRAM GPU.

---

## Closing Thoughts

### Key Takeaways

LLM quantization is the core technique for operating large models within a realistic hardware budget. Each of the three major formats has a clear home. **GGUF** suits individual developers and small teams, thanks to CPU compatibility and a low barrier to entry. **AWQ** paired with vLLM strikes the right balance of throughput and operational convenience in a GPU server environment. **GPTQ** combined with ExLlamaV2 shines in interactive applications where single-request latency matters most. INT4 quantization incurs quality loss that is hard to perceive in practice on most tasks, while saving close to 4× memory compared to FP16.

### Decision Criteria

If you are starting local inference for the first time, Ollama + GGUF Q4_K_M is the fastest starting point. If you need to run an API server for your team, vLLM + AWQ is the default choice; it also wins for batch workloads where throughput matters more than latency. For a single-user interactive chatbot deployed as a microservice, GPTQ + ExLlamaV2 may deliver a better perceived experience. Regardless of format, evaluating quality on a domain-appropriate benchmark before going to production is non-negotiable. Higher quantization levels improve inference speed and memory efficiency, but they also raise the quality risk, and verifying that balance with data is the foundation of a reliable service.
