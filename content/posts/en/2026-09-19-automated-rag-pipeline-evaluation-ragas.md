---
title: "Automated RAG Pipeline Quality Evaluation with RAGAS"
date: "2026-09-19 07:09"
category: "AI"
tags: ["RAGAS", "RAG evaluation", "Faithfulness", "LLM-as-Judge", "vector search"]
excerpt: "Learn how RAGAS measures Faithfulness, Context Recall, and Answer Relevancy to pinpoint whether failures in your RAG pipeline come from retrieval or generation."
koSlug: "2026-09-19-RAGAS로-RAG-파이프라인-품질-자동-평가하기"
---

## Table of Contents

1. Overview
2. Understanding the Core RAGAS Metrics
3. Environment Setup and Basic Evaluation Pipeline
4. Faithfulness Deep Dive — Hallucination Detection Mechanism
5. Optimizing Context Recall and Answer Relevancy
6. RAGAS vs. Other Evaluation Tools
7. Considerations for Production Deployment
8. Closing Thoughts

---

## Overview

### Background

A RAG (Retrieval-Augmented Generation) pipeline is a composite system that combines a retrieval stage with a generation stage. Dozens of configuration variables — chunk size, embedding model, retrieval strategy, Top-k value, prompt structure, and more — all affect the quality of the final answer, and it is hard to judge which combination is best by intuition alone. **RAGAS** (Retrieval-Augmented Generation Assessment) is an evaluation framework that decomposes this complex pipeline into quantitative metrics so you can measure the quality of each stage independently. It quantifies generation fidelity, retrieval completeness, and answer relevance through three metrics — Faithfulness, Context Recall, and Answer Relevancy — letting you quickly isolate whether the bottleneck lies in retrieval or generation.

### Limitations of Existing Approaches

Evaluating RAG quality with manual labeling or BM25-based keyword matching runs into two fundamental problems. First, human evaluators are hard to keep consistent, expensive, and slow to re-evaluate whenever the pipeline changes at scale. If every swap of chunk size or embedding model requires a human to review hundreds of samples again, the pace of experimentation drops sharply. Second, token-overlap metrics (BLEU, ROUGE) tend to score semantically equivalent but differently phrased answers poorly, so they do not accurately reflect the quality of natural-language answers produced by LLMs. RAGAS adopts the **LLM-as-Judge** paradigm to automate evaluation at the semantic level. Using an LLM for evaluation ties evaluation cost to inference cost — a real downside — but the ability to plug it into a CI/CD pipeline and run regression tests on every model or chunk configuration change has driven rapid adoption in real projects.

```diagram
en/2026-09-19-10770688-01
```

RAGAS evaluation separates the retrieval and generation stages and measures each stage's quality contribution independently.

---

## Understanding the Core RAGAS Metrics

### Faithfulness — Hallucination Detection in the Generation Stage

**Faithfulness** measures whether the generated answer is grounded solely in the retrieved context. The calculation is not a simple similarity score. RAGAS first decomposes the answer into atomic claims, then has an LLM decide whether each claim is logically supported by the context. The final score is `number of supported claims / total number of claims`. This means a fluent, plausible-sounding answer will score low if it contains facts not present in the context.

This matters because the dominant RAG hallucination pattern is "retrieval succeeded but the model ignored the context and used its pretrained knowledge instead." Hallucinations can occur in the generation stage even when retrieval is working correctly, and the Faithfulness metric isolates those two stages to pinpoint the problem precisely. Conversely, if the context itself contains errors and the model faithfully follows them, Faithfulness will score high — so you always need to interpret the score alongside data collection and cleaning quality.

| Scenario | Context Recall | Faithfulness | Interpretation |
|---|---|---|---|
| Retrieval succeeded, model uses context | High | High | Normal operation |
| Retrieval succeeded, model uses pretrained knowledge | High | Low | Generation stage problem |
| Retrieval failed, model uses only context | Low | High | Retrieval stage problem |
| Retrieval failed, hallucination occurred | Low | Low | Full pipeline review needed |

### Context Recall — Completeness of the Retrieval Stage

**Context Recall** measures how much of the information needed to construct the ground truth answer is actually present in the retrieved context. RAGAS splits the ground truth into individual sentences, then determines whether each sentence can be inductively explained by the retrieved context. The final score is `number of attributable sentences / total ground truth sentences`.

