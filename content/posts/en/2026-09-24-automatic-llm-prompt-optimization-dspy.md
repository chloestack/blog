---
title: "Automatic LLM Prompt Optimization with DSPy"
date: "2026-09-24 10:58"
category: "AI"
tags: ["DSPy", "prompt optimization", "RAG", "LLM pipeline", "compiler"]
excerpt: "The biggest time sink when shipping LLM features isn't model selection or fine-tuning — it's prompt tuning. DSPy automates that loop."
koSlug: "2026-09-24-DSPy로-LLM-프롬프트-자동-최적화하기"
---

## Table of Contents

1. Overview
2. DSPy's Design Philosophy and the Limits of the Existing Approach
3. Core Building Blocks — Signatures, Modules, Programs
4. How the Compiler and Optimization Algorithms Work
5. Real-World Application — RAG Pipeline Optimization
6. Performance Characteristics and Comparison with Alternatives
7. Considerations for Production Deployment
8. Closing Thoughts

---

## Overview

### Problem Background

The biggest time sink when applying LLMs to real projects isn't model selection or fine-tuning. Surprisingly, it's **prompt tuning**. Iterating through small wording changes — "explain in more detail", "think step by step", "output as JSON" — to get the desired output accounts for a significant portion of total development effort. The deeper problem is that the resulting prompts are tightly coupled to a specific model and a specific data distribution. Switch the model or change the input distribution and you're back to tuning from scratch.

**DSPy** (Declarative Self-improving Python), a framework released by the Stanford NLP Group, solves this problem programmatically. The developer only needs to define the input/output spec and evaluation metric for the task; DSPy's compiler automatically generates and optimizes the prompts and few-shot examples. Conceptually, this is similar to how PyTorch optimizes weights through backpropagation. This post covers how DSPy works, how to apply it to a real RAG pipeline, and the practical constraints you'll encounter in production.

### Limits of the Existing Approach

The fundamental problem with manual prompt engineering is the **lack of reproducibility**. It's hard to explain why a prompt works, so modifications and improvements inevitably rely on intuition. Orchestration frameworks like LangChain and LlamaIndex make pipeline composition easier, but they don't optimize the prompts themselves. The developer still has to decide manually "how to write the instruction" and "which examples to include as few-shot demos."

---

## DSPy's Design Philosophy and the Limits of the Existing Approach

### Shifting to a Declarative Programming Paradigm

The core idea of DSPy is to treat an LLM pipeline **like a neural network with weights**. Each module in the pipeline has learnable parameters (prompt instructions, few-shot examples), and those parameters are optimized during compilation. The developer declares "what they want," not "how to optimize it."

This paradigm shift makes a significant difference in maintainability and portability. Instead of hard-coding prompts throughout the codebase, a DSPy program is expressed as a composition of structured modules. When swapping from `gpt-4o` to `claude-3-5-sonnet`, there's no code to change — just recompile, and the optimal prompt for the new model is generated automatically. You can generate two versions of the same program structure, each optimized for a different model, and A/B test them.

```diagram
en/2026-09-24-932e209d-01
```

In the manual approach, evaluation and revision loop repeatedly, entirely dependent on the developer's judgment. DSPy has the compiler perform this loop automatically.

### The Problem of Coupling Prompts to Code

In conventional LLM application development, prompts are buried in code as strings. This creates a few structural problems. First, tracking the change history of a prompt is difficult. You can version-control it with Git, but the intent — "why was this phrase added" — is never recorded. Second, diagnosing which stage of a pipeline is degrading performance is hard. When something goes wrong in a complex multi-prompt pipeline, you have to review the whole thing.

DSPy separates prompts into an abstraction called a **signature**. A signature is a struct that declares the input/output spec of a module, decoupled from the actual prompt string. Because the compiler generates the prompt from the signature, developers can focus on the semantic spec of the task rather than on the prompt string itself.

