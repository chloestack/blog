---
title: "Serving Local LLMs with Ollama and OpenAI-Compatible API Integration"
date: "2026-10-18 02:10"
category: "AI"
tags: ["Ollama", "LocalLLM", "OpenAICompatibleAPI", "LLMDevEnvironment", "Spring AI"]
excerpt: "Learn how Ollama lets you run open-weight LLMs locally with an OpenAI-compatible API, cutting costs and keeping sensitive data off external servers."
koSlug: "2026-10-18-Ollama로-로컬-LLM-서빙과-OpenAI-호환-API-연동하기"
---

## Table of Contents

1. Overview
2. Ollama Architecture and How It Works
3. Installing Ollama and Serving Your First Model
4. OpenAI-Compatible API Integration
5. Performance Characteristics and Technology Selection Criteria
6. Considerations When Applying to Production
7. Closing Thoughts

---

## Overview

### Why You Need a Local LLM Development Environment

As LLM-powered application development spreads rapidly, the limitations of relying solely on commercial APIs like OpenAI or Anthropic during development and testing are becoming clearer. API call costs look small at the prototype stage, but they grow unexpectedly as repeated tests and CI pipeline runs accumulate. Add in the security concern of sending sensitive data—customer records, internal documents—to external servers, and the case for running LLMs locally becomes obvious. Ollama is an open-source tool built for exactly this situation. It is designed so that you can serve open-weight models like Llama 3, Mistral, Gemma, and Qwen locally on macOS, Linux, or Windows with just a few commands.

What makes Ollama worth paying attention to is that it does more than just run models. It also exposes an endpoint compatible with OpenAI's Chat Completions API, so code written against the OpenAI SDK, LangChain, or Spring AI can switch to a local model with minimal changes. This makes it genuinely practical to use a local model at no cost during development and switch to a commercial API only for production deployment.

```diagram
en/2026-10-18-e554af31-01
```

Because commercial APIs and Ollama expose the same interface to your application, a single environment variable is all it takes to move between the two environments.

### Limitations of Previous Approaches

Before Ollama, ways to run LLMs locally did exist. You could build llama.cpp from source, or use Hugging Face's `transformers` library. But these approaches shared a common barrier to entry. The setup process itself demanded substantial expertise: CUDA driver version conflicts, Python virtual environment management, manual conversion of model weight files. Teams developing in non-Python environments like Java or Go faced the additional burden of managing the entire Python ecosystem.

Docker-based solutions were also used as an alternative, but GPU passthrough configuration and large image management were tedious, and including model weights inside a container image meant image sizes of tens of gigabytes were not uncommon. Ollama abstracts away all this complexity into a single binary, and it adopts a structure that manages models as OCI (Open Container Initiative) artifacts from a registry.

| Approach | Installation Difficulty | Non-Python Support | OpenAI Compatible | Notes |
|---|---|---|---|---|
| Build llama.cpp directly | High | Possible but complex | Requires separate setup | Must rebuild for each version |
| Hugging Face transformers | Medium | Python only | None | Python environment required |
| Docker + llama.cpp | Medium | Possible | Requires separate setup | GPU passthrough configuration required |
| Ollama | Low | All languages | Built-in | Throughput limits in production |

---

## Ollama Architecture and How It Works

### Model Layer Management

Understanding Ollama's internals helps you work with models more efficiently. Ollama manages models in layers. Each model is a combination of multiple layers: a base weight layer, LoRA adapter layers, a system prompt, and a conversation template. This layer structure is analogous to container image layers, and when you install two models that share the same base weights, Ollama does not store duplicate data. For example, if `llama3.2:3b` and `llama3.2:3b-instruct-q4_K_M` share the same base layer, disk space is saved.

Model files are stored by default in the `~/.ollama/models` directory. They contain weight files and metadata in GGUF (GPT-Generated Unified Format), and Ollama uses llama.cpp as its core inference engine. llama.cpp runs on CPU only, but it also automatically detects Apple Silicon Metal, NVIDIA CUDA, and AMD ROCm to enable GPU acceleration. This auto-detection is the core reason Ollama works without any configuration beyond installing the driver.

```diagram
en/2026-10-18-e554af31-02
```