A low Context Recall usually means the embedding model is missing semantically important chunks, or the chunk size is too small and the relevant information is spread across multiple chunks. Conversely, if Context Recall is high but final answer quality is still low, the problem is in the generation stage. Without this metric it is hard to distinguish between the two stages, which leads to optimizing in the wrong direction. For multi-hop questions in particular — questions that require combining information across multiple documents — Context Recall provides far more precise retrieval quality measurement than simple keyword matching.

```diagram
en/2026-09-19-10770688-02
```

Context Recall shows numerically whether the retrieval stage "fetched enough material to construct the answer."

### Answer Relevancy — Semantic Alignment Between Question and Answer

**Answer Relevancy** measures whether the generated answer actually addresses the user's question. Interestingly, this metric is computed without a ground truth. RAGAS takes a reverse approach: it generates N candidate questions from the generated answer, then averages the cosine similarity between each candidate question and the original question. The more faithfully the answer addresses the question, the more the reverse-generated questions resemble the original.

Because this approach measures alignment in semantic space rather than by direct comparison, it effectively catches answers that are evasive, verbose, or only partially address the question. However, an answer can score high even if it is completely wrong, as long as it covers the same topic as the question — so this metric must always be interpreted alongside Faithfulness. Answer Relevancy alone does not guarantee accuracy.

---

## Environment Setup and Basic Evaluation Pipeline

### Dataset Structure and Dependencies

RAGAS evaluation requires four data fields: the question (`question`), the generated answer (`answer`), the list of retrieved contexts (`contexts`), and the ground truth (`ground_truth`). `ground_truth` is only used for computing Context Recall, so it can be omitted if you are only measuring Faithfulness and Answer Relevancy. The evaluation dataset should be a direct recording of the actual inputs and outputs processed by your RAG pipeline. Including only artificially crafted ideal queries creates a gap from real usage patterns and lowers the reliability of evaluation results. Aim for a minimum of 50 questions covering a variety of types (factual, comparative, multi-hop, opinion-seeking).

```python
from ragas import evaluate
from ragas.metrics import faithfulness, context_recall, answer_relevancy
from datasets import Dataset

# Build the evaluation dataset — fill in actual RAG pipeline output
data = {
    "question": [
        "How is Faithfulness calculated in RAGAS?",
        "How does context window size affect answer quality?",
    ],
    "answer": [
        "Faithfulness is calculated as the proportion of claims in the answer that are supported by the context.",
        "A larger context window includes more information but also introduces more irrelevant noise.",
    ],
    "contexts": [
        ["RAGAS decomposes the answer into atomic claims and determines whether each is supported by the context."],
        ["Context size determines the trade-off between retrieval precision and recall."],
    ],
    "ground_truth": [
        "Faithfulness = number of supported claims / total number of claims",
        "A larger window increases recall but may decrease precision.",
    ],
}

dataset = Dataset.from_dict(data)

# Default LLM: gpt-4o-mini; evaluate all three metrics in one pass
result = evaluate(
    dataset=dataset,
    metrics=[faithfulness, context_recall, answer_relevancy],
)

print(result)
# Output: {'faithfulness': 0.92, 'context_recall': 0.88, 'answer_relevancy': 0.85}
```

All three metrics are scored on a 0–1 scale, and 0.8 or above is generally considered acceptable. In practice, tracking the delta before and after a change is more useful than chasing absolute values.

### Custom LLM Integration

By default RAGAS uses the OpenAI GPT family as its evaluation LLM, but you can swap in a different model for cost or data-security reasons. Implementing LangChain's `BaseChatModel` interface connects any model. One important caveat when swapping the evaluation LLM: the score baseline shifts. Using GPT-4o-mini and Claude Haiku as evaluation LLMs on the same pipeline can produce different absolute scores, so within a single project you must keep the evaluation LLM consistent.

```python
from ragas.llms import LangchainLLMWrapper
from langchain_anthropic import ChatAnthropic
from ragas.embeddings import LangchainEmbeddingsWrapper
from langchain_openai import OpenAIEmbeddings

# Replace the evaluation LLM with Claude Haiku — effective for cost reduction
claude_llm = LangchainLLMWrapper(
    ChatAnthropic(model="claude-3-5-haiku-20241022")
)
embeddings = LangchainEmbeddingsWrapper(
    OpenAIEmbeddings(model="text-embedding-3-small")
)

# Inject the custom LLM into each metric
faithfulness.llm = claude_llm
context_recall.llm = claude_llm
answer_relevancy.llm = claude_llm
answer_relevancy.embeddings = embeddings  # Required for reverse-question similarity

result = evaluate(dataset=dataset, metrics=[faithfulness, context_recall, answer_relevancy])
# Output: {'faithfulness': 0.90, 'context_recall': 0.87, 'answer_relevancy': 0.84}
```

