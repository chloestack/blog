---
title: "Building LLM Fine-Tuning Datasets with Synthetic Data"
date: "2026-10-10 02:21"
category: "AI"
tags: ["synthetic data", "LLM fine-tuning", "Self-Instruct", "data augmentation"]
excerpt: "A practical guide to generating high-quality fine-tuning datasets using Teacher-Student synthesis, covering Self-Instruct, Evol-Instruct, quality filtering, and production pitfalls."
koSlug: "2026-10-10-합성-데이터로-LLM-파인튜닝-데이터셋-구축하기"
---

## Table of Contents

1. Overview
2. How Synthetic Data Works: Generation Mechanics
3. Fine-Tuning Dataset Design Strategy
4. Implementing Synthetic Data Generation
5. Data Quality Validation and Filtering
6. Considerations for Production Use
7. Closing Thoughts

---

## Overview

### Problem Background

Fine-tuning an LLM for a specific domain requires thousands to tens of thousands of high-quality labeled examples. The more specialized the field — medicine, law, finance — the more domain experts must personally generate or review data, which sends cost and time spiraling upward. To solve this, AI teams in industry have been paying increasing attention to **synthetic data generation**: using a powerful large model (the Teacher model) to automatically generate training data for a smaller model (the Student model). The approach has gained traction because it can substantially reduce data collection costs while meaningfully improving model performance.

### Limitations of Existing Approaches

Traditional methods for building fine-tuning data fall into two broad categories. The first is collecting real user logs or production data directly; the second is generating data manually through crowdsourcing or domain experts. The first approach tends to create **privacy and security issues**, and because the data distribution mirrors actual usage patterns, it is hard to achieve adequate coverage of edge cases. The second approach is limited in that a single expert can produce only tens to hundreds of samples per day, making it **poor in scalability from both a speed and cost perspective.** Tasks like improving chatbot response quality or instruction following require a wide variety of input phrasings — diversity that manual work struggles to deliver.

The synthetic data approach addresses both limitations at once. With a well-designed prompt and generation pipeline, you can collect highly diverse data 10–100× faster than before. That said, because the data is "synthetic," **quality validation and bias removal** must accompany the generation step — without them, model performance can actually degrade. Designing generation and validation together is the key.

```diagram
en/2026-10-10-33c39c28-01
```

The synthetic data pipeline follows a "Teacher → Generate → Validate → Student" flow; skipping the validation step makes quality guarantees impossible.

---

## How Synthetic Data Works: Generation Mechanics

### The Teacher-Student Paradigm

The core paradigm of synthetic data generation is a data-level version of **knowledge distillation**. A Teacher model with hundreds of billions of parameters — GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro — generates high-quality responses, and those input-output pairs become training data for fine-tuning a smaller Student model. Because the Student is trained to mimic the Teacher's reasoning style and response patterns, it can internalize a significant portion of the Teacher's behavior without any direct human labeling.

This paradigm works well because the Teacher model naturally produces data that includes **diverse paraphrases** and **edge cases**. For example, when fine-tuning a customer service bot, a single intent such as "refund request" can automatically yield dozens of surface variations: "Please refund me," "I'd like to cancel my payment," "I want my money back," "Is a refund possible?" — all in seconds, whereas a human annotator would have to write each one by hand.

### Key Generation Techniques

Synthetic data generation methods vary depending on the goal. The **Self-Instruct** approach starts from a small set of seed examples and has the LLM generate new instruction-response pairs on its own; Stanford Alpaca's creation of 52K samples for fine-tuning LLaMA is the canonical example. **Evol-Instruct** progressively increases the complexity of simple instructions; WizardLM-family models used this technique to develop stronger reasoning capabilities. **Persona-Driven** generation assigns diverse user personas (expert, student, layperson, etc.) to ensure variety of perspective.

| Technique | Core Idea | Strength | Watch Out For |
|---|---|---|---|
| Self-Instruct | Self-propagation from seeds | High data diversity | Requires dedup filter |
| Evol-Instruct | Progressive complexity increase | Improves reasoning ability | Avoid over-complication |
| Persona-Driven | Per-persona responses | Perspective diversity | Depends on persona quality |
| Backtranslation | Response → question reverse generation | Natural-sounding questions | Needs consistency validation |

### Data Flow: Pipeline Architecture

A real synthetic data pipeline is not simply "ask an LLM and save the output." It goes through: seed data preparation → prompt construction → LLM call → response parsing → quality filtering → format conversion. Failures or quality degradation at any step affect everything downstream, so **per-step validation checkpoints** are essential. The LLM call step in particular is subject to three simultaneous constraints: API rate limits, token cost, and response consistency.

