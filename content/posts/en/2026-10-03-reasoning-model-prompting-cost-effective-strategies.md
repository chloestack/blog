---
title: "Reasoning Model Prompting Strategies — Using o3 and Claude Opus Cost-Effectively"
date: "2026-10-03 02:09"
category: "AI"
tags: ["reasoning model", "Extended Thinking", "LLM cost optimization", "Prompt Engineering", "multi-agent"]
excerpt: "Learn how to control thinking token costs and get the best performance from reasoning models like o3 and Claude Opus with targeted prompting strategies."
koSlug: "2026-10-03-추론-모델-프롬프팅-전략-—-o3·Claude-Opus를-비용-효율적으로-활용하는-법"
---

## Table of Contents

1. Overview
2. How Reasoning Models Work Internally
3. Cost Structure — How Thinking Tokens Are Billed
4. Cost-Effective Prompting Strategies
5. Choosing a Model by Task Type
6. Considerations for Production
7. Closing

---

## Overview

### Background: Why Reasoning Models Exist

Reasoning models entered the mainstream LLM ecosystem in earnest starting with OpenAI's o1 in late 2024. Models like Claude Opus, o3, and o3-mini go through an internal step-by-step reasoning process before generating a response, and they show significantly higher accuracy than conventional models on tasks that are hard to solve with pattern matching alone — mathematical proofs, code debugging, and multi-step logical inference. This post covers how reasoning models work internally, and the prompting strategies that let you extract maximum performance while keeping thinking token costs under control.

```diagram
en/2026-10-03-19f27e99-01
```

Reasoning models are not a universal tool for every task. Accurately classifying the task type is what lets you maximize performance per dollar.

### The Limitation of the Old Approach: The Cost of Hand-Crafted CoT

Before reasoning models, developers had to design **Chain-of-Thought (CoT) prompts** by hand. The approach involved inserting instructions like "Let's think step by step" or including detailed worked solutions in few-shot examples. This came with several problems. It consumed a significant amount of time on prompt engineering. There was no guarantee the same CoT pattern would hold when a model version changed or the domain shifted. And embedding worked solutions in few-shot examples caused input token counts to spike, driving up cost. Reasoning models absorb that burden into the model itself, fundamentally shifting the design so developers focus on *what to achieve* rather than *how to think*. The center of gravity in prompt engineering moved from instructing the process to specifying the outcome.

| Approach | Developer burden | Consistency | Cost | Performance on complex problems |
|---|---|---|---|---|
| Standard model + hand-crafted CoT | High (design every time) | Low | Low | Moderate |
| Standard model + few-shot CoT | High (collect examples) | Medium | Medium | Moderate |
| Reasoning model (default) | Low | High | High | Excellent |
| Reasoning model + cost control | Low–medium | High | Medium | Excellent |

---

## How Reasoning Models Work Internally

### The Flow of Thinking Tokens

The fundamental difference between reasoning models and ordinary models is that reasoning models consume **thinking tokens** before generating a response. During this internal reasoning phase, the model examines the problem from multiple angles, forms a tentative conclusion, and then searches for counterexamples to verify it. This self-verification loop is the core mechanism behind improved accuracy on complex problems. Importantly, this process is not linear. When the model discovers a faulty reasoning path, it backtracks and explores a different direction. Unlike ordinary models, which generate tokens "left to right," reasoning models construct an internal search tree — much like a person revising a draft multiple times.

```diagram
en/2026-10-03-19f27e99-02
```

The thinking phase is not exposed externally, but the quality improvement comes from the model repeatedly self-verifying before responding.

The volume of thinking tokens is determined dynamically by problem complexity. For "What is 2+2?" almost none are used, but for optimization problems close to NP-hard, or system designs with many interacting constraints, tens of thousands of thinking tokens can be consumed. In Anthropic's Claude, the `budget_tokens` parameter lets you directly cap thinking tokens, giving you explicit control over the cost-quality trade-off.

### Claude's Extended Thinking