| | Manual prompt engineering | DSPy |
|---|---|---|
| Who optimizes | Developer (heuristic) | Compiler (automatic) |
| Cost of swapping models | Requires re-tuning | Solved by recompiling |
| Pipeline debugging | Review all prompts | Measure performance per module |
| Reproducibility | Low | High (parameter serialization) |
| Few-shot example selection | Manual curation | Automatic bootstrapping |

---

## Core Building Blocks — Signatures, Modules, Programs

### Signatures: Declaring the Task Spec

A **Signature** is the most fundamental building block in DSPy. It's a struct that declares what a module should receive as input and produce as output from the LLM. Signatures can be defined as a short string or as a detailed Python class. The short form `"question -> answer"` means "receive a question and generate an answer"; the class form lets you add type hints and descriptions to each field for a more precise spec.

The key role of a signature is to give the compiler context. Field names and descriptions guide the LLM on how to understand the task, and the compiler uses this information to automatically generate appropriate instructions. For example, defining `context: str = dspy.InputField(desc="contents of relevant documents")` tells the compiler that this field holds RAG retrieval results, and it generates instructions accordingly.

```diagram
en/2026-09-24-932e209d-02
```

This shows the layer structure from signature through to a compiled program. Each layer has a clear separation of responsibility.

### Modules: Implementations of Reasoning Patterns

A **Module** is the component that implements a signature. DSPy provides built-in modules for various reasoning patterns. `dspy.Predict` is the most basic module and performs simple input-to-output transformation. `dspy.ChainOfThought` prompts the model to generate intermediate reasoning before the answer. `dspy.ReAct` implements an agent pattern that alternates between tool calls and observations. `dspy.MultiChainComparison` runs multiple reasoning paths in parallel and compares them.

The important point is that modules have learnable parameters. For `ChainOfThought`, which few-shot examples to include and how to elicit the intermediate reasoning are both optimized at compile time. The developer only chooses which reasoning pattern suits the task; the fine-grained tuning is delegated to the compiler.

```diagram
en/2026-09-24-932e209d-03
```

This shows criteria for choosing a module based on reasoning complexity. Choosing the right module for the task characteristics determines optimization efficiency.

### Programs: Composing Modules and Defining Data Flow

A **Program** is a class that combines multiple modules to handle a complex task. You inherit from `dspy.Module`, declare modules in `__init__`, then define data flow in the `forward` method. The structure is identical to PyTorch's `nn.Module`, and the resemblance is intentional.

Modules inside a program can be connected freely with plain Python code. Conditional branches, loops, and parallel execution are all supported. DSPy tracks the call history of each module during execution, and this information is used during compilation for optimization. This tracking mechanism is why, even in complex pipelines, you can identify which module is the performance bottleneck.

---

## How the Compiler and Optimization Algorithms Work

### The Full Compilation Flow

DSPy compilation is different from traditional software compilation. The inputs are: the program structure, a small set of training examples, and an evaluation metric. The output is the program with optimized parameters (prompt instructions, a set of few-shot examples) filled in. This is the job performed by what was originally called the **teleprompter** and is now officially called the **Optimizer**.

The first stage of compilation is **bootstrapping**. The optimizer runs the program on the provided training examples while collecting input/output pairs from intermediate steps. When `ChainOfThought` is used, it records which reasoning paths led to correct final answers. These records become the candidate pool for few-shot examples.

```diagram
en/2026-09-24-932e209d-04
```

Compilation isn't simply plugging in examples; it's a search process that analyzes successful execution traces to find the optimal few-shot combination.

### Major Optimizer Algorithms

DSPy provides several optimizers, each suited to different conditions.

**BootstrapFewShot** is the most basic optimizer. It runs the program on training examples and uses the traces from runs that passed the evaluation metric as few-shot examples. The implementation is simple, the number of LLM calls is low, and cost is minimal. It works well even with as few as 20–50 training examples. Its limitation is that it focuses only on selecting few-shot examples and does not optimize the prompt instructions themselves.

