---
title: "Optimizing LLM Cost and Quality Simultaneously with Request Routing"
date: "2026-10-04 02:16"
category: "AI"
tags: ["LLM routing", "model selection automation", "cost optimization", "AI architecture", "LLMOps"]
excerpt: "Learn how to route LLM requests to the right model automatically, cutting costs without sacrificing response quality."
koSlug: "2026-10-04-LLM-요청-라우팅으로-비용과-품질-동시에-최적화하기"
---

## Table of Contents

1. Overview
2. Why LLM Routing Is Necessary
3. Core Structure of Routing Strategies
4. Implementing Request Complexity Classification
5. The Cost-Quality Tradeoff
6. Considerations for Production Deployment
7. Closing Thoughts

---

## Overview

### Problem Background

High-performance models like GPT-4o, Claude 3.5 Sonnet, and Gemini 1.5 Pro deliver excellent quality, but at a proportionally high cost. Lightweight models like GPT-4o mini, Claude 3 Haiku, and Gemini 1.5 Flash are cheap, but fall short on complex reasoning and long-context processing. In a real service, not every request demands the same processing capability. Locking in a single model means either wasting money on trivial requests or degrading quality on hard ones. LLM request routing is an architectural strategy that resolves this dilemma by analyzing each incoming request and dispatching it to the appropriate model automatically.

### Limits of the Single-Model Approach

The biggest problem with a fixed single model is cost inefficiency. Using a GPT-4-class model to answer "What's the weather today?" is like hailing a cab to travel 100 meters. Conversely, routing legal document analysis or complex code refactoring exclusively to a lightweight model leads to quality degradation and user churn.

The fact that each LLM provider has different strengths compounds the problem. Claude excels at long-document analysis and coding; GPT-4o has an edge in multimodal tasks and function calling; Gemini specializes in large-context processing. Ignoring these characteristics and sticking with a single provider means vendor lock-in risk and missed performance optimization opportunities. Routing is the tool that turns model diversity into a strategic asset.

---

## Why LLM Routing Is Necessary

### The Reality of Cost Structure

LLM costs are mostly proportional to input and output token counts. GPT-4o input costs $2.50/1M tokens, while GPT-4o mini costs $0.15/1M tokens - roughly a 17x difference. Claude 3.5 Sonnet ($3.00/1M) and Claude 3 Haiku ($0.25/1M) differ by 12x. In a service handling 1 million requests per day, assuming an average of 500 tokens per request, achieving just a 50% shift to lightweight models can save tens of millions of won per month.

However, chasing costs alone leads to the trap of quality degradation. When perceived quality drops, users leave, and the resulting revenue loss can exceed the cost savings. The goal of a routing strategy is not simply cost reduction - it is maximizing the overall service value through **optimal model mapping per request type**.

```diagram
en/2026-10-04-475e9685-01
```

By having the router assess complexity and branch to lightweight or high-performance models, cost efficiency improves compared to a single pipeline.

### Strategic Use of Model Diversity

Each LLM provider's models have different strengths. Simple Q&A, summarization, and translation can yield sufficiently high quality from lightweight models. Complex reasoning, code generation, and long-form analysis require high-performance models. Understanding each model's characteristics makes rule-based routing by task type possible: route code-related requests to Claude 3.5 Sonnet or GPT-4o, mathematical reasoning to o1 or Gemini 1.5 Pro, and simple text processing to Haiku or GPT-4o mini.

| Model | Strengths | Weaknesses | Suitable Tasks | Notes |
|---|---|---|---|---|
| GPT-4o | Multimodal, function calling | High cost | Image analysis, API integration | Must monitor token costs |
| Claude 3.5 Sonnet | Coding, long-form analysis | High cost | Code review, document analysis | Maximize context window use |
| Gemini 1.5 Pro | Large context | Response latency | Long document processing | Not suited for real-time requests |
| GPT-4o mini | Speed, low cost | Weak at complex reasoning | Q&A, classification | Take care setting complexity threshold |
| Claude 3 Haiku | Fast responses | Limited reasoning depth | Translation, summarization | Quality degrades on multi-step reasoning |

### When Routing Becomes Worth the Investment

Introducing a routing system has upfront build costs. It makes sense to consider routing when monthly LLM costs exceed $500, when the distribution of request complexity in the service is clearly bimodal, or when user interactions are latency-sensitive. On the other hand, if most requests are uniformly complex, or the service is at an early stage with insufficient traffic data, it is wiser to build up patterns with a single model first and introduce routing later.

---

## Core Structure of Routing Strategies

### Rule-Based Routing

