---
title: "Agentic RAG Design — Delegating Retrieval Decisions to an Agent"
date: "2026-09-30 02:17"
category: "AI"
tags: ["Agentic RAG", "RAG architecture", "LLM agent", "retrieval-augmented generation", "multi-hop retrieval"]
excerpt: "How to move beyond fixed RAG pipelines by letting an LLM agent decide whether, how, and how many times to retrieve — with concrete implementation patterns."
koSlug: "2026-09-30-Agentic-RAG-설계-—-검색-판단을-에이전트에게-위임하는-RAG-아키텍처"
---

## Table of Contents

1. Overview
2. Core Concepts and How Agentic RAG Works
3. Architecture Design and Components
4. Implementing the Retrieval-Decision Agent
5. Performance Characteristics and Trade-offs
6. Considerations for Production
7. Closing Thoughts

---

## Overview

### Background

**Agentic RAG** is an architectural pattern that emerged to overcome the persistent limitations of traditional RAG (Retrieval-Augmented Generation) pipelines. Conventional RAG always runs a retrieval step when a question arrives, then feeds the retrieved documents directly to the LLM — a strictly linear flow. That approach works for simple Q&A, but breaks down visibly when complex reasoning is required or information must be gathered across multiple steps. Agentic RAG solves this by **delegating to an agent** the authority to decide whether to retrieve, which strategy to use, and how to use the results.

### Limitations of the Conventional Approach

A typical RAG pipeline follows a fixed sequence: "question → embedding → vector search → context injection → response generation." That structure is simple to implement, but it carries three fundamental limitations.

First, **it never decides whether retrieval is actually necessary.** Even for a question like "What is 2 plus 2?" — something the LLM can answer from its own knowledge — retrieval happens unconditionally. This introduces unnecessary latency and token cost.

Second, **it cannot handle questions that require more than one retrieval step.** A request like "Compare technology A and technology B and analyze which one is a better fit for our system" requires multiple retrieval passes and intermediate reasoning. A fixed pipeline tries to satisfy this with a single search, so it never gathers enough context.

Third, **it never evaluates retrieval quality.** There is no feedback loop to check whether the retrieved documents are actually relevant to the question or contain sufficient information. Low-relevance documents get injected into the context as-is, degrading response quality.

```diagram
en/2026-09-30-f3c7b279-01
```

Because conventional RAG executes a fixed pipeline without any decision-making, it consumes the same cost and structure regardless of question complexity.

---

## Core Concepts and How Agentic RAG Works

### Agent-Driven Retrieval Decisions

The central idea in Agentic RAG is to **treat retrieval as a tool** and let the LLM agent decide on its own whether and how to invoke that tool. This is not a minor implementation change — it is a paradigm shift in how RAG is conceived.

In conventional RAG, retrieval is a mandatory pipeline stage. In Agentic RAG, it is an option the agent can call selectively. After analyzing a question, the agent makes judgments like "Does this question need external information?", "What keywords should I search with?", and "Are these results sufficient?" The LLM's reasoning capability is central to this judgment process.

```diagram
en/2026-09-30-f3c7b279-02
```

The iterative structure — where the agent evaluates retrieval results and replans if they are insufficient — is the heart of Agentic RAG.

### Dynamic Selection of Retrieval Strategy

Agentic RAG goes beyond deciding whether to retrieve; **the agent also decides how to retrieve**. It selects from several strategies based on the nature of the question.

**Query Decomposition** splits a complex question into multiple simpler sub-questions and searches for each in sequence. A question like "Trends in AI startup tech stacks and their impact on the hiring market" requires at least two independent searches.

**Hybrid Retrieval** combines vector search with keyword search. The agent judges whether the question calls for conceptual similarity (favoring vector search) or needs specific terms or code snippets (favoring keyword search), then picks accordingly.

**Multi-hop Retrieval** chains searches together: information from the first retrieval result drives the second and third searches. This is similar to following links on Wikipedia to gather information progressively.

