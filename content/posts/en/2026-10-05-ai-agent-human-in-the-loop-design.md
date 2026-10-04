---
title: "How to Design Human-in-the-Loop for AI Agents"
date: "2026-10-05 02:13"
category: "AI"
tags: ["Human-in-the-Loop", "AI agents", "LangGraph", "automation design", "workflow"]
excerpt: "A practical guide to structuring human approval gates in AI agent pipelines, covering patterns, LangGraph implementation, and production considerations."
koSlug: "2026-10-05-AI-에이전트-Human-in-the-Loop-설계법"
---

## Table of Contents

1. Overview
2. Core Concepts and Mechanics of Human-in-the-Loop
3. Approval Stage Design Patterns
4. Implementing Human-in-the-Loop with LangGraph
5. Performance and Trade-off Analysis
6. Considerations for Production Deployment
7. Closing Thoughts

---

## Overview

### The Problem

As AI agents move into real projects in earnest, the question of how much automation to allow has become one of the central design challenges. An agent that sends emails automatically, modifies a database, or approves payments through an external API is clearly efficient — but a single wrong call can produce results that are hard to undo. **Human-in-the-Loop (HitL)** is the design principle that bridges this gap. It structurally embeds a human confirmation or approval step inside the automation pipeline, right before the agent takes a critical action. This post starts with the conceptual motivation for HitL and then walks through the patterns and operational practices for implementing it in a real agent pipeline.

### The Limits of the Old Approach

Early LLM usage was simple. Because the structure was a single request-response cycle — user sends input, model replies — a model mistake amounted to one wrong answer. Agent architectures changed that. An agent **autonomously chains multiple steps** and manipulates real systems (filesystems, databases, external services) at each step. A bad judgment by the agent then propagates in a cascade. Instead of "draft an email" it becomes "send an email." Instead of "generate a query" it becomes "execute DELETE." Fully automated pipelines offer the benefit of speed, but they carry the structural vulnerability of no verification.

```diagram
en/2026-10-05-5c88b64b-01
```

The tool-call step in an automation pipeline is the point that creates side effects that are hard to undo.

---

## Core Concepts and Mechanics of Human-in-the-Loop

### The Automation Spectrum and Where HitL Sits

It helps to think of agent automation level as a spectrum. One end is fully manual — a human makes every decision. The other end is full automation — the agent owns every judgment and every action. HitL does not sit somewhere in the middle. It is a design philosophy that **selectively inserts intervention points only at specific nodes, based on risk and irreversibility**. Generating an email draft can be automated freely; the actual send warrants a human review. Read queries can run automatically; UPDATE and DELETE queries require approval. HitL is not about giving up on automation — it is about deliberately scoping where automation applies.

| Automation level | Description | When it fits | Watch out for |
|---|---|---|---|
| Fully manual | Human decides every step | High-risk, high-cost decisions | Slow, does not scale |
| HitL (approval gate) | Human intervenes only at critical steps | When you need automation plus a safety net | Must design for approval delays |
| Supervised automation | Runs automatically, human reviews after | Fast execution, post-hoc review is acceptable | Correction cost after execution |
| Full automation | Agent decides and executes everything | Low-risk, high-repetition tasks | Risk of error propagation |

### How It Works: Persisting and Resuming State

The technical core of HitL is a **mechanism that persists the agent's execution state and resumes from exactly the point of interruption when an external event — a human approval — arrives**. Describing it as "the agent pauses and the human replies" makes it sound simple, but the actual implementation involves several layers of problems. The agent's context (memory, previous tool execution results, conversation history) must not be lost while waiting for approval. Multiple agent instances must be able to wait for different approvals at the same time. And after approval, the right instance must resume in the right state. Modern agent frameworks provide a checkpointing mechanism for exactly this purpose.

```diagram
en/2026-10-05-5c88b64b-02
```

Saving state at a checkpoint and resuming from that exact point when the approval signal arrives is the core of HitL implementation.

### Classifying Intervention Triggers

