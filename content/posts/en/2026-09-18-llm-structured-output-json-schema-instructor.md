---
title: "LLM Structured Output Design: JSON Schema and the Instructor Pattern"
date: "2026-09-18 18:19"
category: "AI"
tags: ["LLM structured output", "JSON Schema", "Instructor", "Pydantic", "Constrained Decoding"]
excerpt: "A systematic guide to designing type-safe LLM responses using JSON Schema constrained decoding and the Instructor pattern with Pydantic."
koSlug: "2026-09-18-LLM-구조화-출력-설계-JSON-Schema와-Instructor-패턴"
---

## Table of Contents

1. Overview
2. Core Mechanisms of Structured Output
3. Designing Type-Safe Responses with the Instructor Pattern
4. JSON Schema Design Strategy and Trade-offs
5. Reliability in Production
6. Closing Thoughts

---

## Overview

### The Problem: Why LLM Responses Need Structure

The first real wall you hit when integrating an LLM into an application is turning text responses into something your code can actually consume. Without a systematic approach to LLM structured output, the same prompt produces subtly different formats on every call. One day the response arrives wrapped in a markdown code fence, another day an explanation sentence is mixed in before the JSON, and another day a string shows up in a numeric field. That unpredictability makes the entire pipeline fragile and causes exception-handling logic to sprawl without bound. JSON Schema and the Instructor pattern solve this problem not at the prompt level but at the **model output control level**, a design methodology that eliminates parsing errors at the source.

An LLM is fundamentally a probabilistic model that predicts the next token. Telling the model "return JSON" in a prompt **conveys intent**; it does not **enforce** output format. When context grows long, questions get complex, or the model encounters rare input patterns, it can ignore format instructions. This is especially pronounced in environments without few-shot examples. This post covers how structured output works internally, how to design type-safe Python code with the Instructor pattern, and the failure patterns that actually occur in production along with how to handle them.

### Limits of the Manual Parsing Approach

Specifying the format in a prompt and then calling `json.loads()` directly on the response looks like it works at first, but it always breaks at three specific points. First, if the model adds a code fence or prepends an explanation, parsing fails immediately. Second, if you write retry logic manually without passing the original error context back to the model, the same mistake repeats. Third, if the schema is undefined and the model freely omits or adds fields, downstream code breaks with `KeyError`.

Another problem with post-processing responses is **the absence of type safety**. `json.loads()` returns a Python dictionary, so IDE autocompletion doesn't work and field access depends on string keys. Typos only surface as runtime errors, and static analysis tools can't detect field type changes. As LLM integration code grows in this kind of structure, half the application ends up filled with defensive code coaxing the LLM response into shape.

```diagram
en/2026-09-18-784fb3bd-01
```

Enforcing format through prompts alone produces a cycle of parsing failures and manual retries.

---

## Core Mechanisms of Structured Output

### JSON Schema-Based Constraint

OpenAI's **Structured Outputs** feature and Anthropic's **tool use (function calling)** approach both use JSON Schema as the specification language, but they differ in how they enforce the format. OpenAI's `response_format: { type: "json_schema", strict: true }` option zeroes out the probability of any token that would violate the schema, making it impossible to select that token at all. This is called **Constrained Decoding**. Anthropic's tool use wraps the function-call response in a dedicated structure and fills JSON inside it, so it isn't full token-level constraint, but a separate response parser intercepts schema mismatches before they get through.

Both approaches are based on JSON Schema Draft 7 or 2020-12, but **not every keyword is supported.** Circular references via `$ref` or complex `oneOf` combinations are often out of scope, and whether the `pattern` keyword is handled at the Constrained Decoding level varies by provider. When designing schemas, start from the minimal schema that is known to be supported and push complex validation logic down to the application layer — that is the first principle for building a stable production environment.