**MIPRO (Multi-prompt Instruction PRoposal Optimizer)** uses Bayesian optimization to optimize prompt instructions alongside few-shot examples. It prompts an LLM to propose better instruction candidates and then efficiently explores candidate combinations with Bayesian optimization. It requires far more LLM calls than BootstrapFewShot, but the performance gains are larger because it also optimizes the instructions.

**BootstrapFinetune** converts the optimized few-shot examples and reasoning traces into actual fine-tuning data and fine-tunes a smaller model. It can dramatically reduce inference cost, making it effective when operational cost is a priority.

| Optimizer | What's optimized | Examples needed | LLM call cost | When to use |
|---|---|---|---|---|
| BootstrapFewShot | Few-shot examples | 20–50 | Low | Rapid prototyping |
| BootstrapFewShotWithRandomSearch | Few-shot examples | 50–100 | Medium | Basic optimization |
| MIPRO | Instructions + few-shot | 100–300 | High | When peak performance is required |
| BootstrapFinetune | Model weights | 200+ | High (one-time) | Reducing inference cost |

### The Role of the Evaluation Metric

Compilation quality depends entirely on the evaluation metric. A metric is a Python function with the signature `(example, prediction, trace=None) -> float`. The return value is a score between 0 and 1 or a boolean. How well the metric reflects the actual success criteria of the task determines the compilation result.

> A poorly designed metric can cause the compiler to optimize in the direction of **gaming the metric**. For example, if you only check whether the answer contains the correct string, the model may optimize to include just that specific token rather than producing a complete answer.

A commonly used strategy for metric design is the **LLM-as-a-judge** pattern: use a powerful model (e.g., GPT-4o) as the evaluator to score the quality of generated answers. This approach is especially useful for generation tasks where precision metrics are hard to define, but it comes with the tradeoff of increased evaluation cost.

---

## Real-World Application — RAG Pipeline Optimization

### RAG Pipeline Design

RAG (Retrieval-Augmented Generation) is one of the most effective tasks to apply DSPy to. Optimization is needed in both the retrieval stage and the generation stage, and how the two are integrated also matters. In a traditional RAG implementation, the developer manually decides how to construct the retrieval query, how to present the retrieved documents as context, and how to write the answer generation instructions.

With DSPy, all three decisions can be delegated to the compiler. The advantage is most pronounced in complex pipelines like **multi-hop RAG**, where the answer is built up across multiple retrieval steps. Each retrieval stage's query is automatically optimized taking the results of the previous stage into account.

```diagram
en/2026-09-24-932e209d-05
```

In multi-hop RAG, DSPy optimizes the few-shot examples and instructions of each `ChainOfThought` module independently.

Here is an example implementing a basic RAG pipeline with DSPy. It shows the structure of combining a retrieval module with an answer generation module.

```python
import dspy

# Configure LLM and retriever
lm = dspy.LM("openai/gpt-4o-mini", api_key="...")
dspy.configure(lm=lm)

# Define signature: question + context → answer
class GenerateAnswer(dspy.Signature):
    """Answer the question based on the provided context."""
    context: list[str] = dspy.InputField(desc="list of retrieved relevant documents")
    question: str = dspy.InputField(desc="user question")
    answer: str = dspy.OutputField(desc="concise and accurate answer")

# Define the RAG program
class RAGProgram(dspy.Module):
    def __init__(self, retriever, k=3):
        self.retriever = retriever
        self.generate = dspy.ChainOfThought(GenerateAnswer)  # includes intermediate reasoning

    def forward(self, question):
        docs = self.retriever.search(question, k=3)
        context = [d.text for d in docs]
        # ChainOfThought generates a reasoning trace before the answer
        pred = self.generate(context=context, question=question)
        return dspy.Prediction(answer=pred.answer, reasoning=pred.reasoning)

# Compile: optimize with 20 training examples and an exact-match metric
optimizer = dspy.BootstrapFewShot(metric=answer_exact_match, max_bootstrapped_demos=4)
compiled_rag = optimizer.compile(RAGProgram(retriever), trainset=trainset)
# Result: optimal few-shot examples are automatically selected per module
# compiled_rag.generate.demos → list of selected few-shot examples
```