Anthropic's **Extended Thinking**, introduced in Claude, is one of the few interfaces that lets you control the reasoning process at the API level. You can receive `thinking` blocks in the response stream, which gives you partial visibility into the path the model took to reach its conclusion. This transparency is useful for debugging and quality monitoring. For example, when a model produces a wrong answer, inspecting the thinking block gives you a clue about where the reasoning went off track. That said, the thinking block does not mean complete transparency — only part of the internal computation is expressed in natural language, and it would be a stretch to claim the actual reasoning path is 100% reflected. Even so, the ability to do root cause analysis in production is a clear advantage over competing models that are entirely black-box.

> **Key rule**: Adding a CoT instruction like "think step by step" to a Claude prompt with Extended Thinking enabled backfires. The model is already thinking internally; imposing an external structure creates duplication and wastes thinking tokens.

### Comparing o3 and Claude's Thinking Mechanisms

OpenAI's o3 and Anthropic's Claude Opus both belong to the broad category of reasoning models, but they differ in internal mechanism and API design philosophy. o3 treats the thinking process as a complete black box and does not expose it to developers. You can see how many tokens were consumed for reasoning via `completion_tokens_details.reasoning_tokens`, but not the content. Control is limited to three levels of `reasoning_effort` — `low`, `medium`, `high` — so fine-grained tuning is hard. Claude, by contrast, lets you stream thinking blocks for debugging or quality monitoring, and lets you set thinking volume directly as an integer via `budget_tokens`, giving more freedom over cost control. Rather than declaring one superior, the practical takeaway is: for production environments where transparency matters, Claude has the edge; for systems already built on the OpenAI stack, the natural integration of o3 may be more pragmatic.

| Item | o3 | Claude Opus (Extended Thinking) |
|---|---|---|
| Thinking process visibility | Not available (token count only) | Partial (thinking block streaming) |
| Thinking volume control | reasoning_effort: 3 levels | budget_tokens: set as an integer |
| Thinking token billing | Same rate as output tokens | Separate thinking token rate |
| Minimum thinking tokens | ~1,024 (at low setting) | 1,024 (configuration floor) |
| Debugging ease | Low | Medium (thinking block available) |

---

## Cost Structure — How Thinking Tokens Are Billed

### Thinking Tokens vs. Output Tokens: The Pricing Structure

If you don't understand the cost structure of reasoning models, you will get unexpected bills. With ordinary models, you only need to track input tokens and output tokens. With reasoning models, a third category — **thinking tokens** — is added. According to Anthropic's official documentation, Claude's Extended Thinking tokens are billed at the same rate as output tokens, and depending on problem complexity, far more thinking tokens can be generated than output tokens. In other words, even if the final response the user receives is only 300 tokens, if 6,000 tokens were consumed in internal reasoning, the full amount is billed. If you are unaware of this structure and use a reasoning model for every API call, you can end up paying 10–50× more than running the same throughput on an ordinary model.

```diagram
en/2026-10-03-19f27e99-03
```

Because thinking tokens are billed at the same rate as output tokens and can be consumed in large quantities, a single complex query can cost far more than you expect.

### Analyzing Real Cost Scenarios

The most common mistake when adopting reasoning models is applying them to every stage of a pipeline. Steps like routing user questions into categories, generating brief document summaries, simple form validation, and chunk retrieval in a RAG pipeline require no reasoning ability whatsoever. Using Claude Opus for these tasks can cost 20–50× more than using Claude Haiku. To forecast total cost, apply this formula:

**Total cost = (input tokens × input rate) + (thinking tokens × output rate) + (output tokens × output rate)**

The key variable is the thinking token estimate. Classifying task complexity into three buckets — simple (under 1k), moderate (2k–8k), and high-complexity (8k–32k) — and budgeting accordingly will keep your actual cost reasonably close to forecast.

| Task complexity | Expected thinking tokens | Recommended budget_tokens | Notes |
|---|---|---|---|
| Simple (classification, summarization) | Not needed | Do not use | Prefer Haiku/Sonnet |
| Moderate (code review) | 2,000–5,000 | 4,000–8,000 | Truncated if budget exceeded |
| Complex (design decisions) | 5,000–15,000 | 10,000–16,000 | Understand the per-token rate |
| Very complex (algorithm proofs) | 15,000–32,000 | 20,000–32,000 | Cost alerts are mandatory |

### How Prompt Caching Interacts with Thinking Tokens