Putting an approval gate on every agent action eliminates the benefits of automation. In real projects, deciding which actions should trigger an intervention is one of the most important design decisions you will make. Three criteria cover most cases. First, **irreversibility** — actions that are difficult or impossible to undo after execution (data deletion, email delivery, payment processing) always get an approval gate. Second, **threshold-based** — a gate is inserted dynamically when the monetary amount or scope of impact exceeds a certain level. Third, **confidence-based** — when the agent itself has low confidence in its own judgment, it delegates to a human. Combining these three criteria lets you make most gate-placement decisions systematically.

> Approval gates are not a sign of distrust in the agent. They exist because some actions require a human to share responsibility, even when the agent is correct.

---

## Approval Stage Design Patterns

### Pattern 1: Inline Approval Gate

The simplest pattern. An `interrupt` node is inserted immediately before a specific node in the agent graph, and execution pauses until a human response arrives. In LangGraph this is declared with the `interrupt_before` or `interrupt_after` parameter. The advantage is that the implementation is simple and the flow is easy to follow. Because the nodes at which execution stops are declared statically at graph-definition time, approval points are easy to identify during code review or audits. The downside is limited flexibility. It is not a good fit when gates need to be inserted or skipped dynamically based on conditions.

```diagram
en/2026-10-05-5c88b64b-03
```

An inline gate is a fixed branch point in the graph; the flow itself splits based on the approval decision.

### Pattern 2: Dynamic Gate (Confidence-Based)

In this pattern the agent decides at runtime whether to request approval. For example: if the number of records to be deleted is under 100, execute automatically; if it is 100 or more, request approval. Or: delegate to a human when the agent's own confidence score falls below a threshold. This pattern effectively reduces unnecessary approval requests and lowers the human's approval fatigue. Requiring approval for every action in practice causes the responsible person to become desensitized to approval requests — the same phenomenon well-known in security as **alert fatigue**. Dynamic gates prevent this while still guaranteeing intervention when the risk is high.

```diagram
en/2026-10-05-5c88b64b-04
```

Deciding dynamically whether to insert a gate based on a threshold keeps the right balance between approval frequency and risk level.

### Pattern 3: Multi-Level Approval

In regulated industries — finance, healthcare, law — a single approval is sometimes not enough. The larger the amount and the wider the impact, the higher the authority required. The multi-level approval pattern arranges multiple approval gates in series or in parallel. Serial arrangement means each stage must be approved in order before proceeding. Parallel arrangement means multiple reviewers evaluate simultaneously, and the request passes when a majority or all agree. The key design question in this pattern is whether to **isolate each approver from the previous approver's opinion**. For audit purposes it is fine to make all opinions visible, but when independent judgment matters, each approver should receive only the original content.

| Approval structure | Pass condition | Example use case | Delay risk |
|---|---|---|---|
| Single approval | 1 approver agrees | General operational approvals | Low |
| Serial multi-stage | All stages pass in order | Regulatory compliance, audit trails | High |
| Parallel majority | Majority agrees | Committee decisions | Medium |
| Parallel unanimous | Everyone agrees | High-risk, irreversible actions | Very high |

---

## Implementing Human-in-the-Loop with LangGraph

### Basic Setup

LangGraph is a framework in the LangChain ecosystem for implementing state-machine-based agent graphs. Since version 0.1 it has officially supported the Checkpointer and `interrupt` features, making it one of the most practical tools for HitL implementations. `MemorySaver` is an in-memory checkpointer for development and testing; in production use `SqliteSaver` or `PostgresSaver`. The checkpointer's job is to serialize and save the graph state before and after each node execution, so that when an agent stops at an `interrupt` the state is persisted.

```python
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command
from typing import TypedDict, Annotated
import operator

# Graph state definition: manage message history and approval context together
class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    pending_action: dict           # information about the action awaiting approval
    action_approved: bool          # approval result

def should_interrupt(state: AgentState) -> bool:
    """Determine whether this is a critical action."""
    action = state.get("pending_action", {})
    # delete, update, and send actions always require approval
    return action.get("type") in {"delete", "update", "send"}

def approval_node(state: AgentState) -> AgentState:
    """Approval gate node: waits until a human response arrives."""
    action = state["pending_action"]
    # interrupt() saves the current state and halts execution.
    # When resumed, the human's response is passed as the return value of interrupt().
    response = interrupt({
        "question": f"Do you approve the following action?",
        "action": action,
    })
    # response is delivered as Command(resume={"approved": True/False})
    return {"action_approved": response.get("approved", False)}

# Compile the graph with a checkpointer
checkpointer = MemorySaver()
graph = (
    StateGraph(AgentState)
    .add_node("approval_gate", approval_node)
    # ... add remaining nodes
    .compile(checkpointer=checkpointer, interrupt_before=["tool_execution"])
)
```