```diagram
2026-10-10-33c39c28-02
```

Data must pass through quality checkpoints starting from the seeds before it can enter the final dataset; samples that fail are either regenerated or discarded.

---

## Fine-Tuning Dataset Design Strategy

### Choosing a Data Format: SFT vs. DPO

The required data format depends on the fine-tuning approach. **SFT (Supervised Fine-Tuning)** uses the most basic format: `(instruction, response)` pairs. The model learns to produce correct responses given an instruction; it is simple to implement and inexpensive to generate data for. **DPO (Direct Preference Optimization)**, on the other hand, requires preference pairs in the form `(instruction, chosen_response, rejected_response)`. By providing both a "good response" and a "bad response" for the same instruction, the model learns the preferred direction — useful for fine-grained tuning of safety, helpfulness, and harmlessness.

When creating DPO pairs from synthetic data, you can either ask the Teacher model to simultaneously generate a good response and an intentionally lower-quality one, or apply different settings (temperature, system prompt) to the same prompt to create a quality gap between responses. This approach is less precise than genuine human preference labels, but its **ability to generate at scale** makes it practically useful in early alignment stages.

```diagram
en/2026-10-10-33c39c28-03
```

SFT is well-suited for domain adaptation; DPO is well-suited for aligning response quality. Applying the two sequentially is the norm.

---

### Why Seed Data Design Matters

The quality of synthetic data is largely determined by the seed data. Biased seeds produce biased synthetic data. Good seed data must strike a balance across three axes: **domain coverage**, **difficulty distribution**, and **expression diversity**.

For example, to build a legal document summarization model, you need to cover multiple legal areas such as civil, criminal, commercial, and administrative law (domain coverage); spread difficulty from simple factual summaries to complex case analysis (difficulty distribution); and include examples of the same case written from both a practitioner's perspective and a layperson's perspective (expression diversity). In practice, the common strategy is to prepare 50–200 high-quality seed examples and then amplify them by 10–50×.

Too few seeds produce monotonous output; too many seeds increase the cost of seed preparation itself. Starting with **roughly 100 polished seeds**, verifying the pipeline, and then expanding the seed set incrementally is an effective way to reduce risk.

### Strategies for Ensuring Diversity

Techniques for expressing the same intent in multiple ways include **paraphrase generation** (rewriting the same content in different words), **context augmentation** (adding or removing background information), and **persona variation** (changing the user persona). Persona variation is particularly effective when the same question demands entirely different responses depending on who is asking — for instance, calibrating response complexity for beginners vs. experts.

To measure data diversity quantitatively, use the **Self-BLEU** metric: it measures pairwise similarity between samples in the generated dataset, and a lower score means higher diversity. A Self-BLEU above 0.5 signals excessive duplication; in that case, raise the generation temperature or expand seed diversity.

```diagram
en/2026-10-10-33c39c28-04
```

Combine all three diversity strategies when composing the dataset, quantify diversity with Self-BLEU, and adjust parameters immediately when the score falls below the threshold.

---

## Implementing Synthetic Data Generation

### Basic Setup and Environment Configuration

Before building the synthetic data pipeline, decide how to access the Teacher model. You can use the OpenAI API, Anthropic API, or a local model (vLLM, Ollama) as the Teacher; choose based on the tradeoff between cost and quality. For large-scale generation, using the Batch API can cut costs by up to 50%.

The core libraries for the pipeline are typically `datasets` (Hugging Face), the `openai` or `anthropic` SDK, `tenacity` (retry logic), and `pydantic` (response validation). Saving generated data in Hugging Face JSONL format is the most universally compatible choice for fine-tuning frameworks such as TRL and LLaMA-Factory.

Below is an example of a basic Self-Instruct generation loop. It generates new instruction-response pairs from seed examples and validates the response schema with a Pydantic model.

```python
import json
import random
from pydantic import BaseModel, ValidationError
from anthropic import Anthropic
from tenacity import retry, stop_after_attempt, wait_exponential

client = Anthropic()

class SyntheticSample(BaseModel):
    instruction: str
    response: str
    category: str

SEED_EXAMPLES = [
    {"instruction": "Please explain list comprehensions in Python.",
     "response": "A list comprehension is concise syntax for transforming or filtering an existing list...",
     "category": "python_basics"},
]

GENERATION_PROMPT = """
Using the examples below as a reference, generate {n_samples} new instruction-response pairs.
They should be similar in style to the examples but use different topics and phrasing.

Examples:
{examples}

Respond with a JSON array:
[{{"instruction": "...", "response": "...", "category": "..."}}]
"""

@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
def generate_batch(seed_examples: list, n_samples: int = 5) -> list[SyntheticSample]:
    examples_str = json.dumps(random.sample(seed_examples, min(3, len(seed_examples))),
                               ensure_ascii=False, indent=2)
    prompt = GENERATION_PROMPT.format(n_samples=n_samples, examples=examples_str)

    message = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}]
    )

    raw = message.content[0].text
    json_start = raw.find("[")
    parsed = json.loads(raw[json_start:])  # Result: parsed JSON array

    validated = []
    for item in parsed:
        try:
            validated.append(SyntheticSample(**item))
        except ValidationError:
            pass  # Drop samples that don't match the schema

    return validated  # Result: list of SyntheticSample instances that passed validation
```

