---
title: "LLM Agent Evals Design — Trace-Based Evaluation and Automated Pipelines"
date: "2026-10-08 02:18"
category: "AI"
tags: ["LLM Evals", "agent evaluation", "trace-based evaluation", "automated test pipeline", "RAG"]
excerpt: "How to design a trace-based evaluation system for non-deterministic LLM agents and wire it into a CI/CD quality gate."
koSlug: "2026-10-08-LLM-에이전트-Evals-설계-—-트레이스-기반-평가와-자동화-파이프라인"
---

## Table of Contents

1. Overview
2. Core Concepts of LLM Agent Evals
3. Designing Trace-Based Evaluation
4. Building an Automated Test Pipeline
5. Metric Design and Trade-offs
6. Considerations for Production
7. Closing

---

## Overview

### The Problem: Quality Assurance for Non-Deterministic Systems

**LLM agent evals** go beyond evaluating simple chatbot responses. They are a methodology for systematically validating an entire agent system where tool calls, memory lookups, and external API integrations are all intertwined. Teams that have deployed agents in real projects consistently run into the same problem: "We upgraded the model and something changed in an unexpected place." After reading this post you will understand how to design a trace-based evaluation framework and connect it to an automated pipeline.

What makes an agent system different from a plain API call is the **diversity of reasoning paths**. For the same user query, an agent might pick different tools, gather information in a different order, or produce its final response from a different context. That non-determinism is what makes agents powerful, and it is also the root cause of why quality assurance is hard. Tests that compare only the final output cannot answer "why did the correct result appear?" or "will the correct result appear next time?"

### Limits of Existing Approaches

Traditional software quality assurance methodologies assume deterministic input-output behavior. Applying rule-based tests to LLM-based systems reveals three problems. First, **brittleness**: a model version change alone can produce output that is semantically identical but worded differently, causing tests to fail. Second, **incomplete coverage**: you cannot verify which tool the agent called and why, or whether intermediate reasoning steps were correct. Third, **unscalable manual review**: as agent capabilities grow, the number of cases a human must manually inspect grows exponentially.

**Trace-based evaluation** addresses all three problems at once by recording every step an agent executes as structured data. Because it targets the reasoning path itself rather than the final output, a response passes if the meaning is equivalent even when the wording differs, and if the path changes you can analyze it in detail.

```diagram
en/2026-10-08-e1ceba89-01
```

Rule-based tests are vulnerable to output variation, but trace-based evaluation targets the reasoning path itself and provides a fundamentally different kind of reliability.

---

## Core Concepts of LLM Agent Evals

### Evaluation Hierarchy and Feedback Loops

The most effective way to understand LLM agent evals is through a three-level structure: **unit, integration, and system**. **Unit eval** isolates a single prompt template or a single tool-call logic block and verifies it. It checks whether the agent selects the correct tool in a given context, extracts parameters accurately, and produces output that conforms to the expected schema. **Integration eval** covers scenarios where two or more components connect. It targets things like whether retrieval results in a RAG pipeline are actually used correctly in the answer, or whether a tool chain executes in the right order. **System eval** reproduces real user scenarios end-to-end and measures overall quality.

The core reason to keep these levels distinct is that **the speed and cost of feedback loops** are fundamentally different. Unit evals can process hundreds of cases in seconds when run with mocks and no LLM calls. System evals call a real LLM and take seconds to tens of seconds per case. The efficient pattern is to require unit and integration evals to pass first in the CI/CD pipeline, then use system evals as the final approval gate before deployment. You cannot substitute one level for another. Unit evals alone miss interaction problems between components; system evals alone make it hard to isolate which step caused the problem.

```diagram
en/2026-10-08-e1ceba89-02
```

Lower levels are faster and cheaper; higher levels are closer to reality. You need both axes to build a complete evaluation framework.

### What Is a Trace?