| Approach | Enforcement Level | Schema Support | Retries Required |
|---|---|---|---|
| OpenAI Structured Outputs | Token sampling | JSON Schema (partial) | Rarely |
| OpenAI JSON Mode | Prompt level | JSON format only | Field omissions possible |
| Anthropic Tool Use | Parser level | JSON Schema (partial) | Occasionally |
| Prompt instruction | Semantic level | None | Frequently |

### Token Sampling Control and Constrained Decoding

To understand Constrained Decoding you need to know how an LLM generates text. At every step, the model computes a probability distribution (logits) over the entire vocabulary and then selects the next token. Constrained Decoding dynamically computes the set of valid tokens at each step **to keep the text generated so far in a state that satisfies the JSON Schema**. For example, once `{"name": "` has been generated and the schema defines `name` as a string, only tokens that start with a quote character are eligible; number tokens and `null` are removed from the candidates.

This mechanism prevents format violations at the source, but it has an important side effect. The stronger the constraint, **the more the model's expressiveness tends to shrink**. If a schema is defined too granularly, the model may pick the next-best token that satisfies the constraint instead of the most natural expression, which can degrade output quality. This is why the design principle of minimizing field count and not over-narrowing value ranges matters.

```diagram
en/2026-09-18-784fb3bd-02
```

A validity mask is recalculated at every token step to block format violations at the source.

### Data Flow: From Request to Validation

Even with structured output, there are multiple validation checkpoints along the path data takes to reach the application. Even when the API layer guarantees format, **business-logic constraints** are still the application's responsibility. For instance, a schema can guarantee that an `age` field is an integer, but it can't easily prevent `age: -5`. You can add `minimum: 0` to the schema, but as domain rules grow more complex, expressing every constraint in the schema quickly hits a practical limit.

The Instructor pattern fills that gap with Pydantic models. JSON Schema guarantees format at the API communication layer; Pydantic validators sit on top of that and enforce business constraints in the code layer. When both layers cooperate, you can handle both parsing errors and business-rule violations in a systematic way, and because retries include the failure context, the model can recognize where it went wrong and correct itself.

```diagram
en/2026-09-18-784fb3bd-03
```

Schema constraints and Pydantic validation act as a double layer; when a business rule is violated, the retry includes the error context.

---

## Designing Type-Safe Responses with the Instructor Pattern

### Defining Schemas with Pydantic Models

Instructor is a Python library that automatically converts Pydantic models into JSON Schema, sends it to the LLM API, and deserializes the response back into Pydantic instances. The core advantage is **defining the schema and the types in one place**. Managing a JSON Schema file separately creates synchronization problems with Python type hints, but with Instructor the Pydantic model becomes the single source of truth. Code changes immediately reflect schema changes, and IDE autocompletion and type checking work all the way through the LLM response object.

When defining a model, the `description` parameter of `Field` is not just documentation — it is a **prompt hint passed to the LLM**. The model reads the description of each field and infers what value to put there. A plain `description="user name"` is far less effective than `description="full name, last+first format, spaces allowed"` at removing ambiguity. Time invested in descriptions is one of the most effective ways to reduce retry rates.

Below is an example that extracts action items from an email body. Two models, `ActionItem` and `EmailAnalysis`, are designed as a nested structure.

```python
import instructor
import anthropic
from pydantic import BaseModel, Field
from typing import Literal
from datetime import date

class ActionItem(BaseModel):
    task: str = Field(
        description="Task to be performed. A clear sentence starting with a verb"
    )
    assignee: str | None = Field(
        default=None,
        description="Assignee name. null if not explicitly stated in the email"
    )
    due_date: date | None = Field(
        default=None,
        description="Deadline (ISO 8601). null if not mentioned"
    )
    priority: Literal["high", "medium", "low"] = Field(
        description="Priority based on urgency and importance"
    )

class EmailAnalysis(BaseModel):
    subject_summary: str = Field(
        description="One-sentence summary of the email topic, 20 characters or fewer"
    )
    action_items: list[ActionItem] = Field(
        description="All extracted action items. Empty array if none"
    )
    sentiment: Literal["positive", "neutral", "negative", "urgent"] = Field(
        description="Overall emotional tone of the email"
    )

client = instructor.from_anthropic(anthropic.Anthropic())

result = client.messages.create(
    model="claude-opus-4-5",
    max_tokens=1024,
    max_retries=2,          # Retry with error context on Pydantic failure
    response_model=EmailAnalysis,
    messages=[{
        "role": "user",
        "content": "Please analyze the following email:\n\n..."
    }]
)
# result is an EmailAnalysis instance — no dictionary key access needed
# result.action_items[0].priority  →  "high"
# result.sentiment                 →  "urgent"
# Full IDE autocompletion and type hints
```