`interrupt()` immediately halts the current node's execution and saves state to the checkpointer. Passing a `Command(resume=...)` object from outside resumes execution from exactly the point of interruption.

---

### Full Implementation: The Entire Approval Flow

Here is the complete flow: send an approval request, receive a response, and resume execution. In real-world usage, approval notifications are sent via a Slack webhook, email, or an internal dashboard. When a reviewer clicks the approval button, that event is delivered to the backend together with the agent's `thread_id`.

```python
import asyncio

# First run of the agent: interrupt fires just before the critical action
config = {"configurable": {"thread_id": "workflow-001"}}

initial_state = {
    "messages": [{"role": "user", "content": "Delete the withdrawn accounts from the customer table"}],
    "pending_action": {},
    "action_approved": False,
}

# Step 1: invoke the graph → automatically stops at the interrupt point
result = graph.invoke(initial_state, config)
# result["__interrupt__"] = [{"value": {"question": "...", "action": {...}}}]

interrupted_info = result.get("__interrupt__", [])
if interrupted_info:
    approval_request = interrupted_info[0]["value"]
    # Send Slack notification (use webhooks in a real implementation)
    print(f"Approval request: {approval_request['question']}")
    print(f"Action details: {approval_request['action']}")

# Step 2: resume after the reviewer approves
# Pass the resume signal and the approval result together via Command(resume=...)
from langgraph.types import Command

resume_result = graph.invoke(
    Command(resume={"approved": True}),
    config  # use the same thread_id to restore state
)
# resume_result contains the final completed state
print(f"Execution complete: {resume_result['messages'][-1]['content']}")
```

The key point is that both the initial `invoke` call and the resume call **use the same `config` containing the same `thread_id`**. The checkpointer uses this ID as a key to save and retrieve state.

---

### Testing and Validation

HitL testing must cover two scenarios without exception. First, verify that the correct action executes when approval is granted. Second, verify that the agent moves safely to an alternative path when the request is rejected or times out. Timeout handling is especially important: a separate expiry policy is needed to prevent the agent from waiting indefinitely when the approver is unavailable or unresponsive.

```diagram
en/2026-10-05-5c88b64b-05
```

Explicitly validating all three paths — timeout, rejection, and approval — in tests is what prevents unexpected behavior in production.

---

## Performance and Trade-off Analysis

### The Reality of Latency

Introducing HitL increases the total pipeline latency by however long it takes for a human to respond. This is an intentional design choice, not a bug, but it does affect overall system throughput. Using async processing means that while one workflow waits for approval, others can proceed, minimizing overall throughput loss. From measurements on real projects, approval wait times during business hours averaged anywhere from a few minutes to tens of minutes. Managing this as an SLA requires an **escalation policy**: if the primary approver does not respond within N minutes, the request is automatically forwarded to a secondary approver.

| Processing mode | Average latency (approval included) | Throughput | Suitable workload |
|---|---|---|---|
| Synchronous, serial | Same as human response time | Low | Single flow where order matters |
| Async, parallel | Based on the longest path | High | Multiple independent workflows |
| Batch approval | N requests handled at once | Medium | Many similar, repetitive actions |

### Comparison with Alternative Approaches

The approach most often compared to HitL is **post-hoc review**: the agent executes first, then a human reviews the logs and rolls back if something is wrong. This approach is superior in throughput, but it cannot be applied to irreversible actions such as sending email or processing payments. HitL, on the other hand, guarantees review before execution and is therefore better suited for regulatory compliance and audit requirements. Another alternative is an **automatic rollback mechanism**: wrap all agent actions in transactions and auto-recover on failure. This works well for database operations, but is hard to apply when there are no transaction semantics — for example, sending email or calling external APIs.

```diagram
en/2026-10-05-5c88b64b-06
```

The right order is: first assess irreversibility and rollback feasibility, then choose the appropriate intervention strategy.