The key points are: the `@retry` decorator automatically recovers from transient API failures, and `ValidationError` is handled at the individual sample level so that a single bad sample does not fail the entire batch. Because the Teacher model's responses are not always perfectly formed JSON, defensive parsing logic is important.

---

### Core Implementation: Applying Evol-Instruct

Evol-Instruct progressively transforms simple instructions into more complex ones. Each instruction is run through evolution operators such as "add more constraints," "require a concrete example," or "require multi-step reasoning."

```python
EVOLUTION_OPERATORS = [
    "Make it harder by adding more specific constraints",
    "Make it complex enough to require multiple reasoning steps",
    "Ground it in a concrete production environment scenario",
    "Expand it to include edge cases or exception conditions",
]

def evolve_instruction(instruction: str, operator: str) -> str:
    """Increases the complexity of an instruction using the given operator."""
    prompt = f"""Evolve the instruction below using the method described, producing a more complex version.
Method: {operator}

Original instruction: {instruction}

Output only the evolved instruction (no explanation):"""

    message = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}]
    )
    return message.content[0].text.strip()
    # Result: a new instruction string with increased complexity

def build_evolved_dataset(seeds: list, evolution_rounds: int = 3) -> list:
    evolved = list(seeds)
    for round_idx in range(evolution_rounds):
        new_samples = []
        for sample in evolved[-len(seeds):]:  # Only select samples from the previous round
            op = random.choice(EVOLUTION_OPERATORS)
            new_instr = evolve_instruction(sample["instruction"], op)
            new_samples.append({**sample, "instruction": new_instr,
                                  "evolution_round": round_idx + 1})
        evolved.extend(new_samples)
    return evolved
```

The key design decision is to evolve only the samples from the previous round. Re-evolving all accumulated samples causes early simple samples to become unnecessarily complex, which breaks the quality distribution of the dataset.

---

## Data Quality Validation and Filtering

### Automated Quality Evaluation Criteria

Because synthetic data is generated quickly, it also contains a lot of low-quality samples. Without **automated quality evaluation** integrated into the pipeline, fine-tuning proceeds on noisy data and model performance can actually regress. Automated evaluation covers four main criteria.

**Format validity** checks whether the response conforms to the required format (JSON, Markdown, code block, etc.). **Length appropriateness** checks that the response-to-instruction length ratio is reasonable, filtering out responses that are shorter than the instruction or excessively verbose. **Semantic coherence** uses embedding similarity to verify that the instruction and response are meaningfully related. **Deduplication** uses MinHash or cosine similarity to identify duplicate or near-duplicate samples and preserve dataset diversity.

| Check | Measurement Method | Pass Criterion | Action on Failure |
|---|---|---|---|
| Format validity | Parsing success | 100% parse success | Discard immediately |
| Length appropriateness | Response/instruction ratio | 0.5–10 range | Discard or regenerate |
| Semantic coherence | Cosine similarity | ≥ 0.3 | Recommend regeneration |
| Duplication | MinHash Jaccard | < 0.85 | Keep one copy |

### Using LLM-as-Judge

The technique of having the Teacher model re-evaluate generated data for subtle quality issues that automated metrics miss — logical errors, factual errors, unclear phrasing — is called **LLM-as-Judge**. Randomly sampling from the generated dataset and asking the Teacher model to score each sample on a 1–5 scale lets you understand the quality distribution without any manual review. Samples below a threshold (e.g., a score of 3) are removed or regenerated.

The main caveat of LLM-as-Judge is that when the Teacher model evaluates data it generated itself, **self-preference bias** can arise. To mitigate this, use a different model as the judge (e.g., generate with GPT-4o, evaluate with Claude), or when using the same model as judge, explicitly instruct it in the evaluation prompt to take a strict and critical perspective.

```diagram
en/2026-10-10-33c39c28-05
```

Chaining the automated filter and LLM Judge in series lowers the proportion of samples that reach the final dataset, but increases quality density and improves fine-tuning efficiency.

---

### Detecting and Correcting Bias