When Metal or CUDA is detected, the number of GPU layers is automatically maximized, and mixed CPU/GPU execution (partial offload) is also supported.

### Request Processing Flow

Ollama runs as an HTTP server started with the `ollama serve` command. The default port is **11434**, and you can change the binding address with the `OLLAMA_HOST` environment variable. When a client sends a request to the `/api/chat` or `/v1/chat/completions` endpoint, the Ollama server checks whether that model is already loaded in memory. If it is the first request, loading the model into memory takes a few seconds, but subsequent requests respond immediately.

By default, a model is unloaded from memory five minutes after the last request. This duration is adjustable with the `OLLAMA_KEEP_ALIVE` environment variable; setting it to `-1` keeps the model loaded permanently. In a development environment, pinning this value to `-1` is the simplest way to eliminate first-request latency. On the other hand, in memory-constrained environments, keeping a short unload time to share memory with other processes is also a valid strategy.

```diagram
en/2026-10-18-e554af31-03
```

Model load latency only occurs on the first request. Setting `OLLAMA_KEEP_ALIVE=-1` eliminates that latency.

### Supported Backends and Hardware Acceleration

The hardware acceleration backends Ollama supports vary by platform. On macOS it automatically uses Apple Silicon's Metal GPU, and thanks to the unified memory architecture, the CPU and GPU share the same memory pool. This means a 16 GB M3 MacBook can run a 7B model without trouble. On Linux, CUDA (NVIDIA) and ROCm (AMD) are supported, and Ollama detects them automatically as long as the drivers are installed correctly. On Windows, CUDA support under WSL2 is stable, and both CUDA and ROCm are also supported in the native environment.

| Platform | Backend | Characteristics | Notes |
|---|---|---|---|
| macOS (Apple Silicon) | Metal | Unified RAM/VRAM memory | RAM capacity effectively is VRAM |
| Linux (NVIDIA) | CUDA | High performance, broad support | CUDA driver 12.x or later recommended |
| Linux (AMD) | ROCm | Partial model support | Verify ROCm 6.x compatibility beforehand |
| Windows | CUDA / ROCm | Native support | Routing through WSL2 is more stable |
| CPU only | llama.cpp | Hardware-agnostic | Slow; models 3B or smaller recommended |

---

## Installing Ollama and Serving Your First Model

### Installation and Initial Setup

