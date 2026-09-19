---
title: "What Is LangGraph, Explained Simply"
date: "2026-09-18 13:40"
category: "AI"
tags: ["LangGraph", "AI agent", "LangChain", "workflow", "state management"]
excerpt: "LangGraph is an orchestration library that ties multiple LLM calls together as a graph — not a model, not a framework, but a progress manager that remembers where you are."
koSlug: "2026-09-18-쉽게-풀어쓰는-LangGraph란-무엇인가"
---

## Table of Contents

1. Overview
2. Why chains fall short
3. The three building blocks: state, nodes, and edges
4. The most common shape: a tool-using agent
5. What you get for free by using a graph
6. When to use it and when not to
7. Closing thoughts

---

## Overview

### LangGraph in one sentence

LangGraph is an **orchestration library that ties multiple LLM calls together and runs them as a graph**. It is not a new model, and it is not a framework that replaces LangChain. The LangChain team released it in 2024. When you are building an AI feature that goes through several steps, it acts as a **progress manager** that remembers "how far we have gotten and what we have learned so far" and decides what to do next.

Think of the difference between a recipe and a chef. A recipe just runs from step 1 to step 5 in order and that's it, but a chef tastes halfway through, adds more salt if it's bland, and tastes again. The chef might repeat the same step twice, or take a different route if an ingredient is missing. LangGraph is a tool for expressing the latter in code.

```diagram
en/langgraph-basics-role
```

LangGraph does not stand in for the LLM. It sits between the LLM and the tools, carrying everything accumulated so far and deciding whose turn it is next.

This post is about building the mental model. State schema design, multi-agent composition, and production concerns are covered in the follow-up: [LangGraph State-Based Multi-Agent Workflow Implementation](/posts/2026-09-18-LangGraph-%EC%83%81%ED%83%9C-%EA%B8%B0%EB%B0%98-%EB%A9%80%ED%8B%B0%EC%97%90%EC%9D%B4%EC%A0%84%ED%8A%B8-%EC%9B%8C%ED%81%AC%ED%94%8C%EB%A1%9C%EC%9A%B0-%EA%B5%AC%ED%98%84).

---

## Why chains fall short

### A pipeline laid out in a straight line

The most natural structure when you first build an LLM application is a pipeline laid out in a straight line. Take a question, retrieve documents, stuff the results into a prompt, call the model, clean up the answer, and return it. LangChain's chain (LCEL) expresses this shape very concisely.

```python
# A chain that flows in one direction — start and end are fixed
chain = retriever | prompt | llm | parser
answer = chain.invoke("What is the refund policy?")
```

This structure is the best choice when the steps are fixed and there is no need to go back. It is easy to read and there are few places to debug.

### Three requirements you hit in practice

The problem surfaces when real requirements don't fit in a straight line. Three things come up frequently.

The first is **branching**. If the user's question is a simple greeting you should skip the retrieval and answer immediately; if it's a question about internal policy you need to find a document. The second is **iteration**. If the retrieval results are poor you need to rephrase the query and search again; if generated code fails to run you need to read the error message and fix it. The third is **pause and resume**. For a high-value transaction a human needs to review it before you continue.

None of this is impossible inside a chain. You can write it in Python by mixing in `if` and `while`. The problem is that the flow ends up scattered across the code, and where to carry the accumulated conversation history, retrieved documents, and retry count gets decided ad hoc each time. As the number of steps grows, this orchestration code ends up thicker than the business logic it is supposed to serve.

| Required flow | With a chain | With a graph |
|---|---|---|
| Different path depending on condition | Stack `if` branches at the call site | Declare one conditional edge |
| Retry until it works | Manage a `while` loop and counter manually | An edge that loops back to the node |
| Human review in the middle | Split execution and save state manually | Pause at a checkpoint, then resume |
| Keeping track of progress | Carry it in variables | Collected in one place: State |

The core of LangGraph is making you write that flow in **one place — the graph definition** — instead of all over the code.

---

## The three building blocks: state, nodes, and edges

### State: the shared working notes

State is the bundle of data the graph carries with it throughout a run. The conversation so far, retrieved documents, how many times something has been retried — all of that goes here. Every step reads from this notepad and writes its portion back.

```python
from typing import Annotated, TypedDict
from operator import add

class State(TypedDict):
    question: str
    messages: Annotated[list, add]  # appended, not overwritten
    documents: list
    retry: int
```

`Annotated[list, add]` is the LangGraph-specific part. Each step returns only the values it changed, and **how to merge** those values back into the existing state is determined by the state definition itself. Values that should accumulate, like conversation history, get appended; values where only the latest matters, like retry count, get overwritten. Because the merge strategy is pinned up front, problems like "who cleared this value" become rarer as the number of steps grows.

### Node: the work of one step

A node is a plain function that receives the state and returns the parts that changed. One node per step: a node that calls the LLM, a node that retrieves documents, a node that formats results. No special class to inherit — a single function is a node.

```python
def retrieve(state: State) -> dict:
    docs = vectorstore.similarity_search(state["question"], k=4)
    return {"documents": docs}  # return only what changed
```

### Edge: where to go next

An edge is an arrow connecting one node to another. There are regular edges that always go to the same place, and **conditional edges** that inspect the state and choose a destination. The latter is where the split from chains happens.

