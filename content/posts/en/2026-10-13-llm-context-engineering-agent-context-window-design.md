---
title: "LLM Context Engineering — Designing the Context Window That Determines Agent Performance"
date: "2026-10-13 02:16"
updated: "2026-10-19 15:39"
category: "AI"
tags: ["Context Engineering", "LLM Agent", "Context Window", "RAG", "Prompt Caching"]
excerpt: "Check the context before swapping models. Designing an agent's context window around lost-in-the-middle, threshold-based compression, memory tiers, and sub-agent summaries."
koSlug: "2026-10-13-LLM-Context-Engineering-—-에이전트-성능을-결정하는-컨텍스트-윈도우-설계"
---

## Table of Contents

1. Overview
2. Context Window Structure and How It Works
3. Effective Context Design Strategies
4. Agent Loop and Context State Management
5. Context Compression and Memory Layer Design
6. Context Engineering in Production
7. Closing Thoughts

---

## Overview

### Background

When you trace performance degradation in an LLM agent system, context design turns out to be a more decisive variable than model selection more often than not. **Context Engineering** is the set of practices for deliberately designing what goes into the context window so the LLM performs the right task. It goes beyond writing a good prompt — it is the engineering discipline of systematically deciding what information to give the model, when, and in what form. The longer the task an agent runs, or the more tools it calls, the more directly context quality determines output quality.

### Limits of the Old Approach

In the early days of LLM adoption, many teams focused on **Prompt Engineering** — carefully crafting input text. But as complex workflows became the norm — agents calling tools, reasoning across multiple steps, interacting with external systems — single-prompt optimization revealed its limits. As tool call results pile up, the context expands, and the model starts distributing attention across irrelevant information or "forgetting" important instructions. This is called **Context Pollution**, and it is one of the most common causes of agent errors.

```diagram
2026-10-13-b98ce030-01
```

Prompt optimization alone cannot handle complexity at the agent scale; the entire context must be treated as a design artifact.

Context Engineering answers three questions. **What to include**, **how to structure it**, and **when to update it**. If you do not explicitly design these three things, your agent will fail in unpredictable ways. This is exactly why the saying "it's not a bad model, it's bad context" resonates so strongly among practitioners.

---

## Context Window Structure and How It Works

### Anatomy of the Context Window

The range of text an LLM can process in a single inference pass is called the **context window**. GPT-4o supports 128K tokens, Claude Sonnet 4.5 supports 200K tokens, and Gemini 1.5 Pro supports 1M tokens. But a larger window does not make the problem go away. Information inside the window is not processed uniformly — the degree of attention the model pays varies by position.

In a real agent system, the context window is logically divided into several regions. The **system prompt** holds the agent's role, rules, and the list of available tools. The **task context** contains the goal and constraints of the current task. The **conversation history** is the accumulation of previous messages and tool call results. **Retrieved information** is external knowledge pulled in via RAG or tool calls. How you arrange and balance these four regions is the core of context design.

| Region | Content | Characteristics | Watch out for |
|---|---|---|---|
| System prompt | Role definition, tool specs | Fixed, cacheable | Too long dilutes task instructions |
| Task context | Current goal, constraints | Updated per task | Must be structured |
| Conversation history | Previous turns, tool results | Cumulative, expands | Needs periodic compression |
| Retrieved information | RAG, external data | Dynamically injected | Remove duplicates and noise |

---

### The Lost in the Middle Phenomenon