Passing `response_model=EmailAnalysis` causes Instructor to extract the schema internally, send it along with the API request, and convert the response JSON into an `EmailAnalysis` instance. The return value is a plain Python object, so values are read via attributes in subsequent code, and type errors are caught at static analysis time rather than at runtime.

### Integrating Retries and Validation

One of Instructor's most powerful features is **automatic retry with error context propagation**. When Pydantic validation fails, Instructor appends a detailed error message — containing the failed field, the violated constraint, and the value the model returned — to the context of the next API call. Because the model knows where it went wrong, it is less likely to repeat the same mistake. In contrast, a naive retry without error context is likely to produce the same response from the same input, wasting retry budget.

The retry count is set with the `max_retries` parameter. The default is 0 (no retries); 2–3 is appropriate for production. Allowing too many retries causes cost and latency to grow linearly, so you should collect retry logs and treat frequently failing patterns as signals to improve schema design or prompts. If retries persistently exceed 5% of all calls, that is a schema design problem, not a retry configuration problem.

```diagram
en/2026-09-18-784fb3bd-04
```

Because the retry includes the Pydantic error details in the prompt, the model recognizes where it went wrong and corrects itself.

### Handling Complex Nested Structures

Once nested structures or union types appear beyond simple flat objects, design decisions directly affect response quality. **When nesting depth exceeds three levels**, the accuracy with which a model fills values into the correct paths tends to drop sharply. In such cases, flattening intermediate structures or splitting extraction into a chain of multiple steps produces more stable results. Having the first call extract top-level categories and the second call extract details within each category keeps each schema simple while still handling complex information structures.

Enum fields using `Literal` types reduce the model's degrees of freedom and improve consistency. In classification tasks, using a plain string field without an enum lets in a mix of expressions like `"positive"`, `"good"`, and `"great"`, but `Literal["positive", "neutral", "negative"]` locks down the output. A pattern of defining enum values in English and managing display labels in a separate mapping dictionary is favorable for both internationalization and maintainability.

| Structure Type | Recommended Approach | Notes |
|---|---|---|
| Flat object | Single Pydantic model | Keep to 20 fields or fewer |
| 2-level nested object | Nested Pydantic models | Provide sufficient descriptions |
| 3+ level nested object | Separate extraction chain | Add per-step validation |
| Union type | Prefer `Literal` enum | `Union` introduces ambiguity |
| Variable-length list | `list[SubModel]` | Explicitly allow empty array return |

---

## JSON Schema Design Strategy and Trade-offs

### Schema Complexity and Token Cost

The JSON Schema itself is included in the API request payload and consumes input tokens. Larger schemas directly increase input token count, which affects both call cost and context window usage. When using Constrained Decoding, schema complexity also ties into the overhead of computing the token mask. Complex reference structures via `$ref` or deeply nested `anyOf` are often unsupported, and even when they are, they can affect processing speed.

A common over-engineering pattern in real projects is trying to put every domain constraint into the schema. Overusing constraint keywords like `pattern`, `minimum`, `maximum`, and `minLength` bloats the schema and actually makes it harder for the model to determine which constraints to focus on. Keeping schemas lightweight and doing validation in code — a clear separation of concerns — improves both maintainability and cost efficiency at the same time.

```diagram
en/2026-09-18-784fb3bd-05
```

Splitting responsibility so that JSON Schema handles format and Pydantic handles meaning reduces maintenance burden.