```python
def should_retry(state: State) -> str:
    if not state["documents"] and state["retry"] < 2:
        return "rewrite"   # rephrase the query and search again
    return "generate"      # proceed to answer generation

graph.add_conditional_edges("retrieve", should_retry)
```

Put the three together and you have a graph. The diagram below shows the most common shape: if retrieval comes up short, rewrite the query and search again.

```diagram
en/langgraph-basics-retry-loop
```

There is exactly one thing chains don't have: an arrow that goes back to `retrieve` — a **cycle**. If you had to name one reason LangGraph exists, it is that arrow.

---

## The most common shape: a tool-using agent

### Think, act, think again

The graph you encounter most in practice is "the model uses tools." You give the model a list of tools — search, a calculator, an internal API — and instead of answering immediately the model responds with "please call this tool like this." The graph executes that tool, appends the result to the state, and passes it back to the model. When the model stops requesting tools, the run ends.

```diagram
en/langgraph-basics-tool-loop
```

The whole thing is that the model and tools can go around the loop several times. This simple loop is what "an agent that looks things up and answers" actually is.

### The code is shorter than you'd expect

The code that assembles a graph is briefer than you might think. Define the state, register the nodes, connect the edges, call `compile()`, and you get a runnable object.

```python
from langgraph.graph import StateGraph, START, END

builder = StateGraph(State)
builder.add_node("agent", call_model)
builder.add_node("tools", run_tools)

builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", needs_tool, {"yes": "tools", "no": END})
builder.add_edge("tools", "agent")   # the arrow that loops back

app = builder.compile()
app.invoke({"question": "How many refunds were there last month?", "messages": [], "retry": 0})
```

For a simple agent you don't even have to write this every time. LangGraph provides prebuilt functions like `create_react_agent` that produce exactly this shape, and you drop down to assembling it manually when you need to customize the flow.

---

## What you get for free by using a graph

When you declare your flow as a graph and collect state in one place, several capabilities follow naturally from that structure. At the concept-building stage, knowing this list is enough.

| Feature | What it is | When it's useful |
|---|---|---|
| Checkpointing | Saves state after every step | Resume from that point even if interrupted |
| Human-in-the-loop (HITL) | Pauses before a specific node | Irreversible operations like payment or shipping |
| Streaming | Emits intermediate results step by step | Progress indicators like "searching..." |
| Time travel | Restart from a past state | Reproduce and compare with a different prompt |
| Memory | Persists state per thread | Multi-turn conversations |

Checkpointing in particular is awkward to build without the graph structure. Because state is defined as one cohesive unit at every step, saving that unit and restoring it later happens naturally.

---

## When to use it and when not to

### Cases where you don't need it

LangGraph is not free. Defining a state schema, splitting things into nodes, and connecting edges adds code and concepts. Wrapping a single-call summarization, classification, or translation feature in a graph adds complexity with no benefit. A basic RAG that does one retrieval and one generation is usually fine as a chain.

### Cases where it pays off

When branching and iteration enter the picture the calculus flips. If two or more of the following apply, going with a graph is generally the better call.

```diagram
en/langgraph-basics-when
```

### Three common misconceptions

**"You have to learn all of LangChain first"** — No. LangGraph works without LangChain, and it doesn't care which SDK you use to call the model inside a node. That said, there are places where LangChain's common building blocks — message types, tool definitions — make things easier.

**"It's a tool for building agents"** — Half right. It fits well for agents with cycles, but it is equally useful for assembling general workflows that branch out and merge back together without a cycle. It is actually used frequently in the opposite direction: giving the model less freedom and locking down paths explicitly.

**"You need LangSmith or the cloud platform"** — No. The library itself is a single Python package and works entirely locally. The tracing and deployment products are separate offerings from the same team.

---

## Closing thoughts

### Key takeaways

LangGraph is an orchestration library that ties multiple LLM calls together and runs them as a graph. It comes down to three things: **state** to carry progress, **nodes** to handle one step of work, and **edges** to decide where to go next — plus cycles, which chains don't have. The main value is collecting conditional paths and retry loops into one place — the graph definition — instead of spreading `if` and `while` across the codebase.

### Decision guide

| Situation | Is LangGraph a fit? | Reason |
|---|---|---|
| Single-call summarization or classification | Overkill | One chain line is enough |
| Basic RAG: one retrieval + one generation | Usually overkill | No branching or iteration |
| RAG that retries when results are poor | Good fit | Needs a cycle |
| Agent that picks and uses tools | Good fit | Model ↔ tool loop is the basic shape |
| Business automation with human approval | Good fit | Checkpoint to pause and resume |

Once the concepts are clear, the next step is how to split state schemas and how to connect multiple agents. That's covered in [LangGraph State-Based Multi-Agent Workflow Implementation](/posts/2026-09-18-LangGraph-%EC%83%81%ED%83%9C-%EA%B8%B0%EB%B0%98-%EB%A9%80%ED%8B%B0%EC%97%90%EC%9D%B4%EC%A0%84%ED%8A%B8-%EC%9B%8C%ED%81%AC%ED%94%8C%EB%A1%9C%EC%9A%B0-%EA%B5%AC%ED%98%84).

### References

- [LangGraph official documentation](https://langchain-ai.github.io/langgraph/)
- [LangGraph GitHub repository](https://github.com/langchain-ai/langgraph)
- [LangGraph conceptual guide — Low-level concepts](https://langchain-ai.github.io/langgraph/concepts/low_level/)
