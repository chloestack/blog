---
title: "Reducing LLM API Costs with Prompt Caching — Anthropic vs. OpenAI Caching Strategies Compared"
date: "2026-09-29 09:34"
category: "AI"
tags: ["Prompt Caching", "LLM Cost Optimization", "Anthropic", "OpenAI"]
excerpt: "A practical comparison of Anthropic and OpenAI prompt caching mechanisms, covering cost structures, implementation patterns, and when to use each approach."
koSlug: "2026-09-29-Prompt-Caching으로-LLM-API-비용-줄이기-—-Anthropic·OpenAI-캐싱-전략-비교"
---

Costs climb faster than you expect. In RAG (Retrieval-Augmented Generation) pipelines or agent workflows with complex system prompts, you end up feeding thousands of tokens of context to the model on every single request. Prompt Caching is a technique that dramatically cuts that repeated cost, and both Anthropic and OpenAI provide their own caching mechanisms. The two platforms take structurally quite different approaches, and the actual savings you see depend heavily on which approach you choose and in what context.

LLM API costs are determined by the sum of input tokens and output tokens. Output tokens vary per request, but fixed portions of the input — like the system prompt or document context — repeat identically every time. If you have a 2,000-token system prompt and call the API 1,000 times a day, the system prompt alone burns through 2 million tokens a day. With Prompt Caching applied, that repeated cost can be cut by up to 90% (Anthropic) or 50% (OpenAI).

```diagram
en/2026-09-29-67f67d8d-01
```

A fixed system prompt and document context are the main drivers of repeated cost, and they are the primary targets for caching.

### The limits of the old approach

Before prompt caching existed, there were only two ways to cut costs. First, force the system prompt shorter and sacrifice quality. Second, use a response cache that stores the reply to a completely identical input. A response cache is an exact-match scheme — useless the moment a single character in the input changes — so it provides almost no benefit in real-world services where user messages vary.

Prompt Caching solves this at the model level. Even if the full input isn't identical, as long as the leading prefix matches, you avoid the re-processing cost. In a request composed of a 2,000-token system prompt plus a 200-token user message, if the 2,000-token system prompt is already in cache, only the user message actually needs to be processed. The user message changes every time, but the prefix at the front stays the same, so the cache is reused. That is the fundamental difference from a response cache.

---

## How Prompt Caching Works

### Prefill and the KV Cache

LLM inference breaks into two broad phases. The first is the **prefill** phase: the entire input prompt is processed to build the KV (Key-Value) cache needed by the attention mechanism. The second is the **decoding** phase: output tokens are generated one at a time using that KV cache. The prefill phase accounts for the majority of total processing cost and grows almost linearly with the number of input tokens.

Prompt Caching works by storing the already-computed KV cache from the prefill phase and reusing it when the same prefix appears again. When a new request arrives and the prefix exists in cache, the attention computation for that portion is skipped entirely and processing jumps straight to the remainder. This doesn't just cut costs — it also reduces Time To First Token (TTFT). The latency improvement is especially pronounced in long-document processing scenarios where context runs into tens of thousands of tokens.

```diagram
en/2026-09-29-67f67d8d-02
```

When a cache hit occurs, the prefill is skipped and decoding begins immediately, reducing both compute cost and response latency at the same time.

### Scenarios where caching is effective

The scenarios where Prompt Caching delivers real value are fairly clear. The ideal case is a pattern where a long system prompt is fixed and only the user message changes per request. For example, in a legal document review service where a 2,000-token system prompt like "You are an expert contract analyst. Follow these guidelines…" is applied identically for every user, that portion is an ideal cache target. In RAG pipelines, caching is effective when the retrieved document set is reused multiple times for the same query.

| Scenario | Cacheable fraction | Expected savings |
|---|---|---|
| Fixed system prompt + varying user message | 70–90% | 60–85% |
| RAG document context reuse | 50–80% | 40–70% |
| Fixed few-shot examples | 80–95% | 70–90% |
| Accumulating multi-turn conversation history | 40–60% | 30–55% |
| Fully dynamic prompts | 0–10% | Under 5% |

### Cache keys and prefix matching

Prompt Caching uses **prefix matching**. If the beginning of a prompt is identical to a previous request, the cache is reused. The cache key is determined by the model version, generation parameters (temperature, etc.), and the content of the prompt's prefix. This yields a core design principle: fixed content must always go at the front of the prompt, and dynamic content at the back. If you put something like "Today's date is September 29, 2025. You are a legal expert…" with the date at the very beginning, the entire prefix becomes a cache miss every time the date changes.

Also, if generation parameters like temperature or top_p differ, the cache key differs too — so if you want caching to work, keep those parameters fixed consistently. Both platforms require a prefix of at least 1,024 tokens before caching activates. Caching does not work for shorter prompts, so other methods need to be combined for small-prompt optimization.