Installation is very straightforward. On macOS, run `brew install ollama` or download the installer from the official site (https://ollama.com). On Linux, a single official install script is all you need, and on Windows you can download the installer or install via Winget. Once installation is complete, the `ollama` CLI is registered in the system path, and on macOS the server starts automatically as a menu bar app.

To expose the Ollama server to external networks in a development environment, set the `OLLAMA_HOST=0.0.0.0` environment variable before starting the server. The default is `127.0.0.1:11434`, bound to localhost only. This environment variable matters when using Ollama inside a CI pipeline or Docker container. Using the official Docker image (`ollama/ollama`) simplifies configuration in container environments, and if GPU support is needed, run the container with the `--gpus all` flag in an environment where the NVIDIA Container Toolkit is pre-installed.

```diagram
en/2026-10-18-e554af31-04
```

Installation varies by platform, but the end result is the same HTTP server running in all cases.

### Downloading and Running a Model

Before running a model, you need to pull it. Hundreds of models are registered in the official Ollama library (https://ollama.com/library). You can specify the quantization level by appending a tag to the model name. For example, `llama3.2:3b-instruct-q4_K_M` is the Llama 3.2 3B model's instruction-tuned version with Q4_K_M quantization applied. Lower quantization levels reduce file size and memory usage but can degrade response quality somewhat. For development and testing, Q4_K_M or Q5_K_M strike a good balance between speed and quality.

Before running a model for the first time, it is worth sending REST API requests directly to verify behavior. Below are examples of calling both the Ollama native endpoint and the OpenAI-compatible endpoint with `curl`.

```bash
# Ollama native endpoint (stream: false → single JSON response)
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2:3b",
    "messages": [{"role": "user", "content": "Hello, please give a brief introduction of yourself."}],
    "stream": false
  }'

# OpenAI-compatible endpoint — changing only base_url makes this work identically
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "llama3.2:3b",
    "messages": [{"role": "user", "content": "Hello, please give a brief introduction of yourself."}]
  }'
# Result: {"id":"chatcmpl-...","object":"chat.completion",
#          "choices":[{"message":{"role":"assistant","content":"Hello! I am Llama 3.2..."}}]}
```

Specifying `stream: false` returns the full response as a single JSON object. The OpenAI-compatible endpoint requires an `Authorization` header, but authentication is not actually validated—any non-empty string passes.

### Verifying Basic API Calls

After confirming the model responds correctly, you can query the list of locally installed models with the `/api/tags` endpoint. This endpoint returns model names, sizes, modification dates, and quantization information. The `ollama list` CLI command shows the same information in the terminal. You can check which models are currently loaded in memory and their VRAM usage with `/api/ps`.

Using a Modelfile, you can version-control the system prompt, context size, and sampling parameters. Build a Modelfile based on `FROM llama3.2:3b` with `SYSTEM` and `PARAMETER` directives added, then run `ollama create mymodel -f Modelfile` to treat shared team model configuration like code. This approach is especially useful when validating production system prompts locally.

> **Key rule**: The `Authorization: Bearer <arbitrary value>` header is only format-validated by the OpenAI-compatible endpoint. An empty string is rejected, but arbitrary values like `"ollama"` or `"sk-anything"` all pass. Omitting this header in a test script will produce a 401 error.

---

## OpenAI-Compatible API Integration

### Endpoint Structure and Compatibility Scope

Ollama implements the main endpoints of the OpenAI Chat Completions API under the `/v1` prefix. `/v1/chat/completions`, `/v1/models`, and `/v1/embeddings` are supported. In code using the OpenAI SDK, changing only `base_url` to the Ollama server address leaves the rest of the code working as-is. That said, not all parameters behave identically. Support for advanced parameters like `response_format`, `tool_choice`, and `parallel_tool_calls` varies by model and Ollama version.

**Function calling and JSON mode** in particular require the model to support them natively to work correctly. Recent models like Llama 3.1 and later, Mistral, and Qwen2.5 support function calling and structured output, but older models may not behave as expected. Verifying this with tests upfront reduces unexpected behavioral differences when switching to production.

```diagram
en/2026-10-18-e554af31-05
```

The core value of the OpenAI compatibility layer is being able to swap between a local model and a commercial API by changing only `base_url`.

### Integration from Java/Spring Code

Java LLM frameworks like Spring AI and LangChain4j officially support Ollama. However, using the OpenAI-compatible endpoint directly means integration is possible with just a standard HTTP client, without a framework dependency. The example below shows configuration for connecting to Ollama using `spring-ai-openai-spring-boot-starter` in a Spring Boot project. Changing only `base-url` in `application.yml` lets you switch to OpenAI in production.

```java
// application.yml configuration:
// spring.ai.openai.base-url=http://localhost:11434
// spring.ai.openai.api-key=ollama
// spring.ai.openai.chat.options.model=llama3.2:3b

@Service
public class LocalLlmService {

    private final ChatClient chatClient;

    public LocalLlmService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
    }

    // Synchronous call — returns the full response as a String
    public String ask(String question) {
        return chatClient.prompt()
                .user(question)
                .call()
                .content(); // Result: model's text response (String)
    }

    // Streaming call — returns a Flux<String> token by token
    public Flux<String> stream(String question) {
        return chatClient.prompt()
                .user(question)
                .stream()
                .content(); // Result: token-level streaming Flux
    }
}
```

`ChatClient` is Spring AI's abstraction layer, and it calls through the same interface regardless of whether the backend is Ollama or OpenAI. Swapping `base-url` in `application.yml` switches the model provider without any code changes.

### Handling Streaming Responses

Receiving LLM responses as a stream rather than waiting for the full text to be generated is far better for user experience. A 7B parameter model in a CPU environment can take 15–30 seconds to generate 100 tokens, and with a blocking approach the user has no way to tell whether a response is coming. To enable streaming on the OpenAI-compatible endpoint, add `"stream": true` to the request body. The response is delivered token by token in Server-Sent Events (SSE) format.

One thing to watch out for with streaming is the difference in end-of-stream signals. On the OpenAI-compatible endpoint (`/v1/chat/completions`), the stream ends with a `data: [DONE]` line. On the Ollama native endpoint (`/api/chat`), the end is signaled by a `"done": true` field in the last chunk. Spring AI's `Flux<String>` handles this termination signal automatically, so you do not need to parse it yourself, but if you implement streaming directly with WebClient or OkHttp you need to be aware of this difference.

| Endpoint | End Signal | Streaming Format | When to Use |
|---|---|---|---|
| `/v1/chat/completions` | `data: [DONE]` | SSE (OpenAI format) | When using OpenAI SDK or Spring AI |
| `/api/chat` | `"done": true` | JSON Lines | Ollama native client |
| `/api/generate` | `"done": true` | JSON Lines | Single text generation, no conversation needed |

---

## Performance Characteristics and Technology Selection Criteria

### Inference Performance by Hardware

Ollama's inference performance varies significantly depending on the hardware you use. The key performance metric is **TPS (Tokens Per Second)**. You need at least 10 TPS for a conversational interface to feel natural, and at 20 TPS or above users perceive the speed as comparable to typing. On an Apple M3 Max, the `llama3.2:3b` model achieves roughly 80–100 TPS; on an RTX 4090 it can exceed 150 TPS. On a CPU-only environment (16-core x86), a 7B model runs at around 5–15 TPS, which is somewhat slow for interactive use.

Quantization level is the key parameter determining the performance-quality tradeoff. Q2_K is the smallest but has noticeable quality degradation; Q8_0 is nearly original quality but requires substantial memory. For development and testing, Q4_K_M or Q5_K_M is a reasonable starting point.

| Quantization | Memory (7B model) | Quality | Speed | When to Use |
|---|---|---|---|---|
| Q2_K | ~2.5 GB | Low | Fast | When memory is extremely limited |
| Q4_K_M | ~4.1 GB | Good | Balanced | Default for development/testing |
| Q5_K_M | ~4.9 GB | Better | Medium | Quality-focused testing |
| Q8_0 | ~7.2 GB | Near original | Slow | Quality benchmark baseline |
| FP16 | ~14 GB | Original | Slowest | GPU environments with sufficient VRAM |

### Comparison with Alternative Tools

Besides Ollama, other tools exist for local LLM serving. LM Studio is GUI-based and easy for non-developers to use, but its API server features are relatively limited. vLLM is a production-grade server optimized for throughput, supporting batching and continuous batching, but it requires an NVIDIA GPU and has high configuration complexity. Building the llama.cpp server directly gives you maximum flexibility at the cost of significant setup effort. LocalAI provides an OpenAI-compatible layer similar to Ollama, but its community ecosystem is smaller.

```diagram
en/2026-10-18-e554af31-06
```

Tool selection ultimately comes down to your use case and environment. For development and testing, Ollama provides the fastest starting point.

### When to Choose Ollama

There are three scenarios where Ollama has a clear advantage. First, rapid prototyping of LLM features early in development—you can start immediately without an API key and run repeated tests without cost concerns. Second, building internal tools that handle sensitive data—when customer data or internal documents must not be sent to external servers, local inference is a requirement, not a choice. Third, teams that want to maintain development velocity while minimizing commercial API costs—a strategy of Ollama in development and commercial APIs in staging and production captures both cost and quality.

There are also cases where Ollama is not the right fit. Production environments that need to handle thousands of concurrent users, or cases where reasoning quality at the level of GPT-4o or Claude 3.7 Sonnet is strictly required, are currently beyond what open-weight models alone can deliver. If you built on the OpenAI-compatible interface from the start, switching to a commercial API in those situations is just an environment variable change.

---

## Considerations When Applying to Production

### Common Mistakes and Pitfalls

The most common problem when first using Ollama is a mismatch between model size and available memory. Running a 7B Q4_K_M model (about 4.1 GB) in an 8 GB RAM environment can cause OOM errors because the OS and other processes already occupy a significant portion of memory. You need 20–30% additional memory beyond the model weight size for context processing and the KV cache. Setting the context length higher than the default of 2048 (e.g., `num_ctx: 8192`) grows the KV cache proportionally, so if you need long contexts, make sure you have enough memory headroom.

The second pitfall is layer distribution issues in multi-GPU environments. Ollama automatically detects multiple GPUs, but when GPU memory is uneven or PCIe bandwidth differs, performance can come in lower than expected. Adjusting the reserved memory per GPU with the `OLLAMA_GPU_OVERHEAD` environment variable can help. Explicitly specifying which GPUs to use with `CUDA_VISIBLE_DEVICES` is also useful for diagnosing problems. The third common mistake is calling the API without pulling the model first. If the model is not local, an error response is returned rather than a 404, so building the habit of checking installed models with `ollama list` during initial setup is important.

```diagram
en/2026-10-18-e554af31-07
```

Diagnosis paths differ completely depending on the type of error. Slow responses and OOM have entirely different causes and remedies.

### Monitoring and Debugging

Ollama does not expose a metrics endpoint by default, but you can check the currently loaded models and memory usage with the `/api/ps` endpoint. For more detailed monitoring, set the `OLLAMA_DEBUG=1` environment variable to enable verbose logging. These logs include layer offloading decisions, KV cache state, and per-request processing times, making them effective for diagnosing performance bottlenecks.

To integrate with Prometheus, common approaches are placing a proxy in front of Ollama, or setting up a sidecar that periodically polls `/api/ps` to collect metrics. Visualizing TPS, memory utilization, and request queue length in a Grafana dashboard lets you spot anomalies quickly. You can also measure TPS directly at the application level by logging the `eval_count` (tokens generated) and `eval_duration` (processing time) fields included in each inference response.

> **Operations rule**: Ollama server logs go to standard error (stderr) by default. Monitoring in real time via `journalctl -u ollama -f` (if registered as a Linux system service) or Docker container logs lets you immediately detect unexpected model unloads or CUDA initialization failures.

### Scaling and Migration

There is a limit to how many concurrent requests a single Ollama instance can handle. By default, Ollama queues incoming requests while processing one. You can increase the number of concurrent inferences with the `OLLAMA_NUM_PARALLEL` environment variable, but this consumes VRAM proportionally. There is therefore a clear ceiling to how much you can increase throughput on a single GPU.

If you need more throughput, a realistic approach is to run multiple Ollama instances behind Nginx or HAProxy with round-robin load balancing. This setup is simple to configure with no separate orchestration, and you can also load different models on each instance and route requests by path. When production-level throughput becomes necessary, migrating to vLLM or TGI (Text Generation Inference) is worth considering. If you standardized on the OpenAI-compatible interface from the start, application code changes in that migration are minimal.

```diagram
en/2026-10-18-e554af31-08
```

Placing a load balancer in front of multiple Ollama instances lets you overcome the throughput ceiling of a single instance through horizontal scaling.

---

## Closing Thoughts

### Key Takeaways

Ollama provides the lowest barrier to entry for setting up a local LLM development environment today. The combination of three design principles—single-binary installation, model layer caching, and an OpenAI-compatible API—creates an environment where you can experiment with LLM features quickly and at no cost. Following the flow covered in this post, from model serving to Java Spring Boot integration, streaming, and load balancing, you can set up a local LLM testing infrastructure for your team in a single day.

The key is adopting the OpenAI-compatible interface as your standard from the start. When application code is not locked to a specific provider, you can switch between a local Ollama model in development and a commercial API in production with a single environment variable. Managing the system prompt and sampling parameters with a Modelfile brings model configuration under version control, treating it like code and making environments reproducible.

### Decision Criteria for Adoption

When introducing Ollama to a development environment, the first thing to check is hardware specs. On Apple Silicon Macs or environments with an NVIDIA GPU, you can expect immediately perceptible performance on models 7B or smaller. In CPU-only environments, it is better to start with a small model of 3B or smaller, verify response speed, and then decide on the right model size for your use case.

If you are considering team-wide adoption, a good goal is to integrate Ollama into your CI pipeline to automate integration testing of LLM-related features. Even the `ubuntu-latest` runner on GitHub Actions can run a 3B model via CPU inference, reducing commercial API dependency when tests require actual LLM responses. On the other hand, if you are using Ollama directly in a production service, measure your concurrent request count and TPS requirements first, clearly identify the limits of a single instance, and then design the architecture. Keeping the development/testing and production roles separate is the most effective way to use Ollama.