Anthropic's **Prompt Caching** cuts input token costs by up to 90% when you reuse a long system prompt or reference document across calls. In reasoning models, however, this caching does not apply to thinking tokens — they are generated fresh on every call. The strategy is therefore straightforward: maximize caching on the system prompt and large reference documents to reduce input token costs, while optimizing the thinking tokens themselves through `budget_tokens` control. Using both levers simultaneously produces much larger savings than either optimization alone. To maximize cache hit rates, minimize dynamic elements in the system prompt and put any per-user or per-request information only in the message payload.

---

## Cost-Effective Prompting Strategies

### Don't Tell Reasoning Models "How" to Think

The most common mistake developers make when first using reasoning models is carrying over their CoT prompting habits. Prompts that instruct the thinking steps — "First analyze the requirements, then design the architecture, and finally lay out the implementation plan" — backfire with reasoning models. The model is already searching for the optimal reasoning path internally; imposing an external path adds a constraint that the model feels obligated to follow. It is like telling a chess grandmaster "move the knight first, then the bishop second." For reasoning models, the right approach is to clearly communicate **what**, **why**, and **what the success criteria are**, then leave the process to the model.

```diagram
en/2026-10-03-19f27e99-04
```

Give reasoning models "what, why, and criteria" — not "how" — so the internal reasoning path can optimize without constraint.

Here is a concrete before-and-after comparison. For the same task, changing only the prompt structure affects both thinking token efficiency and output quality.

**Before (includes CoT instruction)**

> "Please analyze the following in steps: ① identify the problems in the existing code, ② assess the severity of each problem, ③ list improvement options in priority order, and ④ evaluate the implementation difficulty of each option."

**After (outcome specification)**

> "List everything that needs to be fixed in the code below before deploying it to production, organized by severity (critical/major/minor) and estimated fix time. Write it in a form that a team member can immediately distribute across a Sprint."

The second prompt does not specify an analysis method; it specifies the **purpose of the output** ("distribute across a Sprint"). The reasoning model chooses the analysis path that serves that purpose on its own, skipping unnecessary intermediate steps and saving thinking tokens. In practice, the outcome-specification approach tends to consume 20–40% fewer thinking tokens than the CoT-instruction approach while producing equivalent quality.

### Controlling budget_tokens and Using Thinking Blocks

In Anthropic's Extended Thinking API, `budget_tokens` is the key lever for balancing cost and quality. Setting it higher is not automatically better; you need to find the right value for the task's complexity. Set it too low and the model cannot think enough to answer correctly; set it too high and unnecessary reasoning cycles burn money. In production, manage `budget_tokens` as presets per task type, and only step them up incrementally when quality degradation is detected. Below is an example using the Anthropic Python SDK to run a code review with Extended Thinking.

```python
import anthropic

client = anthropic.Anthropic()

def review_code_with_thinking(code: str, budget: int = 8000) -> dict:
    """
    Runs a code review in Extended Thinking mode.
    budget: upper limit on thinking tokens (default 8,000)
    """
    response = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        thinking={
            "type": "enabled",
            "budget_tokens": budget   # explicitly cap thinking tokens
        },
        messages=[{
            "role": "user",
            "content": (
                "Please review the Python code below before deploying it to production.\n"
                "Organize your findings by severity (critical/major/minor) and estimated fix time.\n\n"
                f"```python\n{code}\n```"
            )
        }]
    )

    thinking_text = ""
    final_response = ""

    for block in response.content:
        if block.type == "thinking":
            thinking_text = block.thinking  # reasoning process (for debugging)
        elif block.type == "text":
            final_response = block.text

    return {
        "response": final_response,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        # thinking tokens are tracked separately from usage.cache_creation_input_tokens etc.
        "thinking_preview": thinking_text[:200] if thinking_text else None,
        # cost estimate (rates from official docs, subject to change)
        "estimated_cost_usd": round(
            response.usage.input_tokens * 0.000015
            + response.usage.output_tokens * 0.000075,
            6
        ),
    }
```

The key point in this example is that `budget_tokens` is capped at 8,000 — enough thinking space for a moderately complex code review while preventing unbounded consumption. The `response.usage` object also includes `cache_read_input_tokens` and `cache_creation_input_tokens`, so caching effects can be tracked alongside thinking costs. Logging the returned `thinking_preview` gives you a starting point for root cause analysis when quality drops.

### System Prompt Design Principles