The key point is that `ChainOfThought(GenerateAnswer)` in one line handles both the reasoning pattern selection and the signature binding. In `forward`, you only define data flow; the compiler decides which prompts to use.

### Running Optimization and Saving Results

A compiled program can be saved and loaded in JSON format. `compiled_rag.save("rag_optimized.json")` serializes all modules' optimized few-shot examples and instructions. Later, `new_rag.load("rag_optimized.json")` restores the program for immediate use without recompiling. This serialization makes it practical to compile offline once and then serve by loading the saved parameters, with no recompilation overhead in the serving environment.

```diagram
en/2026-09-24-932e209d-06
```

Separating compilation from serving means there is no additional LLM call overhead in the serving environment.

### Extending to Multi-hop Reasoning

Beyond simple RAG, multi-hop reasoning — where evidence is accumulated over multiple retrieval steps — is an area where DSPy particularly shines. You can naturally express in Python code a structure that calls `dspy.Retrieve` multiple times and refines each step's query using the results of the previous step. Importantly, because each retrieval query generation step is abstracted as an independent module, the compiler optimizes the first query generation and the second query generation separately. Each stage can have a different set of few-shot examples within the same task, enabling fine-grained per-stage performance control.

---

## Performance Characteristics and Comparison with Alternatives

### Actual Performance Gains from DSPy Optimization

There is a pattern consistently reported in the DSPy paper and community benchmarks. On complex multi-step reasoning tasks, **10–40%** performance improvement over the unoptimized baseline is observed. The gains are smaller on simple classification or information extraction tasks, but are especially pronounced for multi-step tasks like multi-hop QA or code generation. The effect also tends to be more pronounced on smaller models. Powerful models like `gpt-4o` already have strong instruction-following ability and leave less room for improvement, but few-shot optimization has a large impact on `gpt-4o-mini` and open-source models.

```diagram
en/2026-09-24-932e209d-07
```

The higher the task complexity, the larger the effect of DSPy optimization.

### Comparison with Alternatives

**LangChain/LlamaIndex** and DSPy serve different purposes. LangChain focuses on pipeline orchestration and does not address prompt optimization. The two frameworks are not competitors — they are complementary. It's perfectly valid to compose a pipeline structure with LangChain and use DSPy to optimize the prompts at each stage.

Compared to **OpenAI Evals**, the roles are clearly distinct. Evals is an evaluation tool that measures how well a prompt is working; DSPy is an optimization tool that automatically finds a prompt that works better.

DSPy's differentiator compared to **Automatic Prompt Engineering (APE)** — approaches that ask an LLM to suggest better prompts — is **pipeline-level optimization**. APE improves a single prompt; DSPy optimizes an entire program composed of multiple connected modules.

| Tool | Primary purpose | Optimization scope | Requires training data |
|---|---|---|---|
| DSPy | Automatic prompt optimization | Entire program | Yes (20+ examples) |
| LangChain | Pipeline orchestration | N/A | No |
| APE (general) | Single prompt improvement | 1 prompt | A few |
| Fine-tuning | Training model weights | Model itself | Hundreds to thousands |

### When to Choose DSPy

Three conditions summarize when DSPy is most effective. First, **there must be a clear evaluation metric for the task**. Without an automatically measurable indicator — accuracy, F1, fact inclusion — the compiler has no optimization signal. Second, **you must be able to collect training examples**. A minimum of 20–50 input/output examples is required. Third, **the pipeline must be executed repeatedly**. To recoup the LLM call cost invested in compilation, the optimized program must run enough times.

---

## Considerations for Production Deployment

### Compilation Cost and Caching Strategy

DSPy compilation has a cost. Using the MIPRO optimizer can generate hundreds of LLM calls, and the more powerful the model, the higher the cost. The most important settings for controlling this are `max_bootstrapped_demos` and `num_candidates`. Lowering them reduces the search space and cuts cost, but may also reduce optimization quality. A realistic strategy is to start with low values and increase them incrementally.