---

## Anthropic Claude's Caching Strategy

### Explicit cache control and cost structure

Anthropic's Prompt Caching takes an approach where **developers explicitly specify where to cache**. You add a `cache_control` parameter to each content block to directly control up to which point content is cached. The biggest advantage of this approach is predictability. Because developers know exactly which parts are being cached, cache hit rates can be deliberately engineered from the design stage. It is currently supported on Claude 3.5 Sonnet, Claude 3.5 Haiku, Claude 3 Opus, and Claude 3 Haiku, and at least 1,024 tokens are required for the cache to activate.

The cost structure is somewhat unusual. Creating a cache for the first time is billed at **25% more** than the standard input token price. But on a cache hit, you are billed at only **10%** of the standard input token price. Once the same prefix has been requested 10 or more times, you cross the break-even point and cumulative costs start going down. The cache TTL defaults to 5 minutes and can be extended to 1 hour. This works best for services with steady traffic; conversely, in low-traffic environments or when requests are spaced far apart, you can end up paying the cache creation cost (+25%) repeatedly without ever getting a hit.

```diagram
en/2026-09-29-67f67d8d-03
```

Costs spike briefly when a cache is created, but the cumulative savings grow quickly as hits accumulate within the TTL window.

### Multi-layer cache point placement

In Anthropic caching you can activate up to 4 cache points simultaneously per request. Used strategically, this lets you design a layered cache structure based on the nature of different parts of the context. For example, place the first cache point at the end of the full system prompt, the second after common few-shot examples, and the third after session-specific fixed document context. This way, depending on the nature of the request, one or more cache points will hit, reducing costs in stages.

Cache points work cumulatively — a cache point caches all tokens up to that position. When a later cache point hits, all tokens before it are also reused from cache. Understanding this characteristic is essential to placing cache points without waste. If content at the front is completely fixed, there is no need to split it with multiple intermediate points; just place one point at each boundary where content might change.

Here is an implementation that designates the system prompt and RAG document context as separate cache points.

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[
        {
            "type": "text",
            # Fixed system role definition — 3000+ tokens
            "text": "You are an expert in legal document analysis. " + LONG_LEGAL_CONTEXT,
            "cache_control": {"type": "ephemeral"}  # First cache point
        }
    ],
    messages=[
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": RETRIEVED_DOCUMENTS,  # Retrieved documents, 2000+ tokens
                    "cache_control": {"type": "ephemeral"}  # Second cache point
                },
                {
                    "type": "text",
                    "text": user_question  # Dynamic user question — not a cache target
                }
            ]
        }
    ]
)

usage = response.usage
# First request:  cache_creation_input_tokens=5120, cache_read_input_tokens=0
# Second request: cache_creation_input_tokens=0,    cache_read_input_tokens=5000
print(f"Cache creation tokens: {usage.cache_creation_input_tokens}")
print(f"Cache hit tokens:      {usage.cache_read_input_tokens}")
print(f"Regular input tokens:  {usage.input_tokens}")
```

If `cache_read_input_tokens` is 0 it's a cache miss; if it's greater than 0, a 90% discount has been applied to that many tokens. Logging both values is the starting point for cost monitoring.

### Applying caching in multi-turn conversations

To use Anthropic caching effectively in multi-turn conversations, you need to adjust how history is managed. As a conversation grows longer, the number of history tokens increases, and that accumulated history is a good cache target. The generally recommended pattern is to attach `cache_control` to the last block of the assistant message just before the current turn. This way the history accumulates as the conversation progresses, and on the next request the entire accumulated history is reused from cache.

One thing to watch out for: `cache_control` should only be attached to the most recent message. Content that precedes an already-cached point from a previous turn is automatically reused, so specifying it again can trigger unexpected cache recreation costs. Also, content that comes after the position of `cache_control` is not cached, so dynamic user messages must always be placed after the cache point.

---

## OpenAI GPT's Caching Strategy

### How automatic caching works

OpenAI's Prompt Caching takes a philosophically different approach from Anthropic's. There is no need to specify `cache_control` separately — caching is applied **fully automatically**. OpenAI's infrastructure analyzes the prefix of a request, decides whether it can be cached, and on a hit automatically bills the discounted rate. It is supported on GPT-4o, GPT-4o mini, o1, o1-mini, and the o3 family, and requires a prefix of at least 1,024 tokens.

The cost structure bills only 50% of the input token cost on a cache hit. That is higher than Anthropic's 10%, but there is no separate cost to create the cache. For services with irregular traffic or where cache hit rates are hard to predict, OpenAI's automatic approach guarantees a consistent level of savings without any financial risk. Because the discount is applied automatically just by adjusting the prompt structure — without changing a single line of existing code — the barrier to adopting caching is very low.

```diagram
en/2026-09-29-67f67d8d-04
```

OpenAI caching operates transparently at the infrastructure level, so you get the benefit immediately without any code changes.

### Structural characteristics of the cache

OpenAI's caching splits and stores the prefix in 128-token chunks. This means prefix matching is evaluated very strictly. If the front of the prompt contains dynamic content — timestamps, usernames, session IDs, and so on — every request will be a cache miss. OpenAI's cache is shared across requests within the same Organization. If multiple service instances within a team use the same system prompt, the whole organization benefits from the cache after the first request.

The cache TTL is not officially published, but in practice it is generally reported to be around 5–10 minutes during inactivity. To monitor cache hit rates in a production environment, check `usage.prompt_tokens_details.cached_tokens` in the response. If that value stays consistently high, it's a signal that the prompt structure is designed well for caching.

Here is how to check for a cache hit in OpenAI.

```python
from openai import OpenAI