System prompts for reasoning models need different design principles than those for standard models. With standard models, detailed instructions tend to improve quality; with reasoning models, an excessively long system prompt can waste thinking tokens, because the model references the system prompt at each thinking step. Putting the solution method in the system prompt also causes the model to stick to that method, which can prevent it from finding a better solution.

> **Principle**: A reasoning model's system prompt should contain only **role, constraints, and output format** — no solution method, no thinking sequence. Under 200 tokens is ideal.

The three elements of an effective system prompt are: **① Role definition** — "You are a backend architecture specialist." **② Core constraints** — "All recommendations must be grounded in the team's tech stack (Java 17, Spring Boot 3.x)." **③ Output format** — "Organize as a Markdown table with one line of rationale per item." Deliver these three things concisely and the reasoning model fills in the rest.

---

## Choosing a Model by Task Type

### Tasks That Need a Reasoning Model vs. Tasks That Don't

The most important decision when adopting reasoning models is deciding which tasks to use them for. Using a reasoning model on every task is not performance optimization — it is waste. The areas where reasoning models prove their worth are clear: design decisions with no single correct answer, optimization problems that must satisfy multiple constraints simultaneously, root cause analysis of bugs across a large codebase, and logical verification requiring legal or mathematical proof. On the other hand, pattern-based transformation tasks — sentiment classification, keyword extraction, simple translation, text summarization, chunk retrieval in a RAG pipeline — are far more economical and faster with Haiku- or Sonnet-level models. Using a reasoning model on tasks that do not require reasoning capability only raises cost; quality is nearly identical.

```diagram
en/2026-10-03-19f27e99-05
```

Task classification comes first; model selection comes second. Picking the model before classifying the task will drive costs up unnecessarily.

### Role Assignment in Multi-Agent Architectures

In large-scale AI pipelines, an architecture that treats the reasoning model as the **commander** and standard models as **executors** is cost-efficient. The reasoning model is invoked only for overall planning, complex judgment, and final verification; repetitive data processing, format conversion, and chunk-level operations are delegated to cheaper models. Applying this distribution strategy lets you process 80–90% of token cost through standard models while keeping final quality close to what you would get if the entire pipeline ran on the reasoning model. For example, in a large contract analysis pipeline, having Claude Haiku generate per-chunk summaries and Claude Opus with Extended Thinking handle consistency verification and legal risk extraction is practical. In this structure, the tokens consumed by Opus stay around 10–15% of the total.

```diagram
en/2026-10-03-19f27e99-06
```

Because most token cost is handled by Haiku/Sonnet, Opus accounts for only a small fraction of total cost.

### Implementing an Automatic Routing Classifier

Managing task classification manually is feasible early on, but as traffic grows, automatic routing becomes necessary. A lightweight classifier that evaluates incoming query complexity by heuristic and sends it to the appropriate model is effective. Useful classification signals include query length, density of technical terminology, presence of multi-step conditionals, and the existence of code blocks. Critically, the classifier itself must run on a cheap model like Haiku. If classification cost accumulates, it erodes the overall savings.

```python
def route_to_model(query: str, context_length: int = 0) -> tuple[str, int | None]:
    """
    Returns a model name and budget_tokens based on query complexity.
    Returns: (model_name, budget_tokens | None)
    """
    has_code    = any(kw in query for kw in ["```", "def ", "class ", "SELECT"])
    has_math    = any(kw in query for kw in ["proof", "optimize", "complexity", "algorithm"])
    has_design  = any(kw in query for kw in ["design", "architecture", "trade-off", "decision"])
    long_input  = len(query) > 600 or context_length > 4_000

    if has_math or (has_design and long_input):
        # High complexity → Opus + generous thinking budget
        return "claude-opus-4-5", 16_000   # result: Opus, 16k budget
    elif has_code or has_design or long_input:
        # Moderate complexity → Sonnet + limited thinking
        return "claude-sonnet-4-5", 6_000  # result: Sonnet, 6k budget
    else:
        # Simple → Haiku, no reasoning needed
        return "claude-haiku-4-5", None    # result: Haiku, no thinking