| Retrieval Strategy | Suitable Question Types | Main Cost | Watch Out For |
|---|---|---|---|
| Single vector search | Simple factual questions, concept explanations | Low latency | Weak at keyword matching |
| Query decomposition | Compound conditions, multiple topics | N retrieval calls | Decomposition errors propagate |
| Hybrid retrieval | Technical docs, code search | Dual index maintenance | Weight tuning needed |
| Multi-hop retrieval | Causal chains, sequential reasoning | High latency | Must prevent infinite loops |

### Self-Evaluation and the Feedback Loop

The sharpest distinction between Agentic RAG and conventional RAG is the **self-evaluation mechanism**. Rather than simply inserting retrieved documents into the context, the agent assesses their quality.

This evaluation typically applies three criteria. First, **Relevance** — are the retrieved documents actually related to the question? Second, **Sufficiency** — is the information gathered so far enough to answer the question? Third, **Credibility** — is the source trustworthy? Based on this assessment, the agent decides whether additional retrieval is needed or whether to switch to a different strategy.

This feedback loop fundamentally improves RAG quality, but it also introduces the risk of infinite loops. A maximum iteration limit (`max_iterations`) is therefore essential, along with a fallback strategy that lets the agent produce at least a partial response from whatever information it has collected so far.

---

## Architecture Design and Components

### Agent Layer Structure

Agentic RAG architecture consists of three broad layers: the **orchestration layer**, the **tool layer**, and the **knowledge layer**. Separating these three layers lets each component be replaced and tested independently.

The orchestration layer is the agent itself. The LLM analyzes the question, plans which tools to use in what order, and evaluates intermediate results. The core of this layer is **system prompt design**. The system prompt must specify when the agent should invoke the retrieval tool and how it should evaluate results.

The tool layer is the set of actual functions the agent can call: vector search, keyword search, summarization, calculation, external API calls, and so on. Each tool must have a clear input/output specification and proper error handling.

The knowledge layer is the data stores being searched: vector databases, traditional search engines, and relational databases can all be part of it.

```diagram
en/2026-09-30-f3c7b279-03
```

The orchestration layer dynamically composes tools and the knowledge layer to determine the retrieval strategy.

### Tool Specifications and Function Signatures

For the agent to use tools effectively, each tool's **specification** must be defined in a form the LLM can understand. This includes the function signature, parameter descriptions, return value shape, and example usage scenarios.

The quality of tool specifications directly affects agent performance. If parameter names and descriptions are vague, the agent will pass wrong arguments, which leads to degraded retrieval quality. A common real-world problem is tool specs written too technically, leaving the LLM unable to figure out when to use them. Tool specifications **must include an explanation of when to use the tool**.

Below is an example tool specification in Python. The `retrieve_documents` function accepts a query string and optional filters and returns a ranked list of relevant documents.

```python
from typing import Optional
from anthropic import Anthropic

client = Anthropic()

# Tool specifications — include clear descriptions the LLM can understand
tools = [
    {
        "name": "retrieve_documents",
        "description": (
            "Fetches documents related to the question via vector similarity search. "
            "Use this when fact-checking is needed or you need to reference up-to-date information. "
            "You do not need to use this for simple calculations or general-knowledge questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The query to search with. Can be natural language or key terms."
                },
                "top_k": {
                    "type": "integer",
                    "description": "Number of documents to return (default: 5, max: 20)",
                    "default": 5
                },
                "filter_tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Restrict search to specific categories (e.g., ['technical', 'recent'])"
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "keyword_search",
        "description": (
            "Finds documents using BM25-based keyword search. "
            "Well-suited for searches that include specific code snippets, product names, or proper nouns."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of keywords to search for"
                },
                "operator": {
                    "type": "string",
                    "enum": ["AND", "OR"],
                    "description": "AND: all keywords must be present, OR: at least one must be present",
                    "default": "AND"
                }
            },
            "required": ["keywords"]
        }
    }
]
# retrieve_documents result: returns documents sorted by relevance score
# keyword_search result: returns documents ranked by BM25 score
```