client = OpenAI()

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {
            "role": "system",
            "content": LONG_SYSTEM_PROMPT  # Fixed system prompt, 1024+ tokens
        },
        {
            "role": "user",
            "content": user_message
        }
    ]
)

usage = response.usage
prompt_details = usage.prompt_tokens_details

# First request:  cached_tokens = 0 (warm-up)
# Second request: cached_tokens = 1024 (prefix cache hit)
print(f"Total input tokens: {usage.prompt_tokens}")                                        # Result: 1200
print(f"Cache hit tokens:   {prompt_details.cached_tokens}")                               # Result: 1024
print(f"Non-cached tokens:  {usage.prompt_tokens - prompt_details.cached_tokens}")        # Result: 176
```

If `cached_tokens` is 80% or more of total `prompt_tokens`, caching is working effectively.

### Tool and multimodal caching support

One differentiator of OpenAI caching is that **caching also applies to image tokens and tool definitions**. In agent workflows it is common to include the same list of tools in every request, and when tool definitions are cached, costs for that portion drop too. In an agent system that includes 100 tool definitions, the tool list alone can consume thousands of tokens. OpenAI caches this automatically, making it a real cost saving for teams running complex agent systems.

Anthropic supports tool caching as well, but you have to explicitly add `cache_control` to the last item in the tools array. On the multimodal side, OpenAI also applies automatic caching when the same image is sent repeatedly, producing meaningful savings in image-processing batch pipelines.

---

## Comparing the Two Platforms and Choosing Between Them

### The philosophical difference in cost structure

The caching cost structures of the two platforms reflect fundamentally different design philosophies. Anthropic follows a "the more you use, the more you save" model. Cache creation costs more, but the hit cost is extremely low — so ROI rises quickly as the same prefix repeats. For a service making thousands of requests per day against the same system prompt, Anthropic's 90% discount is far more economical over time. OpenAI is closer to a "safe floor, no downside" model. There is no cache creation cost and only a 50% discount on hits, so no unexpected overage occurs even in low-traffic or uncertain-hit-rate situations.

```diagram
en/2026-09-29-67f67d8d-05
```

Anthropic delivers larger savings in high-traffic environments; OpenAI delivers predictable, fixed savings.

| Item | Anthropic | OpenAI |
|---|---|---|
| Cache control method | Explicit (`cache_control`) | Fully automatic |
| Cache creation cost | +25% | None |
| Cache hit cost | 10% of input cost | 50% of input cost |
| Minimum cache length | 1,024 tokens | 1,024 tokens |
| Cache TTL | 5 min (up to 1 hour) | Undisclosed (~5–10 min) |
| Max cache points | 4 | Single prefix |
| Multimodal caching | Text-focused | Text + images + tools |
| Cache sharing scope | Within account | Within Organization |
| Suitable traffic type | High-volume, regular | Low-volume, irregular |

### Architecture selection criteria

Before choosing a platform, understand your service's traffic pattern and cost structure first. If traffic is high and the same system prompt is reused consistently, Anthropic caching is far more economical long-term. Conversely, if the request pattern is irregular, or the pipeline is primarily testing or batch processing, OpenAI's automatic caching provides a reliable 50% reduction with no management overhead.

```diagram
en/2026-09-29-67f67d8d-06
```

Using traffic regularity and daily call volume as the criteria makes the direction of cost optimization clear.

### Considerations when running both platforms in parallel

In an architecture that mixes multiple models depending on the task rather than committing to one, caching characteristics for each platform need to be managed separately. If your architecture uses GPT-4o mini for quick classification and Claude Sonnet for complex reasoning, you need to verify separately that caching is working correctly for the prompts sent to each model. In that situation, having an LLM gateway layer that centrally collects and monitors `cached_tokens` and `cache_read_input_tokens` is operationally advantageous. Since the field names and calculation methods for a cache hit differ per platform, it is worth translating them into a unified metric at the abstraction layer.

---

## Considerations When Applying to Production

### Common mistakes and pitfalls

The most frequent mistake when first introducing caching is placing dynamic content at the front of the prompt. If timestamps, user IDs, session IDs, the current date, or random UUIDs are included at the beginning of the system prompt, every request will be a cache miss. Those elements should be placed at the very end of the prompt, just before the user message.

> **Core principle**: Prompts must be ordered "fixed → semi-fixed → dynamic" to maximize cache hit rate. If dynamic content comes first, the entire caching strategy is invalidated.

The second pitfall is ignoring Anthropic's cache TTL. The default TTL is 5 minutes, so if requests are spaced more than 5 minutes apart, the cache expires. If this repeats in a low-traffic service, you keep incurring the cache creation cost (+25%) and the cache expires without ever being hit — the opposite of what you want. In that case, either extend the TTL to 1 hour, or consider switching to OpenAI's automatic caching instead of Anthropic's. Third, Anthropic's `cache_control` supports only one type: `type: "ephemeral"`. Don't expect a permanent cache — all caches expire based on TTL.

```diagram
en/2026-09-29-67f67d8d-07
```

Designing prompts in fixed → semi-fixed → dynamic order and placing a cache point at each boundary naturally drives hit rates up.

### Monitoring and cost tracking

To measure the effect of caching quantitatively after you introduce it, you need to continuously track cache hit rates. At a minimum, log `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens` from Anthropic API responses, and `usage.prompt_tokens_details.cached_tokens` from OpenAI, in your logging system. If the hit rate stays consistently low, revisit the prompt structure. In particular, check whether **cache key pollution** is occurring — this happens when session-specific content is mixed into the front of the prompt. On the surface it looks like caching is active, but in practice no hits are occurring at all.

| Metric | How to measure | Target | Warning threshold |
|---|---|---|---|
| Cache hit rate | `cached_tokens / total_input_tokens` | 70%+ | Under 30% |
| Cache creation ratio | `creation_tokens / total_input_tokens` | 5% or less | Over 20% |
| Average cost savings rate | `(baseline cost - actual cost) / baseline cost` | 50%+ | Under 10% |
| TTL expiry rate | Fraction that expired without a hit after creation | 10% or less | Over 40% |

### Scaling and migration strategy

As a service grows and LLM call volume increases, the caching strategy needs to evolve with it. A single cache point is sufficient at the start, but as usage patterns diversify, a multi-layer cache structure becomes necessary. If a service has separate regular-user and premium-user flows, caching separate system prompts for each is effective. For premium users, even if longer context and more few-shot examples are included, caching those portions significantly reduces the cost burden.

When migrating from Anthropic to OpenAI or vice versa, changes to the prompt structure are required. Simply removing Anthropic's `cache_control` annotations transitions to OpenAI's automatic caching, but you must verify that the fixed prefix in the prompt is long enough and placed at the front. Immediately after migration, there will be a period where the cache hasn't warmed up yet and hit rates are temporarily low.

```diagram
en/2026-09-29-67f67d8d-08
```

Run the migration as a shadow deployment, verify hit rates first, then complete the cutover.

---

## Conclusion

### Key summary

Prompt Caching is the most direct and effective way to reduce LLM API costs. Anthropic lets you explicitly specify cache positions with `cache_control` and delivers a powerful 90% discount on cache hits. OpenAI applies caching automatically for a 50% discount with no separate configuration needed. Both approaches require a fixed prefix of at least 1,024 tokens, and the structural principle of ordering prompts "fixed → semi-fixed → dynamic" is the key to success. Cache hit rates must be monitored continuously, and if hit rates are low, the first step is checking whether dynamic elements are mixed into the front of the prompt.

```diagram
en/2026-09-29-67f67d8d-09
```

The choice of caching strategy can be made based on three criteria: call volume, prefix length, and expected hit rate.

### Criteria for deciding to adopt caching

If any of the following conditions apply, introducing Prompt Caching pays off immediately. Your system prompt is 1,000 tokens or more and you are sending the same prompt more than 50 times a day; you have a RAG pipeline where the same document chunks are included repeatedly across multiple requests; or you are keeping long few-shot examples fixed to improve quality.

Conversely, if most of the prompt changes on every request, or if requests are infrequent batch jobs, the benefits of caching are limited. Anthropic caching in particular incurs a cache creation cost, so if fewer than 10 hits within the TTL window are expected, the practical approach is to apply OpenAI's automatic caching first, measure the hit rate, and then evaluate whether switching to Anthropic makes sense. Whichever platform you choose, designing for caching from the prompt structure stage is far more effective than optimizing after the fact.