```

The key principle in this routing logic is a **conservative upward strategy**. Route borderline cases to the middle model, then build a feedback loop that only upgrades specific query types to Opus when the quality monitor detects a high error rate. This lets you converge on the cost-quality equilibrium gradually.

---

## Considerations for Production

### The Clash Between Latency and User Experience

The biggest operational problem with reasoning models is response latency. While standard models output the first token within 1–3 seconds, reasoning models can take 5–30 seconds to produce the first token due to the thinking phase. Even with the streaming API, no text appears during the thinking phase, so users stare at a blank screen. This latency is fatal for interfaces that need immediate reactions — real-time chatbots, autocomplete, search suggestions.

There are two practical solutions. The first is **async processing**: run the reasoning model in the background and notify when the result is ready. The second is the **draft-first pattern**: use a standard model to display an immediate draft, then progressively replace it as the reasoning model's result completes. The second pattern lets users receive immediate feedback while still getting a high-quality final result, which dramatically reduces perceived latency.

```diagram
en/2026-10-03-19f27e99-07
```

The draft-first pattern significantly reduces perceived latency while preserving final quality.

### Common Pitfalls and Debugging

There are problems you will frequently encounter when first putting reasoning models into production. **First: runaway thinking.** If you don't set `budget_tokens` or set it too high, the model thinks unnecessarily deeply even on clear problems and costs spike. In production, always specify a `budget_tokens` ceiling and configure cost anomaly alerts. **Second: prompt over-specification.** Giving a reasoning model excessively detailed procedures can cause it to follow those procedures as a constraint, preventing it from finding a better solution. This is especially pronounced on problems with a large search space, like mathematical optimization or algorithm design. **Third: cost spikes from cache misses.** When applying prompt caching to reasoning model calls, if the user message or dynamic context changes on every call, the cache hit rate drops and the benefit disappears.

| Problem | Cause | Fix |
|---|---|---|
| Runaway thinking | budget_tokens not set | Manage per-task ceiling presets |
| Quality degradation | CoT instruction included | Remove "how," switch to outcome specification |
| Latency spike | Synchronous call | Async processing + draft-first display |
| Cache misses | Too much dynamic context | Separate static/dynamic, cache only static |
| Excessive cost | Opus on simple tasks | Introduce automatic routing classifier |

### Monitoring Metrics and the Cost Feedback Loop

Monitoring matters far more for reasoning models than for ordinary LLMs. The key metrics to track are: **average thinking tokens per task type**, **actual cost per call**, **actual usage as a percentage of budget_tokens**, and **response quality score (LLM-as-judge or human review)**. If thinking token usage consistently reaches 90% or more of `budget_tokens`, that is a signal to raise the budget. Conversely, if it consistently stays below 50%, you can lower the budget and cut costs. Automatically generating a weekly cost-vs-quality report per task type, and using that data to adjust `budget_tokens` and routing rules, forms a feedback loop that can reduce reasoning model costs by 30–50% over time. The more automated this loop becomes, the less manual adjustment the team has to do.

---

## Closing

### Key Takeaways

Reasoning models deliver powerful performance on complex problems, but that power comes with the cost of thinking tokens. Three things covered in this post are central. **First**: tell reasoning models "what, why, and the criteria" — not "how" — because CoT instructions constrain the internal reasoning path and backfire. **Second**: set `budget_tokens` to match task complexity, and keep standard models for simple tasks; three-tier routing is the core of cost efficiency. **Third**: in multi-agent architectures, reasoning models must be limited to handling 10–20% of total tokens to guarantee cost efficiency.

```diagram
2026-10-03-19f27e99-08
```

Three-tier routing by task complexity is the core strategy for optimizing both cost and quality simultaneously.

### Decision Criteria for Adoption

When evaluating whether to introduce a reasoning model, start with this question: **"What is the cost of a wrong answer on this task?"** The higher that cost — a wrong design decision wastes months, or a code vulnerability that passes review causes a security incident — the more justified the investment in a reasoning model. On the other hand, if the task tolerates errors well and humans can easily review the output, a fast and cheap model is the better choice. Reasoning models are tools for work where "the cost is high but being wrong is not acceptable." Sharing this decision criterion clearly across the team and codifying it as routing rules is the starting point for a successful adoption. Once the feedback loop of cost monitoring → quality measurement → budget adjustment is in place, the reasoning model cost control that seemed hard at first becomes increasingly predictable.