A **trace** is a structured record of every action an agent takes while processing a single request. Each step is captured as a unit called a **span**, which contains a timestamp, input, output, error information, tool name, token usage, and more. Conceptually this is identical to OpenTelemetry tracing in distributed systems; in the LLM ecosystem, tools like **LangSmith**, **Arize Phoenix**, and **Weights & Biases Weave** serve this role.

What makes a trace fundamentally different from a plain log is its **hierarchical structure**. When you model the entire agent execution as a root span and each individual LLM call, tool execution, and retrieval query as child spans, you can analyze hierarchically how long each step took and which span caused an error. This structured data is the source material for automated evaluation.

```diagram
en/2026-10-08-e1ceba89-03
```

LLM calls and tool calls are connected hierarchically under the root span, so you can see at a glance which step is a bottleneck or the source of an error.

### Evaluator Types and Combination Strategy

In evals, an **evaluator** is a function that receives a trace or final output and returns a score or label. Choosing the wrong evaluator type leads to wasted cost or lost reliability, so you need a clear understanding of each type. **Rule-based evaluators** quickly and reliably verify structural properties such as JSON schema compliance, field existence, and tool call count. **Model-based evaluators (LLM-as-Judge)** use a language model to assess subjective quality like factuality, relevance, and harmfulness. Combining both types is the practical approach. Filtering obvious failures fast with rule-based evaluators and then assessing subtle quality differences with model-based evaluators lets you optimize cost and accuracy at the same time.

| Evaluator type | Speed | Cost | Strength | When to use |
|---|---|---|---|---|
| Rule-based | Very fast | Low | High reliability for structural checks | Schema, format, field existence |
| LLM-as-Judge | Moderate | Medium–high | Well-suited for semantic and quality evaluation | Relevance, factuality, harmfulness |
| Human evaluation | Slow | High | Most trustworthy ground truth | Establishing baselines, ambiguous edge cases |

---

## Designing Trace-Based Evaluation

### Trace Collection Strategy

How you collect traces depends on your agent framework, but the universal principle is to **keep instrumentation separate from business logic**. Scattering logging calls directly throughout agent code hurts readability and forces you to touch business logic every time the collection strategy changes. Decorator or context-manager patterns let you inject collection logic transparently.

Following the **OpenTelemetry** standard for instrumentation is increasingly important. It avoids vendor lock-in to any particular observability tool and lets you route collected traces to multiple backends. With LangChain, setting the `LANGCHAIN_TRACING_V2=true` environment variable is all you need to start sending traces to LangSmith automatically. For a custom agent, instrumenting directly with `opentelemetry-sdk` is the most flexible approach.

```diagram
en/2026-10-08-e1ceba89-04
```

The instrumentation layer mediates between the agent code and the collection backend, so you can swap backends without touching agent code at all.

Below is an example of injecting OpenTelemetry-based traces into a custom Python agent. A decorator makes each method on the agent class record itself as an individual span.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from functools import wraps

# Initialize the tracer
provider = TracerProvider()
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint="http://localhost:4317"))
)
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("agent.eval")