Explicitly stating in the tool spec when the tool does *not* need to be used is critical to reducing unnecessary retrieval calls by the agent.

### Context Management and Memory

When multi-hop retrieval or multiple tool calls happen in sequence, **context window management** becomes a serious design concern. If every retrieval result is appended to the context as-is, the token limit can be exceeded or important information can be diluted by the "lost in the middle" effect.

The common solution is **summarization-based compression**. At each retrieval step, the agent summarizes the collected information down to its essentials, and subsequent steps reference the summary rather than the full text. This conserves context but risks information loss.

Another approach is **external memory**: intermediate facts gathered during the agent's reasoning are written to a separate store and queried on demand. This increases implementation complexity but preserves information integrity across long reasoning sessions.

---

## Implementing the Retrieval-Decision Agent

### Implementing the Agent Loop

Here is the agent loop that is the core of Agentic RAG. The loop continues until the agent produces a final response or the maximum iteration count is reached. When `stop_reason` is `"tool_use"`, a tool call is needed, so the corresponding tool is executed and its result is passed back to the agent.

```python
import json
from typing import Any

# Actual retrieval function (connected to a vector DB or search engine)
def execute_tool(tool_name: str, tool_input: dict) -> Any:
    if tool_name == "retrieve_documents":
        # In a real environment, call the vector DB client here
        query = tool_input["query"]
        top_k = tool_input.get("top_k", 5)
        # Example: simulated search results
        return [
            {"id": f"doc_{i}", "content": f"Document {i}: content related to {query}", "score": 0.9 - i * 0.1}
            for i in range(top_k)
        ]
    elif tool_name == "keyword_search":
        keywords = tool_input["keywords"]
        return [{"id": "kw_doc_1", "content": f"Document containing keywords {keywords}", "score": 0.85}]
    return []

def agentic_rag_query(user_question: str, max_iterations: int = 5) -> str:
    messages = [{"role": "user", "content": user_question}]
    system_prompt = """You are an agent that retrieves information from a knowledge base to answer questions.

Principles for using retrieval tools:
1. Call a retrieval tool only when fact-checking or up-to-date information is needed.
2. If retrieval results are insufficient, retry with different keywords or a different strategy.
3. After a maximum of 3 retrievals, generate the best possible answer from the information collected so far."""

    for iteration in range(max_iterations):
        response = client.messages.create(
            model="claude-opus-4-5",
            max_tokens=4096,
            system=system_prompt,
            tools=tools,
            messages=messages
        )

        # Agent has finished generating a response
        if response.stop_reason == "end_turn":
            final_text = next(
                (block.text for block in response.content if hasattr(block, "text")), ""
            )
            return final_text  # Return the final response

        # Agent has requested a tool call
        if response.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []

            for block in response.content:
                if block.type == "tool_use":
                    result = execute_tool(block.name, block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, ensure_ascii=False)
                    })

            messages.append({"role": "user", "content": tool_results})

    return "Maximum iterations exceeded — unable to answer based on the information collected so far."

# Usage example
answer = agentic_rag_query("What are the major trends in recent AI agent frameworks?")
# Result: the agent decides on its own whether to retrieve, queries relevant documents, and returns a synthesized response
```

The key to the agent loop is using `stop_reason` to distinguish between a tool call and a final response. Tool results are appended as new messages so the agent maintains continuous reasoning context.

### Query Decomposition and Multi-step Retrieval

Beyond simple single-tool calls, here is the pattern where the agent independently decomposes a complex question and retrieves across multiple steps. This approach is particularly effective for complex analytical questions.