A 2023 paper by Stanford and UC Berkeley researchers, ["Lost in the Middle"](https://arxiv.org/abs/2307.03172), experimentally demonstrated that LLMs make good use of information at the beginning and end of the context but **tend to overlook information inserted in the middle**. This effect becomes more pronounced as the context grows longer. When an agent runs through multiple steps and important constraints or earlier outputs end up buried in the middle of the context, the model fails to reference them effectively and continues in the wrong direction.

```diagram
en/2026-10-13-b98ce030-02
```

The middle region of the context window is a blind spot where the model's attention weakens, so the principle is to place important information at the front and back boundaries.

The practical lesson is clear. The most important instructions should go at the top of the system prompt and at the end of the user message. Key values that the agent must reference in later steps — for example, IDs generated in a previous step or validated data — should not be buried in the middle; the context needs to be restructured or those values need to be explicitly highlighted.

---

### Token Budget and Cost Structure

The context window is not just a technical constraint — it is directly tied to **cost structure**. LLM APIs charge based on input and output tokens, and every time an agent makes another LLM call, the entire accumulated context up to that point is billed as input tokens. In a 10-step agent where the context grows by 2,000 tokens per step, the last step can cost up to ten times more in input tokens than the first.

Anthropic's **Prompt Caching** feature is effective at mitigating this cost problem. Designating context blocks that never change — like the system prompt — as cached blocks can cut input costs for those blocks by up to 90% on repeated calls. Separating the **static parts** (system prompt, tool schemas) from the **dynamic parts** (conversation history, retrieved results) is therefore the starting point for cost optimization in context design.

---

## Effective Context Design Strategies

### Write What You Need, Not What You Know

One of the core principles of Context Engineering is **selecting only what the model must have to perform the task, rather than stuffing in everything you could tell it**. This is often called "Context Hygiene." Instead of pasting an entire database record into the context, extracting only the fields relevant to the current task improves the model's focus and reduces unnecessary token consumption.

In practice, three filtering criteria apply. First, **relevance** — does this information have a direct bearing on the current task? Second, **freshness** — does this information reflect the current state, or could it cause confusion because something has since been updated? Third, **redundancy** — is the same information repeated multiple times, wasting context space? Only information that passes all three criteria belongs in the context.

```diagram
en/2026-10-13-b98ce030-03
```

Inserting only information that survives the three-stage filter dramatically improves the signal-to-noise ratio the model processes within the same token budget.

---

### Structured Information Representation

LLMs tend to process **information with a clear structure** more reliably than free-form text. Structured formats such as XML tags, JSON schemas, and Markdown headers help the model clearly identify the role and boundaries of each information block. Claude-family models in particular show high reasoning accuracy with XML-style tagged context, which relates to the characteristics of their training data.

The example below shows how to structure context when an agent is performing a code review task. Instead of concatenating code and instructions as raw text, the role of each block is declared with tags.

```xml
<task>
  Perform a code review and identify bugs and areas for improvement.
  Priority: bugs → security → performance → readability
</task>

<context>
  <language>Python 3.11</language>
  <project_type>FastAPI REST API</project_type>
  <previous_review_summary>
    2 SQL injection vulnerabilities fixed. Input validation logic incomplete.
  </previous_review_summary>
</context>

<code_to_review>
def get_user(user_id: str):
    query = f"SELECT * FROM users WHERE id = {user_id}"
    return db.execute(query)
    # Danger: no parameter binding, SQL injection exposed
</code_to_review>
```

In this structure, the model can clearly distinguish what to do from the `<task>` block, what background knowledge applies from the `<context>` block, and what to actually process from the `<code_to_review>` block. Compared to unstructured text, the model is less likely to waste attention on irrelevant context and follows instructions more consistently.

---

### Tool Spec Design

The spec for the tools an agent uses is also part of the context. Tool names, descriptions, and parameter schemas occupy a non-trivial portion of the context window, and how you write them has a direct effect on tool-selection accuracy. Vague tool descriptions cause the model to pick the wrong tool or unnecessarily call tools it does not need — an over-calling problem.

The key to an effective tool spec is describing **when to use it, not just what it does**. Instead of "retrieves user information," write "use only when looking up a profile by user ID. Use `search_user_by_email` to search by email." Spelling out boundary conditions like this improves tool-selection accuracy.

| Tool spec element | Bad example | Good example |
|---|---|---|
| Name | `get_data` | `get_order_by_id` |
| Description | Fetches data | Retrieves a single order by order ID. Use `list_orders` for listings |
| Parameter description | order_id: string | Unique order identifier starting with "ORD-" |
| Return value description | Returns order object | null if not found, PermissionError if unauthorized |

---

## Agent Loop and Context State Management

### Context Lifecycle in the Agent Loop

The agent loop is a structure that repeats the cycle of model call → tool execution → result collection → next model call until the goal is achieved or a failure condition is met. With each iteration, every message and tool result from previous steps accumulates in the context window. The ample context space at the start can reach saturation after 10-20 steps, causing the model call itself to fail or performance to drop sharply.

To manage this, the context lifecycle must be explicitly designed. In the **initiation phase**, you set the system prompt and initial task context. In the **execution phase**, you append each tool call result to the context while periodically removing or summarizing information that is no longer needed from earlier steps. In the **completion phase**, you save the final result to external storage and reset the context.

```diagram
en/2026-10-13-b98ce030-04
```

Setting a context threshold and designing the loop to automatically compress or summarize when exceeded guarantees stability for long-running agents.

---

### Selective Preservation of Tool Call Results

The fastest way to inflate the context inside an agent loop is tool call results. API responses, database query results, and web search results can each run into thousands of tokens in their raw form. Rather than keeping all of this in the context, it is more efficient to **extract and preserve only the key values the agent will actually reference in later steps**.

For example, if a user-lookup tool returns a JSON object with dozens of fields, you can extract only the three fields needed downstream — `user_id`, `email`, `subscription_tier` — into a separate "agent memory" structure and discard the original response. The important point here is that **the decision about what to discard should be explicitly defined at system design time, not left to the agent itself**. Having the agent decide what to throw away requires an additional LLM call and incurs additional cost.

> Preserving everything and summarizing later is worse, in both token efficiency and accuracy, than extracting only the needed fields from the start.

---

### Context Boundaries in Multi-Agent Systems

In **multi-agent systems** where multiple agents collaborate instead of a single agent working alone, context boundary design becomes considerably more complex. Each sub-agent operates its own context window independently, and the orchestrator collects sub-agent results and integrates them into its own context. Passing a sub-agent's full context to the orchestrator causes the orchestrator's context to grow exponentially.

An effective pattern is to enforce in the system prompt that sub-agents return a **structured summary** when they complete a task. For example, constraining the sub-agent's final message to a summary format wrapped in XML tags means the orchestrator only needs to integrate that summary into its context. The sub-agent's intermediate reasoning and tool call history are unnecessary noise to the orchestrator.

```diagram
en/2026-10-13-b98ce030-05
```

Sub-agents hide internal processing details and return only the results the orchestrator needs, preventing context explosion.

---

## Context Compression and Memory Layer Design

### Context Compression Strategies

When the context approaches its threshold, compression must occur. There are three broad approaches. First, **selective pruning** — deleting from the context information that has clearly become unnecessary, such as intermediate results from already-completed tool calls or stale user inputs. Second, **LLM-based summarization** — replacing conversation history or tool results with a summary produced by a smaller model. Third, **externalization** — storing information in external storage (vector DB, file system) and retrieving and re-inserting it into the context only when needed.

Each approach has different trade-offs. Selective pruning is simple but setting the right pruning criteria is hard. LLM summarization preserves rich information but incurs the cost of an additional LLM call. Externalization theoretically provides unlimited memory but depends on retrieval accuracy — a bad retrieval result inserted into the context can actually degrade performance.

| Compression strategy | Information loss | Additional cost | Best suited for |
|---|---|---|---|
| Selective pruning | High | None | Clearing obviously unnecessary history |
| LLM summarization | Low | LLM call cost | Long conversation history, tool result compression |
| Externalization (RAG) | None | Retrieval latency, indexing cost | Large document sets, long-term memory |
| Sliding window | Medium | None | Chatbots that keep only the last N turns |

---

### Memory Layer Architecture

For long-running agents or systems that support ongoing user interaction, a single context window is not enough. A **multi-layer memory architecture** inspired by human memory structures is an effective alternative.

**Working memory** is the information currently inside the context window — immediately accessible but capacity-limited. **Episodic memory** consists of summaries of previous sessions or conversations, stored in external storage and loaded into the context at the start of a new session. **Semantic memory** covers slowly changing information such as user preferences, domain knowledge, and system settings — included as part of the system prompt or retrieved from a vector DB on demand. **Procedural memory** is knowledge about how the agent performs specific tasks, encoded in the system prompt or tool specs.

```diagram
en/2026-10-13-b98ce030-06
```

Separating the role of each memory layer lets the context window stay focused on the current task while long-term state is managed efficiently outside it.

---

### Vector-Search-Based Context Injection

RAG (Retrieval-Augmented Generation) is the most widely used method for injecting external knowledge into an agent's context. But the value of RAG does not stop at "find relevant chunks and paste them in" — how retrieved information is integrated into the context significantly affects output quality.

A common mistake is to concatenate the top N chunks by cosine similarity directly into the context. This approach causes problems: context discontinuity between chunks, insertion of duplicate information, and conflicts between information from different sources. A more effective approach is to **re-rank the retrieved chunks and reconstruct them in a coherent form** before inserting them. Below is an example in Python of structuring retrieved results for insertion into a RAG pipeline context.

```python
from anthropic import Anthropic

client = Anthropic()

def build_rag_context(retrieved_chunks: list[dict]) -> str:
    """
    Converts retrieved chunks into a structured context block.
    Chunks have the shape {content: str, source: str, relevance_score: float}.
    """
    # Include only chunks with relevance >= 0.7, up to 5
    filtered = [c for c in retrieved_chunks if c["relevance_score"] >= 0.7][:5]
    
    if not filtered:
        return "<retrieved_context>No relevant information found</retrieved_context>"
    
    chunks_xml = "\n".join([
        f'<chunk source="{c["source"]}" score="{c["relevance_score"]:.2f}">\n'
        f'{c["content"]}\n</chunk>'
        for c in filtered
    ])
    return f"<retrieved_context>\n{chunks_xml}\n</retrieved_context>"

def agent_call(user_query: str, retrieved_chunks: list[dict]) -> str:
    rag_context = build_rag_context(retrieved_chunks)
    
    response = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        system="""You are a technical support agent.
Prioritize information inside <retrieved_context>.
If the information is absent or insufficient, say so explicitly.""",
        messages=[{
            "role": "user",
            # Retrieved context first, question at the end — counters Lost in the Middle
            "content": f"{rag_context}\n\nQuestion: {user_query}"
        }]
    )
    # Result: source and relevance are explicit in the tags, enabling confidence-based citation
    return response.content[0].text
```

The key point in this example is that retrieved results are formatted as `<chunk source="..." score="...">`, making source and relevance explicit. The model can use this metadata to weight higher-relevance chunks more heavily and cite sources clearly. Setting a relevance threshold (0.7) also blocks noisy chunks from entering the context in the first place.

---

## Context Engineering in Production

### Common Mistakes and Anti-Patterns

The first frequently observed context design mistake in production is **unbounded history accumulation**. When a chatbot or agent system keeps every previous exchange in the context, the instructions in the initial system prompt become diluted over time, and the model starts being pulled excessively toward recent conversation patterns. You need a strategy — either keep only the last N turns with a **sliding window**, or periodically summarize the conversation.

The second mistake is **indiscriminate inclusion of error messages in the context**. When a tool call fails, the error message is added to the context; as these accumulate, the model fixates on failures or repeatedly brings up problems that have already been resolved. The better approach is to include errors in the context but compress them together with their resolution — "this error was resolved by X."

The third is **system prompt bloat**. Because the system prompt is stable and cacheable, there is a temptation to put everything there. But when the system prompt grows too long, the model cannot process all the instructions uniformly, and it ends up paying more attention to peripheral content than to the core rules. The system prompt should stay focused on role definition and invariant rules; task-specific detailed instructions belong in the user message context. Keep those two things separate.

```diagram
en/2026-10-13-b98ce030-07
```

Recognizing these three anti-patterns and applying the corresponding design principles early in system design prevents a significant portion of the performance degradation that shows up in production.

---

### Monitoring and Debugging

Verifying the effectiveness of context engineering requires tracking the right observability metrics. **Token usage over time** shows how fast the context grows as the agent loop progresses — growth that is steeper than expected indicates unnecessary information is accumulating. **Tool call accuracy** — the rate at which the agent picks the right tool and passes correct parameters — signals unclear tool specs or system prompt descriptions when low.

**Context conflict detection** also matters. When conflicting information exists in the context, model responses tend to become unstable. For example, if the system prompt says "respond only in English" but previous tool results are packed with Korean text, the model may get confused about which language to use. Adding heuristic validation logic to the context assembly step to catch these conflicts is recommended.

LLM observability tools such as [LangSmith](https://smith.langchain.com/), [Langfuse](https://langfuse.com/), and Arize Phoenix capture and visualize the context state at each step of agent execution. Using them, you can analyze after the fact exactly how the context was composed at a particular step, which greatly improves debugging efficiency.

---

### Considerations for Scaling and Migration

Context design must be reviewed whenever the underlying model changes, because each model handles context differently. An XML-tag-based structuring approach that works well on GPT-4o may not produce the same effect on a different model. When migrating models, run separate A/B tests on context structure, tool spec format, and system prompt style individually — that is the safe path.

When user volume grows, **the economics of your context caching strategy** need to be reassessed. Anthropic's prompt caching requires a minimum cache block of 1,024 tokens with a TTL of 5 minutes. If traffic is spread across time zones, the cache hit rate can drop; in that case, adjust the size and composition of cached blocks to optimize hit rate. In multi-tenant environments, isolating each user's context is also important from a security standpoint. **Context leakage** — where one user's personal information ends up in another user's session context — has happened in real production systems. Session isolation must be explicitly guaranteed from the earliest stage of system design.

---

## Closing Thoughts

### Key Takeaways

To summarize what this post covered: the context window is logically divided into four regions — system prompt, task context, conversation history, and retrieved information — and the placement and balance of these regions determines agent performance. You need to be aware of the **Lost in the Middle** phenomenon and apply a positional strategy that places important information at the front and end of the context. Because the context expands with each agent loop iteration, you need threshold-based compression and a multi-layer memory architecture to design long-running agents. In multi-agent systems, have sub-agents return only structured summaries to prevent context explosion. And when using RAG, manage the signal-to-noise ratio through relevance filtering and structured insertion rather than pasting chunks in raw.

### When to Invest in It

The situations where investing in Context Engineering pays off are clear. If your agent runs tasks with 10 or more steps, combines multiple tools to accomplish complex goals, or needs to maintain long-running conversations with users, stable operation is hard without systematic context design. On the other hand, for simple one-shot Q&A or short text transformation tasks, prompt optimization alone is often sufficient.

If you have performance problems with an agent today, check the context before trying a model swap or fine-tuning. A significant share of agent errors come from poorly designed context, not from the model's capability limits. Are tool descriptions ambiguous? Are critical instructions buried in the middle of the context? Is irrelevant information splitting the model's attention? Reviewing those three things first is the first step in Context Engineering.