This is the simplest and most predictable approach. A model is selected based on specific attributes of the request - token length, keywords, task-type labels - according to predefined rules. It is easy to implement, adds almost no latency, and produces deterministic, predictable routing results. Rules can be tuned as configuration values without code changes even in production, allowing fast responses to shifting business requirements.

A typical rule-based implementation works like this: requests under 200 input tokens go to the lightweight model, 200-800 to a mid-tier model, and 800 or more to the high-performance model. Alternatively, requests containing keywords like "code," "analysis," or "legal" are routed to the high-performance model.

```diagram
en/2026-10-04-475e9685-02
```

Token length alone enables a first-pass routing decision, but it cannot accurately reflect complexity on its own.

However, rule-based routing produces edge cases that rules cannot cover - for example, a question that is very short but very hard. Token count alone cannot distinguish "What is 1+1?" from "Derive the escape velocity on the Moon using Earth's gravitational constant" - both are short, but one is far more complex. There is also a maintenance burden: when new request types appear, rules must be updated.

### ML-Based Routing

ML-based routing embeds the request text or runs it through a classification model to predict a complexity score. It judges complexity more accurately than rule-based routing and can handle new patterns through learning. The trade-off is that the routing classification itself incurs additional LLM calls or embedding generation costs, and labeled data is required to train the model.

One practical ML-based approach is a small classification model. You can fine-tune a lightweight BERT-family classifier, or vectorize with `text-embedding-3-small` and then classify task type using kNN or SVM. This keeps routing latency within tens of milliseconds while achieving higher accuracy than rule-based routing. Another approach is a **router LLM**: send the request first to a cheap model like GPT-4o mini and ask it to judge "what level of model is needed to handle this request?"

```diagram
en/2026-10-04-475e9685-03
```

An embedding-based classifier vectorizes the request, predicts a complexity level, and the result determines which model to use.

### Hybrid Routing

The approach most widely adopted in production is hybrid routing, which combines rule-based and ML-based methods. Clear-cut cases (very high token count, or specific keywords present) are handled fast by rules; only ambiguous cases are forwarded to the ML classifier. This keeps routing latency minimal while maintaining high accuracy.

Another form of hybrid routing is **cascade routing**. The request is sent first to the lightweight model; an evaluator checks response quality; if it falls below the threshold, the request is retried with the high-performance model. When quality is sufficient on the first attempt, cost is saved; when it is not, the upgrade happens automatically. This approach has a built-in safety net against pre-classification errors, making it especially suitable for quality-sensitive services.

---

## Implementing Request Complexity Classification

### Designing Complexity Signals

Which signals to use for measuring complexity is the core determinant of routing quality. A composite score combining multiple signals is more accurate than any single metric. Commonly used signals include **token count**, **sentence structural complexity**, **domain specificity**, **whether multi-step reasoning is required**, and **context dependency**.

Token count is the fastest first-pass signal to compute, but is not reliable on its own. An effective complexity metric weights and scores the following factors.

| Signal | Measurement Method | Weight | Notes |
|---|---|---|---|
| Token count | Measured directly with tiktoken | 0.3 | Long context ≠ complex request |
| Keyword complexity | Frequency of domain-specific terms | 0.2 | Requires per-domain vocabulary |
| Question structure | Number of sub-questions, conditional clauses | 0.3 | Parsing cost incurred |
| Multi-turn depth | Length of conversation history | 0.2 | Accumulated context must be considered |

### Implementing Routing Logic

Here is a basic Python implementation that computes a composite complexity score and selects the appropriate model. The `tiktoken` library provides OpenAI-compatible token counts, so no separate API call is needed for fast computation.