def traced(span_name: str):
    """Decorator that transparently injects a trace into an agent method."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            with tracer.start_as_current_span(span_name) as span:
                if kwargs.get("query"):
                    span.set_attribute("input.query", str(kwargs["query"]))
                try:
                    result = func(*args, **kwargs)
                    span.set_attribute("output.result", str(result)[:500])
                    return result
                except Exception as e:
                    span.record_exception(e)  # Capture errors automatically
                    raise
        return wrapper
    return decorator

class ResearchAgent:
    @traced("agent.search")
    def search(self, query: str) -> list[dict]:
        return search_tool(query)  # Result: [{"title": "...", "content": "..."}]

    @traced("agent.synthesize")
    def synthesize(self, context: list[dict], query: str) -> str:
        return llm.invoke(f"Context: {context}\nQuestion: {query}")
        # Result: generated response string; up to 500 characters recorded in the span
```

The key advantage of the decorator approach is that you can inject traces into every method call without touching any business logic. The input and output data recorded via `span.set_attribute` becomes the source data that automated evaluators read later.

### Span Design Principles

Good traces determine the quality of downstream evaluation automation. There are three core principles to follow in span design. First, **set meaningful boundaries**: a span should correspond to a semantically independent unit of work. A name like "classify user intent" that exposes business context is far more useful for evaluation than simply "LLM call." Second, **include enough context**: record the input, output, model used, token count, and execution time so that an evaluator can judge whether the step was correct just from the span alone. Third, **mask sensitive information**: put a filtering layer at the collection stage so that user PII or business secrets are not stored in plain text in the trace store.

The most common span design mistake is going too fine-grained or too coarse. Creating spans at the token level creates excessive noise; wrapping the entire agent execution in a single span makes it impossible to know which step caused the problem. Empirically, "one external system call or one LLM reasoning step" is the right unit for a span.

> For span boundaries, asking "can I slice out just this step and evaluate it later?" almost always gives you the right answer.

---

## Building an Automated Test Pipeline

### Eval Dataset Management

The foundation of automated evals is the **eval dataset**. A dataset consists of input cases, expected behaviors, and reference answers where available. Dataset quality directly determines evaluation reliability, so how you compose it deserves careful thought. Three sources work well together. First, **golden cases**: representative scenarios reviewed by domain experts, forming the core of regression testing. These are manually curated cases that the agent must handle correctly without exception. Second, **production sampling**: selecting representative cases from traces collected in live operation. They reflect real usage patterns and fill in the diversity that golden cases miss. Third, **edge case generation**: using an LLM to automatically generate boundary conditions and failure-prone scenarios. Particularly useful for verifying how the agent handles adversarial inputs or incomplete queries.

Dataset version control is also mandatory. As the agent system evolves, evaluation criteria change too, so you need to track dataset change history alongside code in git or use a dedicated dataset registry. If evaluation criteria and datasets fall out of sync, fair comparison with past models becomes impossible and it gets hard to tell whether a score improvement reflects genuine quality gains or relaxed evaluation standards.

```diagram
en/2026-10-08-e1ceba89-05
```

The three sources complement each other to populate the dataset, and version control ensures reproducibility and fair model comparisons.

### CI/CD Integration

Integrating evals into the CI/CD pipeline so that agent code changes cannot silently break existing behavior is the core of operational automation. The ideal structure runs unit and integration evals automatically whenever a PR is opened and blocks merging if scores drop below a threshold. The **synchronous pattern** runs evaluations during the CI stage and waits for results. Because evals that include LLM calls take a long time, the practical approach is to handle only unit evals synchronously and process integration and system evals asynchronously. The **asynchronous pattern** evaluates production traces collected after a deployment has been live for a while to detect regressions.

Below is an example of the core logic in an evaluation pipeline. It propagates the evaluation score to the CI exit code to block merges automatically.

```python
# eval_pipeline.py — evaluation pipeline executed in CI
import json
from pathlib import Path
from evaluators import ToolSelectionEvaluator, ResponseQualityEvaluator
from agent import ResearchAgent

def run_eval(dataset_path: str, threshold: float = 0.8) -> dict:
    dataset = json.loads(Path(dataset_path).read_text())
    agent = ResearchAgent()
    evaluators = [
        ToolSelectionEvaluator(),      # Evaluates tool selection accuracy
        ResponseQualityEvaluator(),    # LLM-as-Judge quality evaluation
    ]

    results = []
    for case in dataset["cases"]:
        trace = agent.run_with_trace(case["input"])  # Run with trace included
        scores = {
            ev.__class__.__name__: ev.evaluate(trace, case.get("expected"))
            for ev in evaluators
        }
        results.append({"case_id": case["id"], "scores": scores})

    avg_scores = {
        key: sum(r["scores"][key] for r in results) / len(results)
        for key in results[0]["scores"]
    }
    # Result: {"ToolSelectionEvaluator": 0.91, "ResponseQualityEvaluator": 0.84}

    passed = all(v >= threshold for v in avg_scores.values())
    return {"passed": passed, "avg_scores": avg_scores, "details": results}

if __name__ == "__main__":
    result = run_eval("datasets/golden_cases.json")
    print(json.dumps(result, indent=2))
    exit(0 if result["passed"] else 1)  # Quality gate via CI exit code
```

The reason the `exit(0 if result["passed"] else 1)` pattern matters is that it propagates evaluation failure as a real CI pipeline error, which automatically blocks merging. Simply printing a log is not enough to make an automated quality gate work.

### Regression Detection and Alerting

The ultimate goal of an automated pipeline is to **detect quality regressions before deployment**. This requires storing baseline scores separately and comparing new run results against them statistically. Comparing only against a fixed threshold tends to miss a slow decline hovering just above the threshold. Applying **statistical significance tests (t-test, Mann-Whitney U)** or **moving-average anomaly detection** lets you reliably catch even small regressions. When a regression is confirmed, send an immediate alert via Slack or PagerDuty and block the change from merging so quality problems cannot flow into production.

```diagram
en/2026-10-08-e1ceba89-06
```

When a regression is detected, merging is blocked; when the check passes, the baseline is updated so scores trend upward over time.

---

## Metric Design and Trade-offs

### Tool Call Accuracy

One of the most intuitive metrics in agent evaluation is **tool call accuracy**: did the agent select the right tool for the given user intent, and did it extract tool parameters correctly? This metric matters because a wrong tool selection causes cascading failures. If the agent calls a calculation tool instead of a search tool, every subsequent piece of reasoning is built on the wrong premise.

There are two approaches to measuring accuracy. **Exact match** checks whether the expected tool name and parameters match completely. It is fast and unambiguous but brittle — even a slightly different parameter representation counts as an error. **Semantic match** uses an LLM evaluator to judge "is this a semantically equivalent tool call?" It is more flexible but costs more, and you need to verify the consistency of the evaluator itself separately. Rather than picking one, the recommended combination is using exact match to quickly detect clear errors and applying semantic match only to boundary cases.

### Final Response Quality Metrics

Metrics for evaluating the final response depend on what the agent is trying to do. **RAGAS** is an evaluation framework designed specifically for RAG systems. It automatically measures Faithfulness, Answer Relevancy, Context Precision, and Context Recall. These four metrics are complementary but each independently meaningful. Low faithfulness means the agent is ignoring retrieved content and hallucinating. Low context recall means it failed to retrieve the relevant documents in the first place. You need to track all four simultaneously to know where to focus quality improvements.

| Metric | What it measures | When it is low | Caveat |
|---|---|---|---|
| Faithfulness | Is the response grounded in the context? | High risk of hallucination | Even a small error in a long response can pull the score down |
| Answer relevancy | Does the response directly answer the question? | Response has gone off-topic | Hard to distinguish "relevant but incomplete" cases |
| Context precision | Are the retrieved documents useful? | Noisy documents included | Improvable with reranking |
| Context recall | Was the necessary information retrieved? | Information is missing | Sensitive to chunk size and embedding model |

### Designing an LLM-as-Judge

**LLM-as-Judge** is a pattern where a language model evaluates the output of another language model. Multiple studies have confirmed high correlation with human evaluators, and it has become a practical alternative for scalable quality assessment. However, there are biases you must account for in the design. First, **position bias**: the evaluator LLM tends to favor whichever response is presented first when comparing A and B. Running the evaluation twice with the order swapped and averaging the results substantially reduces this bias. Second, **self-enhancement bias**: when the same model family is used as both evaluator and subject, it tends to prefer its own style. Use a strong and diverse model as the evaluator and periodically measure inter-annotator agreement.

```diagram
en/2026-10-08-e1ceba89-07
```

Evaluating twice with the order swapped and averaging the results is the heart of a reliable LLM-as-Judge setup for correcting position bias.

---

## Considerations for Production

### Common Mistakes and Pitfalls

The most common mistake when introducing evals in a real project is **evaluation data leakage**. If the eval dataset is used for fine-tuning or prompt optimization, the agent overfits to the evaluation cases and you end up overestimating real-world performance. To prevent this, isolate the eval dataset in a separate repository that the development team cannot directly access, or at a minimum strictly separate cases used for evaluation from cases used for development.

The second pitfall is the **metric optimization trap (Goodhart's Law)**. If you use a specific evaluation metric as an optimization target, it stops reflecting actual quality. If the agent learns to copy context verbatim to push up its faithfulness score, it generates responses that are not useful to real users. Track multiple metrics together and periodically verify that metric changes remain correlated with actual user satisfaction. The third common mistake is **ignoring evaluation cost**. Applying LLM-as-Judge evaluators to every case without limit can result in evaluation costs exceeding the cost of running the agent service itself. The cost-efficient approach is to filter with rule-based evaluators first and use LLM-as-Judge only for uncertain cases or critical regression detection.

```diagram
en/2026-10-08-e1ceba89-08
```

Filtering clear failures with rule-based evaluators first significantly reduces the number of LLM-as-Judge calls and keeps evaluation costs under control.

### Monitoring and Debugging

Continuously tracking the quality of a production agent requires a **real-time evaluation monitoring** system. Evaluating every trace in real time is unrealistic from both a cost and latency standpoint, so apply statistical sampling. **Stratified sampling** is more effective than random sampling. Assigning higher weight to cases where an error occurred, cases with high response latency, and cases from new user types lets you extract more quality signal for the same evaluation budget.

When debugging, the hierarchical structure of traces is your primary tool. When final response quality is low, starting from the root span and working through child spans in order lets you quickly isolate whether bad information entered at the tool call stage or whether the error occurred in the LLM reasoning step. LangSmith and Arize Phoenix, both of which offer **trace diffing**, display two traces side by side and visually highlight which span differs, which helps you narrow down the cause of a regression quickly.

### Scaling and Migration

As an agent system grows, the evals infrastructure must grow with it. A single pipeline is sufficient at first, but as the number of agents increases and datasets get larger, **parallel eval execution** becomes necessary. Splitting cases into batches and evaluating them simultaneously across multiple workers reduces total runtime linearly. **Eval caching** also matters. Caching LLM-as-Judge results so you do not call the model repeatedly for identical inputs cuts costs significantly, especially in regression tests.

When migrating models — for example, switching from GPT-4 Turbo to Claude 3.5 Sonnet — your existing eval dataset provides the comparison baseline. The safe pattern is an **A/B deployment**: evaluate the new model against the existing dataset to confirm there are no regressions, then gradually shift traffic over. At this stage you need to include the model version as metadata in traces so you can later analyze performance trends per model and use that data to make rollback decisions.

---

## Closing

### Key Takeaways

LLM agent evals are not just a testing tool. They are an engineering system for continuously measuring and improving the quality of an agent system. Trace-based evaluation goes beyond verifying only the final output and makes the path the agent takes to reach its goal transparent. Designing evaluations in a unit-integration-system hierarchy and integrating them into CI/CD lets you detect before deployment the impact that a model upgrade or prompt change has on existing behavior. Combining rule-based evaluators with LLM-as-Judge keeps cost and accuracy balanced, and continuously sampling production traces to reflect real usage patterns is how you operate a reliable agent over the long term.

### When to Invest

If your agent is a single LLM call, unit evals and basic output validation may be enough. If any of the following apply, systematic trace-based eval investment is justified. **When combining multiple tools or performing multi-step reasoning**, tool call accuracy and cascading failure detection become critical. **When you repeatedly upgrade the model version**, without a baseline you cannot track which change affected quality. **When production traffic is high enough that manual quality review is impossible**, without automation there will be gaps in quality assurance. When starting out, begin with 20-50 golden cases and rule-based evaluators, then incrementally add LLM-as-Judge and automatic dataset expansion as the system stabilizes.