The Claude Haiku family has similar evaluation cost to GPT-4o-mini and tends to decompose Korean text at higher quality, making it one of the better choices for Korean-language RAG evaluation.

### Interpreting and Visualizing Results

```diagram
en/2026-09-19-10770688-03
```

In the RAGAS evaluation flow, the LLM and embedding model are swappable dependencies; the choice affects both cost and accuracy.

Calling `result.to_pandas()` lets you inspect per-question scores. Filtering for low-scoring samples and analyzing pipeline failure patterns is an efficient next step. For example, extracting samples where Faithfulness is below 0.5 gives you a concrete picture of which question types cause the model to stray from the context.

---

## Faithfulness Deep Dive — Hallucination Detection Mechanism

### The Atomic Claim Decomposition Process

The core of the Faithfulness calculation is **Atomic Claim Decomposition**. An LLM breaks a single sentence like "A is B and C is D" into "A is B" and "C is D." This decomposition is necessary to catch cases where only part of a compound sentence is a hallucination. Each decomposed claim is then evaluated for whether it can be logically derived from the context, with the LLM returning Yes/No in response to a prompt of the form "Does the context support this claim?"

Two common error patterns arise in this process. The first is **under-decomposition**: evaluating a compound claim as a single unit can miss partial hallucinations. For example, in the sentence "X is Y and Y contains Z," if the first clause is in the context but the second is not, grouping them as one claim risks a Yes verdict. The second is **evaluation LLM bias**: the evaluation LLM's own pretrained knowledge may cause it to judge "this is generally known to be true, so I'll count it as supported even if it's not in the context." To prevent this, override the internal prompts for `faithfulness` to more strongly specify "use only evidence found in the provided context."

```diagram
en/2026-09-19-10770688-04
```

Evaluating at the atomic claim level lets you measure the hallucination rate in answers that are "mostly right but partially wrong" with fine granularity.

### Score Interpretation and Domain-Specific Thresholds

Applying a single threshold to Faithfulness scores is risky because acceptable hallucination levels differ by domain. Medical and legal domains may demand 0.95 or above, while 0.80 or above is practically acceptable for general Q&A. A more sophisticated approach is **per-question-type thresholds**: strict for factual questions, somewhat more lenient for opinion and analysis questions.

Also, if Faithfulness scores drop consistently over a period of time, suspect **model drift** before blaming retrieval context quality degradation. When an LLM provider updates a model, the model's context-utilization behavior can change even with the same context and questions.

> If Faithfulness scores drop suddenly, check the history of prompt changes and LLM version updates first. The generation model is more often the cause than the retrieval results.

| Faithfulness Range | Interpretation | Recommended Action |
|---|---|---|
| 0.95 or above | Excellent — almost no hallucination | Keep monitoring |
| 0.85 – 0.95 | Good — minor hallucination | Analyze low-scoring samples |
| 0.70 – 0.85 | Warning — frequent hallucination | Review prompt and context construction |
| Below 0.70 | Danger | Consider redesigning the pipeline |

### Customizing Internal Prompts

RAGAS allows you to replace the internal prompts it uses for atomic claim decomposition and support determination. This is especially useful for Korean-language RAG evaluation, because processing Korean text with the default English prompts tends to produce coarser decomposition units than English. Korean sentence structure — where particles and verb endings are fused to the word — makes the boundaries of atomic claims less clear. You can replace `faithfulness.statement_prompt` with Korean instructions, or add domain-specific term interpretation criteria, to improve evaluation accuracy. Whenever you modify a prompt, compare scores on the same samples before and after to quantify the impact of the change.

---

## Optimizing Context Recall and Answer Relevancy

### Strategies for Improving Context Recall

When Context Recall is low, the first thing to check is your chunking strategy. Simple token-count-based chunking ignores paragraph boundaries, so a single logical unit of information gets split across two chunks. In that case, neither chunk alone is sufficient to support the ground truth answer, which drives Context Recall down. **Semantic chunking** or **Recursive character text splitting** alleviates this, but larger chunk sizes dilute the embedding signal and reduce retrieval precision — a real trade-off. You need to experiment: increase chunk size, observe whether Context Recall rises, and find the inflection point.

The second thing to check is the domain fit of your embedding model. A general-purpose embedding like `text-embedding-3-large` may not represent domain-specific terminology well. For Korean-language domains, models in the `bge-m3` or `multilingual-e5-large` family often achieve higher Context Recall. Swapping the embedding model requires rebuilding the entire index, so run a small-scale evaluation experiment before committing to the change.