```python
# System prompt strategy to explicitly guide query decomposition
decomposition_system = """When given a complex question, follow these steps:

1. Decompose the question into independent sub-questions.
2. Call retrieve_documents for each sub-question.
3. Synthesize the collected information into a final answer.

Example: "Differences in concurrency models between Python and Go, and suitable use cases for each"
→ Sub-question 1: "Python concurrency model (asyncio, threading, multiprocessing)"
→ Sub-question 2: "Go goroutines and channel-based concurrency"
→ Sub-question 3: "Comparison of suitable use cases for each language"
"""
# Individual retrieval results for each sub-question accumulate in the agent's context
# The loop repeats until stop_reason == "end_turn"
```

Query decomposition performs most consistently when the system prompt includes explicit instructions and examples.

### Evaluating Retrieval Results and Retrying

To guide the agent to self-evaluate retrieval quality, **evaluation criteria must be spelled out in the system prompt**. A vague instruction like "retry if results are insufficient" is not enough. The agent needs to know the specific criteria for judging sufficiency.

```diagram
en/2026-09-30-f3c7b279-04
```

Evaluating retrieval results should not be based on a simple document count, but on whether the content directly addresses the core of the question.

---

## Performance Characteristics and Trade-offs

### Latency and Cost Profile

Agentic RAG delivers better response quality than conventional RAG, but at the cost of **increased latency and expense**. This is a trade-off that must be factored in at design time.

A typical RAG response time breaks down as: vector search (50–200 ms) + LLM inference (1–5 s). Agentic RAG adds the agent's initial planning, N tool calls, and LLM inference between each call, which can push total latency 2× to 10× higher.

The cost difference is also significant. Every time the agent calls a tool, the entire message history is counted as input tokens. The more iterations, the more steeply costs rise. Three tool calls alone can consume 3–4× the input tokens of a conventional RAG call by a rough calculation.

| Approach | Avg. Latency | Avg. Cost (relative) | Response Quality | Best For |
|---|---|---|---|---|
| Conventional RAG | 2–6 s | 1× | Medium | Simple FAQ, fast responses |
| Agentic RAG (1–2 hops) | 5–15 s | 2–3× | High | Complex questions, analysis requests |
| Agentic RAG (3+ hops) | 15–40 s | 4–8× | Highest | Deep research, report generation |
| Agentic RAG with caching | 3–8 s | 1.5–2× | High | High-repetition questions |

### Comparison with Alternative Techniques

Patterns often compared to Agentic RAG include **FLARE (Forward-Looking Active REtrieval)**, **Self-RAG**, and **Corrective RAG (CRAG)**.

FLARE triggers retrieval mid-generation when the LLM detects uncertainty. It monitors the generation process more granularly than Agentic RAG, but implementation complexity is very high.

Self-RAG uses a specially fine-tuned LLM that handles retrieval triggering, relevance judgment, and support evaluation through special tokens. It suits open-source models but requires fine-tuning cost and infrastructure.

Corrective RAG uses a separate evaluator model to score retrieval relevance and falls back to web search when scores are low. This gives the broadest retrieval coverage, but with many system components, operational overhead is significant.

```diagram
en/2026-09-30-f3c7b279-05
```

Agentic RAG is the best fit when you need to handle high-complexity reasoning without fine-tuning.

### When to Choose Agentic RAG

The situations that justify adopting Agentic RAG are clear-cut. For simple FAQ systems, product spec lookups, or customer support bots — cases where **question structure is simple and predictable** — conventional RAG is more efficient. There is no reason to pay extra latency and cost.

On the other hand, for **analytical report generation**, **technology comparison and decision support**, and **research tasks that require combining multiple data sources**, the flexibility of Agentic RAG creates a decisive advantage. In domains where a large proportion of questions can be answered from the LLM's own knowledge, even just "deciding not to retrieve" can meaningfully cut costs.

---

## Considerations for Production

### Common Mistakes and Pitfalls