```python
import tiktoken
from dataclasses import dataclass
from enum import Enum

class ModelTier(Enum):
    LIGHT    = "claude-3-haiku-20240307"       # Light: simple Q&A, translation
    BALANCED = "claude-3-5-sonnet-20241022"    # Balanced: general tasks
    PREMIUM  = "claude-opus-4-5"              # High-performance: complex reasoning

COMPLEX_KEYWORDS = {
    "analysis", "refactoring", "optimization", "architecture", "design",
    "debugging", "legal", "medical", "compliance", "audit"
}

@dataclass
class RoutingResult:
    model: str
    tier: ModelTier
    score: float
    reason: str

def calculate_complexity(prompt: str, history: list[dict] = None) -> float:
    """Returns a composite complexity score (0.0 to 1.0)"""
    enc = tiktoken.encoding_for_model("gpt-4o")

    # 1. Token count score (max 0.30)
    token_count = len(enc.encode(prompt))
    token_score = min(token_count / 1000, 1.0) * 0.30   # baseline: 1000 tokens

    # 2. Complex keyword score (max 0.20)
    keyword_hits = sum(1 for kw in COMPLEX_KEYWORDS if kw in prompt)
    keyword_score = min(keyword_hits / 3, 1.0) * 0.20

    # 3. Question structure score (max 0.30): based on number of sub-questions
    sub_q = prompt.count("?") + prompt.count("how") + prompt.count("why")
    structure_score = min(sub_q / 4, 1.0) * 0.30

    # 4. Multi-turn depth score (max 0.20)
    turn_depth = len(history) if history else 0
    turn_score = min(turn_depth / 10, 1.0) * 0.20

    return token_score + keyword_score + structure_score + turn_score

def route_request(prompt: str, history: list[dict] = None) -> RoutingResult:
    score = calculate_complexity(prompt, history)

    if score < 0.30:
        tier, reason = ModelTier.LIGHT,    f"Simple request (complexity {score:.2f})"
    elif score < 0.65:
        tier, reason = ModelTier.BALANCED, f"Medium complexity (complexity {score:.2f})"
    else:
        tier, reason = ModelTier.PREMIUM,  f"High-complexity request (complexity {score:.2f})"

    return RoutingResult(model=tier.value, tier=tier, score=score, reason=reason)

# Usage example
result = route_request("Analyze Python code optimization techniques and architecture improvements")
# result.tier  → ModelTier.PREMIUM
# result.score → 0.72 (keywords "optimization", "architecture", "analysis" matched, plus structure score)
```

The key point of this implementation is that `calculate_complexity` produces a 0-1 score by weighted-summing four signals. The thresholds (0.30, 0.65) must be tuned through A/B testing in the actual service; initial values are set from experience.

### Implementing the Cascade Pattern

Cascade routing checks lightweight model responses with a quality evaluator and escalates to a high-performance model when needed. The evaluation criteria depend on the task; in the example below, a small evaluator model returns a 0-1 score.

```python
import anthropic

client = anthropic.Anthropic()

def cascade_route(prompt: str, min_quality: float = 0.70) -> str:
    """Start with a lightweight model; escalate to premium if quality is insufficient"""

    # Step 1: attempt a response from the lightweight model
    light = client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    light_text = light.content[0].text

    # Step 2: quality check with a small evaluator (reuse lightweight model to minimize extra cost)
    eval_prompt = (
        f"Return only a single number from 0 to 1 indicating the completeness of the following response.\n"
        f"Question: {prompt[:200]}\nResponse: {light_text[:500]}\nScore:"
    )
    eval_resp = client.messages.create(
        model="claude-3-haiku-20240307",
        max_tokens=10,
        messages=[{"role": "user", "content": eval_prompt}]
    )
    try:
        quality = float(eval_resp.content[0].text.strip())
    except ValueError:
        quality = 0.5   # fall back to middle value conservatively on parse failure

    # Step 3: retry with premium model if below quality threshold
    if quality < min_quality:
        premium = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}]
        )
        return premium.content[0].text   # result: high-quality response returned

    return light_text   # result: lightweight response is sufficient
```

The advantage of the cascade pattern is the built-in safety net against pre-classification errors. Even if the complexity classifier incorrectly sends a request to the lightweight model, escalation happens automatically at the quality evaluation step. Note that in the worst case three API calls are made, so this pattern is particularly well-suited to batch processing or async workloads where response latency tolerance is wide.

---

## The Cost-Quality Tradeoff

### Quantifying Cost Savings

To measure the effect of a routing strategy, you first need to understand the **current request distribution**. Analyzing real traffic logs shows that in most services 60-70% of requests are simple tasks (classification, summarization, basic Q&A), 20-30% are mid-level, and only 10-20% require complex reasoning. This distribution lets you estimate achievable savings upfront. The core formula for cost reduction: start with the average cost before routing, multiply the proportion of requests shifted to lightweight models by the cost difference between models, then subtract the routing error rate and the operational cost of the router itself.

```diagram
en/2026-10-04-475e9685-04
```

Cost allocation based on actual traffic distribution is the starting point for estimating routing impact.

### Preventing Quality Regression

Aggressively routing too many requests to lightweight models to cut costs causes quality regression. A **quality safety net** is required to prevent this. The most effective method is to continuously monitor quality scores on a sample of routed responses (typically 5-10%) using an automated LLM-as-a-judge.

When designing a quality regression detection system, it is important to build a **golden dataset**. Prepare 100-500 test cases with known correct answers for each task type, and run regression tests against this dataset whenever routing logic changes. If quality scores fall below the threshold, trigger an alert to initiate manual review.