### Required vs. Optional Field Design Principles

Be deliberate about what goes into the `required` array. When a field is required, the model will **generate something** even if the information is absent from the input. That creates a risk of hallucination where the model fills in a plausible-sounding value it guessed. Filling a field with information that doesn't exist in the source text distorts extraction accuracy and causes downstream systems to trust incorrect data — a much larger problem.

Any field whose information may be absent must be designed as an optional field that allows `null`, and the `description` should explicitly state "return null if the information is not present." Conversely, leaving a field that must always exist as optional lets the model skip it at its convenience, so required vs. optional decisions need to be settled clearly during requirements analysis. Using `default` values makes it hard to distinguish between absent information and a default, which can cause confusion in downstream processing.

> "null when absent, value when present" — following this principle means downstream code can determine whether information exists with a simple `None` check.

### Enums, Pattern Matching, and Constraints

The `enum` keyword is a core tool for guaranteeing consistency in classification tasks. When the model sees a list of enum values, it picks the most appropriate one from within that range, producing far more predictable output than a free-form string. Keep enum values short and unambiguous. When there are too many values (20 or more), selection accuracy drops, so consider hierarchizing them or splitting into a two-stage extraction: a first call to decide the top-level enum value and a second call to select the detailed enum value within that category. This improves both accuracy and cohesion.

The `pattern` keyword for regex constraints is useful for fields with strict formats like emails, phone numbers, and code identifiers, but not all LLM APIs support this at the Constrained Decoding level. Check the API docs first, and design defensively by substituting a Pydantic `field_validator` when it isn't supported. If you put `pattern` in the schema and the API silently ignores that keyword, format violations will pass through quietly — the worst possible outcome.

| Constraint Keyword | Support Level | Recommended Alternative |
|---|---|---|
| `type`, `required` | Widely supported | — |
| `enum` | Widely supported | `Literal` type |
| `minimum`, `maximum` | Partially supported | Pydantic validator |
| `pattern` | Limited support | Pydantic field_validator |
| `$ref`, circular references | Often unsupported | Split into extraction chain |

---

## Reliability in Production

### Common Mistakes and Parsing Failure Patterns

The most frequent production failure when using LLM structured output is **schema and model version mismatch**. When an API provider updates a model, the supported schema feature set may change, and a schema that worked fine before may behave unexpectedly on certain patterns. Regression tests after a model update are mandatory if you use `anyOf` or complex nested schemas. Explicitly pinning the model version in API calls and managing version upgrades intentionally is the first line of defense against unexpected failures.

The second common mistake is **responses truncated by context length**. When a response is cut off by `max_tokens`, the JSON ends up incomplete. Constrained Decoding guarantees the format of the response being generated, not that generation continues until the response is complete. If the source text is long or the schema structure is complex, set `max_tokens` with enough headroom. Detecting when `finish_reason` in the API response is `"length"` and handling it separately is essential in production.

The third pattern is **failing to distinguish between empty lists and null**. When there are no `action_items`, the model has no way to decide between returning an empty array `[]` or `null` without a description. Setting the field type to `list[ActionItem] | None` creates two different "absent" states and complicates downstream handling. Define list fields as non-nullable and standardize on empty array — this keeps processing logic simple.

```diagram
en/2026-09-18-784fb3bd-06
```

The three representative production failure types and how to handle each one.

### Monitoring and Debugging

The most important metric for the health of a structured output pipeline is the **retry rate**. If retries persistently exceed 5% of all calls, that is a data signal that something is wrong with the schema design or the descriptions. Instructor logs Pydantic `ValidationError` details when a retry occurs, so you can track which fields fail and why. Analyzing failure patterns regularly lets you prioritize schema improvements on data rather than intuition or guesswork.

**Tracking response latency** is also essential. Constrained Decoding adds mask-computation overhead and can be slightly slower than unconstrained generation; the more complex the schema, the larger that overhead. If you see a gradual upward trend in latency, that is the time to revisit schema optimization. Cross-analyzing retry rates by input text length can also reveal patterns like "extraction failures are concentrated at a certain input length range."