The most frequent problem when first deploying Agentic RAG to production is **failure to control the agent loop**. The agent may keep judging results as insufficient and retry indefinitely, or conversely give up on retrieval too early.

Three safeguards are essential. First, enforce `max_iterations` and generate the best possible response from whatever has been collected when the limit is hit. Second, detect and block repeated searches with the same query. Third, log every tool the agent calls along with its results, so you have evidence for debugging.

Another common mistake is **excessive overlap in tool specifications**. When several tools have similar functions, the agent becomes confused about which one to pick. Keep the total number of tools to five or fewer, and design each tool's usage scenario so they do not overlap.

```diagram
en/2026-09-30-f3c7b279-06
```

Without loop control and duplicate detection, the result can be runaway costs and timeout failures.

### Monitoring and Debugging

Observability matters far more for Agentic RAG than for conventional RAG. When response quality degrades, you need to be able to trace the agent's full reasoning process to find the cause.

Metrics you must collect in production: **Tool Call Count** — how many searches the agent performs per question on average. If this is higher than expected, revisit the system prompt or tool specifications. **Retrieval Success Rate** — the proportion of retrieved documents that actually get used in generating the final response. A low rate means the index quality or retrieval strategy needs work. **Agent Error Rate** — the proportion of iterations that saw tool call failures, JSON parsing errors, or timeouts.

Integrating with a distributed tracing system (e.g., OpenTelemetry) and recording each tool call as a separate span lets you pinpoint latency bottlenecks precisely.

### Scaling and Migration

When migrating an existing RAG system to Agentic RAG, a **gradual transition** strategy is safest. Rather than switching all traffic at once, use a canary deployment approach, starting with complex question types.

Adding a router layer that automatically classifies question complexity lets you control costs effectively. Simple questions go to conventional RAG; complex ones go to Agentic RAG. The router itself can be implemented as a lightweight classification LLM or a rule-based classifier.

```diagram
en/2026-09-30-f3c7b279-07
```

Selective routing through a router is the key design decision that practically solves the cost problem with Agentic RAG.

As scale grows, **vector DB partitioning strategy** also becomes important. Putting all documents in a single index means every search scans irrelevant documents, degrading quality. Separating indexes by domain or document type, and reflecting those choices in tool specifications so the agent selects the right index, improves retrieval precision.

---

## Closing Thoughts

### Key Takeaways

Agentic RAG structurally resolves the three core limitations of conventional RAG — unnecessary retrieval, insufficiency of single retrieval, and absence of retrieval quality evaluation — by delegating retrieval authority to an agent. The agent analyzes the question to decide whether to retrieve, selects an appropriate strategy, evaluates result quality, and retries if needed. This puts the LLM's reasoning capability at the center of the pipeline.

From an implementation perspective, **tool specification quality** determines overall system performance. Defining each tool's usage scenario clearly, minimizing overlap, and explicitly stating when a tool does not need to be used are the essentials. From an operations perspective, loop control, cost monitoring, and complexity-based routing are the must-haves for a stable service.

### Decision Criteria for Adoption

The first question to ask yourself when considering Agentic RAG is: "What does the complexity distribution of questions coming into our system look like?" If more than 80% are simple fact lookups, conventional RAG is the better choice on cost efficiency.

On the other hand, if two or more of the following conditions apply, Agentic RAG is worth serious consideration. First, compound questions that require combining multiple data sources arise frequently. Second, 30% or more of questions can be answered adequately from the LLM's own knowledge. Third, low relevance in retrieval results has been causing persistent response quality issues. Fourth, users expect deep, report-level or analytical responses.

Increased latency and cost are real drawbacks, but with dynamic routing by question complexity and an appropriate caching strategy, actual operating costs can be kept to around 1.5–2× those of conventional RAG. Running a **small-scale pilot** before full adoption — to measure the actual question distribution and agent behavior patterns — is the most practical way to reduce risk.