Synthetic data can inherit the biases baked into the Teacher model. If the Teacher has a particular political lean or cultural perspective, the generated data will reflect the same. Periodically monitor **sample count distribution by category**, **response tone (positive/negative ratio)**, and **frequency of specific entity mentions (countries, people, brands)** to check for bias.

When balancing the dataset, either generate additional samples specifically for underrepresented categories, or explicitly specify certain personas or background conditions in the prompt to deliberately broaden diversity. This process is called **targeted augmentation**, and it corrects bias far more efficiently than uniformly increasing the entire dataset.

---

## Considerations for Production Use

### Common Mistakes and Pitfalls

The first mistake teams typically make when building a synthetic data pipeline for the first time is **starting with mass generation before establishing quality validation**. Discovering low quality after generating a million samples means significant API costs have already been incurred. The recommended approach is to check quality metrics on a small batch (1,000–5,000 samples) first, and only scale up once you are satisfied with the results.

The second pitfall is **filling 100% of training data with synthetic data alone**. Synthetic data cannot fully replace real user data. Patterns found in the real world — typos, ungrammatical expressions, code-switching between languages — are not adequately reproduced in synthetic data, which can leave the model vulnerable to unexpected inputs after deployment. Use synthetic data to supplement real data, and **mix in at least 20–30% real data** to stay safe.

The third pitfall is **ignoring the knowledge boundary of the Teacher model**. Information that postdates the Teacher model's training cutoff and proprietary in-house knowledge will not appear in synthetic data. When domain-specific knowledge is required, consider a **RAG-based synthetic data generation** approach, where context documents are provided to the Teacher model at generation time.

```diagram
en/2026-10-10-33c39c28-06
```

The two key decision points when adopting synthetic data are the real-data mixing ratio and the scale-up strategy; the conservative direction is safer for both.

---

### Monitoring and Cost Management

Operating costs for a synthetic data pipeline are directly tied to the number of Teacher model API calls. Track the following metrics to manage costs systematically. **Tokens per sample** reflects the efficiency of your generation prompt — trimming unnecessarily long system prompts or excessive numbers of examples can cut costs by 30–50%. **Generation success rate** is the proportion of LLM calls that produce samples passing quality criteria; if this drops below 50%, revisit the prompt engineering or quality thresholds. **Regeneration count** tracks the cost of retrying failed samples.

**Prompt caching** is one of the most effective cost-reduction strategies. With the Anthropic API, using the `cache_control` header to cache common system prompts and seed examples can reduce input token costs by up to 90% on repeated calls. For large-scale generation, using the Batch API yields a 50% cost reduction compared to the standard API.

### Scaling and Migration

When scaling the pipeline beyond 10× after it has stabilized, a **distributed generation** architecture becomes necessary. Move away from a single script doing sequential generation and shift to job distribution via Apache Kafka or a Redis queue, with multiple workers running in parallel. Ensuring **idempotency** is critical at this stage: run a checkpoint store so that re-running the same seed + random seed combination does not re-generate samples that already exist.

When switching Teacher models (e.g., migrating from GPT-4o to Claude), style consistency issues can arise between existing data and newly generated data. In this case, generate a small validation set with the new Teacher, compare quality and style distributions against the existing data, and then decide whether to proceed with a full migration.

```diagram
en/2026-10-10-33c39c28-07
```

At scale, preventing duplication via the checkpoint store is critical; failing to implement it results in simultaneous cost waste and data duplication.

---

## Closing Thoughts

### Key Takeaways

Synthetic data generation is a practical approach to resolving the **data bottleneck** in LLM fine-tuning. Leveraging high-quality input-output pairs generated by a Teacher model as training data lets you build a large fine-tuning dataset dozens of times faster than manual expert annotation. The core of this approach is a two-layer verification structure: techniques like Self-Instruct and Evol-Instruct for diversity, combined with LLM-as-Judge and automated filtering for quality assurance.

Synthetic data is not a silver bullet. The Teacher model's biases transfer to the data, recent information and internal domain knowledge may not be reflected, and real users' diverse input patterns cannot be fully reproduced. Recognizing these limitations and deliberately mixing in real data is what produces more robust models over the long term.

### When to Adopt

A synthetic data pipeline is worth introducing when two or more of the following conditions apply: **a specialized domain where labeled data is expensive to obtain (medicine, law, finance)**; **a need for a model that is robust to diverse input phrasings**; or **a need to quickly specialize a smaller model for a specific task**. Conversely, if sufficient real data already exists or if the Teacher model's quality is inadequate for the target domain, a real-data-centric strategy will outperform synthetic data alone. Synthetic data delivers its greatest value when viewed not as a tool to "conjure data from nothing," but as a tool to **"strategically amplify the data you already have."**