```diagram
en/2026-09-19-10770688-05
```

The first fork in improving Context Recall splits between chunk boundary issues and embedding model fit.

### Answer Relevancy and the Incomplete Answer Problem

The most common cause of low Answer Relevancy is an answer that covers only some aspects of the question, or is padded with background information unrelated to the question. RAGAS's reverse-question generation approach is effective at catching this, but for closed questions that can be answered with "yes/no," the variance in reverse-generated questions grows and scores become unstable. Aggregating these short-answer cases separately or assigning them different weights is the pragmatic solution.

To improve Answer Relevancy, the most effective approach is explicitly structuring the system prompt so the model **answers the question first and then adds explanation**. Appending an instruction like "provide the core answer in one sentence first, then explain the reasoning" increases the similarity between reverse-generated questions and the original question. Also, unnecessary disclaimers or sentences like "please consult an expert for more information" reduce topical focus and pull the score down.

| Answer Pattern | Answer Relevancy | Action |
|---|---|---|
| Repeats the question back | Low | Prohibit repetition in prompt |
| Excessive background explanation | Low | Structure to lead with core answer |
| Includes disclaimers/caveats | Low | Add only when necessary |
| Core direct answer + supporting reasoning | High | Recommended pattern |
| Accurate but verbose | Medium | Set a maximum answer length |

### Trade-offs Among the Three Metrics and How to Balance Them

Optimizing all three metrics simultaneously creates tension. Raising Top-k improves Context Recall, but more irrelevant context can confuse the model and lower Faithfulness. Conversely, aggressively filtering context preserves Faithfulness but drops Context Recall. **Reranking** is the standard technique for managing this trade-off: set a large initial Top-k to ensure high Context Recall, then compress down to the most relevant chunks via reranking to improve both metrics simultaneously.

RAGAS provides a **RAGAS Score** that is a simple average of the three metrics, but in practice a weighted average or independently managed per-metric thresholds is more pragmatic depending on domain characteristics. For high-risk domains (medical, legal, financial), weight Faithfulness more heavily; when your focus is on improving the retrieval system, treat Context Recall as the primary metric.

```diagram
en/2026-09-19-10770688-06
```

The direction of pipeline optimization depends on which type of failure is more costly.

---

## RAGAS vs. Other Evaluation Tools

### Differences from TruLens and DeepEval

The RAG evaluation framework market includes **TruLens**, **DeepEval**, and **ARES** alongside RAGAS. The key differences lie in the scope of what is evaluated, how integration works, and operational philosophy. RAGAS is optimized for offline batch evaluation, and its metric implementations are open, so you can inspect exactly which prompts and criteria it uses. That transparency matters especially when you need to explain and justify evaluation results within a team.

**TruLens** excels at experiment tracking and dashboard visualization beyond pure evaluation. It inserts as middleware into LangChain and LlamaIndex pipelines to collect metrics in real time during runtime, making it well-suited for production monitoring scenarios. However, metric customization is more limited than RAGAS, and the heavy dependency on a dashboard can create redundant investment for teams that already have their own monitoring stack.

**DeepEval** offers an interface similar to a software testing framework (pytest), which feels familiar to developers. Defining individual scenarios and setting thresholds the way you would write unit tests makes CI/CD integration intuitive. It has more metric types than RAGAS, but the internal implementation of each metric is less transparent and the community is smaller.

**ARES** is designed for academic research — its metric definitions are rigorous and grounded in published papers — but documentation and community support are insufficient for direct production use. It suits benchmark comparisons in research papers but is a poor fit for product development environments that require rapid iteration.

| Tool | Strengths | Weaknesses | Best For |
|---|---|---|---|
| RAGAS | Metric transparency, easy customization | High evaluation cost | Pipeline development, A/B testing |
| TruLens | Real-time monitoring, visualization | Low metric extensibility | Production runtime tracking |
| DeepEval | pytest-friendly, easy CI integration | Opaque internals | CI/CD regression testing |
| ARES | Academic rigor | Low practicality | Research, benchmark comparison |

### How to Choose an Evaluation Framework

Trying to satisfy every requirement with a single tool is unrealistic. For large-scale services, a practical setup is using RAGAS for offline experiments and pipeline design quality measurement while running TruLens in parallel for production runtime monitoring. Because the two tools implement the same metrics differently, make sure the team explicitly understands that score interpretation baselines differ between the experimentation and production stages.

```diagram
en/2026-09-19-10770688-07
```

TruLens is the right fit for real-time monitoring; RAGAS is the right fit for offline batch evaluation and pipeline improvement.