When debugging, start by using Instructor's logging to inspect the actual JSON Schema being sent and the raw model response. Separating whether an unexpected schema is being transmitted from whether the model returned valid JSON that then failed Pydantic validation is the key to fast resolution — the causes and fixes are completely different.

```diagram
en/2026-09-18-784fb3bd-07
```

Tracking three core metrics lets you decide the direction and timing of schema improvements from data.

### Scaling and Schema Migration

Response schemas evolve alongside application code. Adding a new field to a schema or changing the type of an existing field can break code that was parsing previous call results. To manage schema changes in a **backward-compatible** way, follow a few principles. New fields must always be added as optional. Instead of deleting an existing field, annotate it as deprecated and clean up all usages before removing it. Narrowing a field type (string → Literal) tends to be compatible with existing data, but analyze the existing data distribution first before applying the change.

In multi-provider environments, share a single Pydantic model across providers but abstract the per-provider schema transformation layer to reduce the cost of switching providers. Because Instructor supports multiple providers including OpenAI, Anthropic, and Gemini, switching `instructor.from_openai()` to `instructor.from_anthropic()` is enough to change providers without touching response model code.

```python
# Before: free-form string — mixed expressions come in
class EmailAnalysisV1(BaseModel):
    sentiment: str  # "positive", "good", etc., free input

# After: Literal type — any value outside the enum raises a Pydantic error
class EmailAnalysisV2(BaseModel):
    sentiment: Literal["positive", "neutral", "negative", "urgent"]
    # Before migrating: check the distribution of existing sentiment values first
    # If existing values fall outside the enum, go through the V1_5 intermediate step below

# Intermediate step for gradual rollout: allow both with Union
class EmailAnalysisV1_5(BaseModel):
    sentiment: Literal["positive", "neutral", "negative", "urgent"] | str
    # New calls return enum values; existing data handled via str fallback
    # Downstream: use Literal value directly, log and normalize if str
```

Type-narrowing changes should be applied gradually after first checking compatibility with existing data.

---

## Closing Thoughts

### Key Takeaways

LLM structured output doesn't replace prompt engineering — it adds a **separate layer of parsing reliability**. JSON Schema constrains token generation at the API layer to guarantee format; Instructor and Pydantic sit on top to provide business-logic-level validation and automatic retries. Combining both layers lets you eliminate most exception-handling code caused by parsing errors and address extraction accuracy problems through data-driven improvements to schemas and descriptions.

The three most important principles in schema design are: first, assign format constraints to JSON Schema and semantic constraints to Pydantic validators. Second, any field whose information may be absent must be an optional field that allows `null`. Third, monitor retry rates and failing fields to continuously improve schemas and descriptions. Following these three principles keeps parsing-related failures predictable and traceable even as the LLM integration codebase grows.

### When to Apply

Structured output is recommended for **every production pipeline** where LLM responses are consumed by code. For use cases where a human is the consumer — plain text summaries, conversational interfaces — structured output is unnecessary and will actually constrain the model's expressiveness. For use cases where code is the consumer — data extraction, classification, API response generation — the return on investment is clear.

```diagram
en/2026-09-18-784fb3bd-08
```

If your pipeline has code consuming the response, structured output should be the first thing you evaluate.

The Instructor pattern has a low adoption cost in Python projects that already use Pydantic. Consolidating schema management into Pydantic models instead of separate files gives you type safety, autocompletion, and retry logic all at once. If retries persistently exceed 5%, revisiting schema design and descriptions is effective for both cost reduction and accuracy improvement. The Instructor documentation ([https://python.useinstructor.com](https://python.useinstructor.com)) and the OpenAI Structured Outputs documentation ([https://platform.openai.com/docs/guides/structured-outputs](https://platform.openai.com/docs/guides/structured-outputs)) are the places to check for the current supported feature set and recent changes.