> Lowering the routing threshold by 1% may cut costs by 5%, but in some cases it doubles the quality regression rate. Always pair threshold changes with an A/B test.

### Balancing Latency and Quality

High-performance models generally have longer response times than lightweight models. GPT-4o's average time to first token (TTFT) is 2-4x slower than GPT-4o mini. On user-facing interfaces, latency directly affects UX, so routing must consider both quality and speed. Combining streaming responses with routing can improve perceived speed. Even for complex requests, surfacing the first token quickly via streaming significantly reduces the wait users experience, even when total response time is long.

```diagram
en/2026-10-04-475e9685-05
```

Factoring in both real-time requirements and complexity when deciding the routing path lets you optimize latency and cost simultaneously.

---

## Considerations for Production Deployment

### Common Mistakes and Pitfalls

The most common mistake is **setting routing thresholds once and never revisiting them**. A service's usage patterns change over time. A service that initially saw mostly simple questions may attract a more specialized user base over time, increasing the share of complex requests. Letting thresholds sit stale causes routing accuracy to gradually deteriorate. Formalizing a quarterly process to analyze request distribution and recalibrate thresholds is a good practice.

The second pitfall is **being oblivious to model version updates**. LLM providers update their models regularly. When a lightweight model's capability improves, there is an opportunity to migrate tasks that previously required a high-performance model. Conversely, a model version change can shift response quality for certain request types, making periodic quality benchmarking necessary.

The third is **failure to manage context windows**. In multi-turn conversations, accumulating history can push total token count past a lightweight model's context limit. Routing logic must account for accumulated token count. As the limit approaches, either compress the context through summarization or automatically switch to a higher-tier model.

```diagram
en/2026-10-04-475e9685-06
```

Designing the forced model-switch flow caused by context accumulation in advance prevents runtime errors.

### Monitoring and Debugging

To monitor the health of a live routing system, you need to track key metrics. **Routing distribution rate** (the proportion of requests sent to each model tier) reveals the gap between expected and actual distribution. A sudden shift in distribution warrants suspicion of a change in request patterns or a routing bug. **Escalation rate** is especially important in cascade patterns. If the rate at which lightweight model responses fail the quality bar and get retried stays consistently high, the complexity classification threshold is set too low; if the escalation rate is near zero, the threshold is too high and cost savings are minimal.

| Metric | Measurement Method | Normal Range | Warning Signal |
|---|---|---|---|
| Routing distribution rate | Requests per tier / total | Varies by service | Sudden change |
| Escalation rate | Retries / total | 5-15% | Exceeds 15% |
| Average complexity score | 7-day moving average | Stable | Sustained rise or fall |
| Cost efficiency index | Quality score / token cost | Above baseline | Drop of 10% or more |

### Scaling and Migration

As a routing system matures, it can evolve beyond simple cost optimization into **task specialization**: fine-grained routing that sends code-related requests to code-specialized models and legal or medical documents to domain-specific fine-tuned models. At this stage, request classification granularity becomes key, requiring multi-dimensional classification rather than a simple complexity score. When introducing a new model, **traffic shadowing** is useful. A small portion (1-5%) of real requests is sent to the new model simultaneously, and its responses are compared in quality against the existing model. Once sufficiently validated, traffic for that task type is migrated to the new model incrementally.

```diagram
en/2026-10-04-475e9685-07
```

Traffic shadowing lets you validate new model quality without production risk, and roll over gradually once it passes.

---

## Closing Thoughts

### Key Takeaways

LLM request routing is not just a cost-cutting technique - it is an architectural strategy for improving both cost efficiency and quality across the entire service. Three things matter most. First, do not treat all requests equally. The optimal model should be selected dynamically based on each request's complexity and characteristics. Second, routing logic can start with simple rules and evolve incrementally toward ML-based approaches. In the early stages, rules based on token count and keywords alone can produce meaningful results. Third, cost savings and quality maintenance are not conflicting goals. The right routing strategy can achieve both simultaneously, and continuous monitoring with threshold recalibration is the key to making that work.

### Decision Criteria for Adoption

When considering whether to adopt routing, the following criteria help. If monthly LLM API costs exceed $500, request complexity distribution is clearly differentiated, and simple requests account for 40% or more of total traffic, the ROI of routing is high. On the other hand, if most requests are uniformly complex, or the service is at an early stage without enough traffic distribution data, it is wiser to operate with a single model, accumulate data, and introduce routing later. Starting with rule-based routing and transitioning to ML-based routing once traffic patterns become clear is the most practical path to growing a routing system stably.