DSPy caches LLM calls via `dspy.cache`. During development, when you run multiple experiments on the same input, the cache significantly reduces the cost of repeated calls. However, using cached results for actual optimization evaluation produces incorrect measurements, so it's best to clear or disable the cache before final evaluation.

```diagram
en/2026-09-24-932e209d-08
```

Keep compilation and serving clearly separated so that compilation cost doesn't carry over into serving cost.

### Common Mistakes and Pitfalls

**Data leakage** is the most common mistake. If the training examples used for compilation overlap with the test examples used for final performance evaluation, you get an overfitted result. Train, validation, and test sets must be strictly separated. In particular, watch out for situations where some of the examples collected during bootstrapping end up in the evaluation set.

**Over-trusting the metric** also warrants caution. Even if automatic metrics are satisfied, answer quality from the user's perspective may still be poor. LLM-as-a-judge patterns in particular inherit the biases of the evaluating LLM. If GPT-4 generates answers and GPT-4 also evaluates them, the system may optimize toward GPT-4's preferred style — so running human evaluation in parallel is the safer approach.

**Version mismatch** is also easy to overlook. Saved parameters are tied to the program structure at the time of compilation. Adding a module or modifying a signature will break compatibility with an existing save file. Always include program version information in the parameter file, and establish a team norm that a structural change requires recompilation.

### Monitoring and Deciding When to Recompile

When monitoring DSPy programs in production, track two metrics continuously. The first is **task performance metrics**: sample the same metric used during compilation and measure it in production. A meaningful drop below the compile-time baseline is a signal to recompile. The second is **input distribution shift**: if the user queries or document distribution changes significantly, the existing few-shot examples may no longer be representative.

Recompilation frequency depends on service characteristics, but a common pattern is to set model version updates and the accumulation of enough production data to construct better training examples as recompilation triggers. DSPy also supports incremental compilation, which starts from an existing compiled result and applies additional optimization on top.

```diagram
en/2026-09-24-932e209d-09
```

Since recompilation has a cost, the efficient approach is: monitor → diagnose → recompile the minimal scope necessary.

### Scaling and Migration Considerations

The most practical entry point when a team first adopts DSPy is to **replace only some modules** of an existing LLM pipeline with DSPy. Trying to migrate everything at once means simultaneously preparing training data, designing metrics, and building compilation infrastructure — a substantial burden. Starting with the module that is most performance-unstable or most expensive to tune, then expanding incrementally, is the stable approach.

When sharing the same DSPy program across multiple services, it's recommended to version-control compiled parameters in an artifact store (e.g., MLflow, Weights & Biases). Tracking pipeline version and parameter version together allows you to maintain a reproducible history of which compiled result produced which performance level.

---

## Closing Thoughts

### Key Takeaways

DSPy is an approach where a compiler automates the repetitive manual prompt work in LLM pipeline development. You declare the task spec with signatures, select a reasoning pattern with modules, and the optimizer automatically optimizes few-shot examples and instructions. The core benefits of this paradigm are three. First, when you swap models, simply recompiling regenerates the optimal prompt. Second, in complex multi-stage pipelines, each module can be optimized independently, making it possible to identify and fix performance bottlenecks. Third, optimization results can be serialized and used in the serving environment with no recompilation overhead.

### When to Apply DSPy

DSPy is a good fit for projects that have a clear evaluation metric, at least a few dozen training examples, and a repeatedly executed pipeline. On the other hand, if you're working on a one-off prototype, a creative generation task that's hard to evaluate automatically, or a case where prompt engineering is already producing sufficient results, the cost of adoption may outweigh the benefit. For multi-hop RAG, complex reasoning pipelines, or situations where you want to get performance from a smaller model that approaches that of a much larger one, DSPy is currently one of the most systematic approaches available. The official DSPy documentation and examples are at [https://dspy.ai](https://dspy.ai).