---

## Considerations for Production Deployment

### Controlling Evaluation Cost

The biggest practical constraint of RAGAS is that evaluation itself generates LLM calls. Evaluating a single question requires multiple LLM calls — atomic claim decomposition, support determination, reverse question generation, and more. Running RAGAS on every query in production can generate evaluation costs several times higher than inference costs. Underestimating this upfront leads to runaway spend.

Three realistic strategies address this. First, **sampling-based evaluation**: evaluate only 5–10% of total queries, selected randomly or via anomaly detection. Anomaly detection means prioritizing for evaluation those queries where the answer length is extremely short or long, or where context similarity scores are low. Second, **use a lightweight model**: swapping GPT-4o for GPT-4o-mini or Claude Haiku as the evaluation LLM cuts cost by 60–80% while mostly preserving inter-metric correlations. Third, **asynchronous batch processing**: instead of evaluating in real time, run a nightly batch to evaluate the previous day's queries and surface results on the next day's dashboard.

```diagram
en/2026-09-19-10770688-08
```

Combining sampling and async processing brings production RAGAS evaluation cost to a practical level.

### Evaluation Dataset Quality and Version Control

The reliability of RAGAS scores is directly tied to ground truth data quality. If ground truths are too short or too abstract, Context Recall computation accumulates false negatives; too verbose and false positives increase. Build your evaluation dataset with at least 50 question-answer pairs and maintain a balanced mix of easy, hard, and multi-hop questions.

You must version-control the evaluation dataset itself. Comparing before and after a pipeline change only produces meaningful deltas when the same dataset is used. When the dataset changes, clearly record the break in continuity with previous scores, and plan updates on at minimum a quarterly schedule. Also periodically review whether the evaluation dataset actually represents the real user query distribution. If a dataset built at service launch no longer reflects changes in user behavior patterns, a high RAGAS score may diverge from actual user satisfaction.

> If ground truth quality is low, a high RAGAS score does not mean the actual pipeline quality is high. Run a meta-evaluation to validate the evaluation pipeline itself on a quarterly basis.

### Korean-Language Specifics

RAGAS's internal prompts are designed around English. When Korean text is fed to the evaluation LLM during Korean RAG evaluation, the atomic claim decomposition step tends to produce coarser decomposition units than it would for English. This is because the boundary of an atomic claim is less clear in Korean sentences, where particles and verb endings are agglutinated to the stem. To compensate, either replace `faithfulness.statement_prompt` with Korean instructions, or consider translating Korean answers into English before evaluation. Note that translation can introduce subtle meaning shifts, so the translation approach requires care.

Answer Relevancy, which relies on embeddings, measures Korean semantic similarity more accurately with a multilingual embedding model (`multilingual-e5-large` or `bge-m3`) than with an English embedding model. Leaving a language mismatch in place causes Answer Relevancy to underestimate real quality. For Korean-language services, the choice of embedding model has a larger impact on Answer Relevancy results than it does for English services, so you must run embedding model swap experiments early.

---

## Closing Thoughts

### Key Takeaways

RAGAS independently diagnoses the two core stages of a RAG pipeline. **Faithfulness** measures at the atomic claim level how faithfully the model follows the context during the generation stage. **Context Recall** quantifies against ground truth how completely the retrieval stage recovers the information needed to construct the answer. **Answer Relevancy** evaluates how directly the final answer responds to the user's question using reverse question generation. Looking at all three metrics together lets you quickly isolate "is this a retrieval problem, a generation problem, or a prompt structure problem?" — and that is what distinguishes RAGAS from a simple accuracy metric.

Choosing the evaluation LLM, setting the sampling rate, managing ground truth quality, and optimizing Korean-language prompts are all decisions that must be made upfront when adopting RAGAS in production. Evaluation cost in particular is commonly underestimated, so the stable approach is to first build a sampling-based async evaluation framework and then gradually expand coverage.

### When to Adopt RAGAS

The right time to invest in RAGAS is when you are continuously experimenting with RAG pipeline configuration variables (chunk size, embedding model, Top-k, reranking strategy), or when you are in production and finding it hard to tell whether the source of user complaints is retrieval or generation. Conversely, RAGAS is overkill for simple keyword-search-based systems or rule-based answer generation pipelines. RAGAS shows its greatest value in complex multi-stage RAG systems that involve multi-hop reasoning or multi-turn conversations. The moment you set individual thresholds for each of the three metrics and start tracking deltas on every pipeline change, RAG improvement shifts from intuition-driven to data-driven decision-making.