### When to Choose HitL

Not every agent needs HitL. There are three main situations where it is the right choice. First, **regulated environments**: in finance, healthcare, and law, a human review record for certain actions is a legal requirement. Second, **early deployment**: when an agent's reliability has not been sufficiently validated, approval gates create a feedback loop for catching mistakes and improving the agent. Third, **high cost of mistakes**: when the cost of an error — bulk data deletion, mass email sending, large transactions — far exceeds the benefit of automation, HitL is the rational choice.

---

## Considerations for Production Deployment

### Common Mistakes and Pitfalls

The most frequent problem when first introducing HitL is **state loss**. Using `interrupt` without a checkpointer configured means all state waiting for approval disappears when the process restarts. In production, always use a persistent storage backend (PostgreSQL, Redis) for the checkpointer. The second pitfall is **duplicate execution**. When a resume signal is delivered more than once due to a network issue, you need idempotency guarantees to prevent the same action from executing twice. Include a unique execution ID in the `thread_id` and add logic that detects attempts to resume an already-completed execution. The third problem is **insufficient approval context**. If the approval request message does not give the reviewer enough information to make a judgment, the review degenerates into a rubber-stamp process where the reviewer always approves or always rejects.

```diagram
en/2026-10-05-5c88b64b-07
```

Duplicate-resume prevention and state validity checks are the minimum conditions for guaranteeing idempotency in production.

### Monitoring and Debugging

The metrics to monitor in an agent pipeline that includes HitL differ from those for a typical service. Beyond response time and throughput, you need to track **the number of instances waiting for approval**, **average approval wait time**, **approval rate vs. rejection rate**, and **timeout frequency**. A sudden drop in approval rate can be a signal that the agent has started producing actions that deviate from what reviewers expect. Frequent timeouts call for a review of the escalation policy. Integrating an agent tracing tool such as LangSmith lets you visually inspect the full execution path, interruption points, and resume history for each `thread_id`, which substantially reduces debugging time.

| Metric | Normal range | Warning signal | Response |
|---|---|---|---|
| Instances waiting for approval | Stable | Sharp increase | Check for processing bottleneck or notification errors |
| Average approval wait time | Within SLA | Exceeds SLA | Reconfigure escalation policy |
| Approval rate | 80%+ | Below 50% | Review agent action quality |
| Timeout frequency | Under 5% per month | Over 20% per month | Check approver notification channel |

### Scaling and Migration

You need to design upfront for how to scale the HitL system as the number of agents and workflow complexity grows. A structure where a single person handles all approvals becomes a bottleneck, so establish a **routing policy** that distributes approval responsibilities based on workflow type or scope of impact. For action types where data has proven the agent reliable enough, apply a **progressive automation** strategy that gradually removes HitL gates. To do this, include a feedback loop in the design from the start that records both the approval decision and the actual outcome. Being able to review after the fact whether a rejected action was genuinely wrong or an over-rejection is what enables an objective assessment of the agent's reliability.

```diagram
en/2026-10-05-5c88b64b-08
```

The more approval history data accumulates, the stronger the evidence base for deciding which action types the agent can be trusted with.

---

## Closing Thoughts

### Key Takeaways

This post examined how to structurally embed Human-in-the-Loop into AI agent automation pipelines. The technical core of HitL is **state checkpointing and an external-event-driven resume mechanism**. LangGraph's `interrupt` combined with a checkpointer is the practical way to achieve this. Approval patterns fall into three types — inline gate, dynamic gate, and multi-level approval — and you choose the right one based on the action's irreversibility and scope of impact. In production, the key management concerns are preventing state loss, blocking duplicate executions, defining an escalation policy, and monitoring approval quality.

### Decision Criteria

The first question to ask when considering HitL is: "Can we undo it if the agent makes a mistake?" If the answer is no, and if the cost of that mistake significantly outweighs the benefit of automation, then HitL is not optional — it is required. Conversely, putting approval gates on low-risk repetitive tasks where the agent's reliability is already well-established undermines the very benefits of automation. Good HitL design comes from the balance of intervening as little as possible while making intervention certain whenever it is truly needed. That balance point should be continuously adjusted as the agent matures and operational data accumulates.
