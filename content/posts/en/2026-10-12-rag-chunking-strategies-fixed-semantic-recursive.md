---
title: "RAG Chunking Strategies — Fixed, Semantic, and Recursive Compared"
date: "2026-10-12 02:09"
category: "AI"
tags: ["RAG", "chunking", "vector search", "LangChain", "embedding"]
excerpt: "A practical comparison of Fixed-Size, Recursive, and Semantic chunking strategies for RAG systems, with guidance on when to use each."
koSlug: "2026-10-12-RAG-청킹-전략-—-Fixed·Semantic·Recursive-비교"
---

## Table of Contents

1. Overview
2. Why Chunking Determines RAG Quality
3. Fixed-Size Chunking — The Power and Limits of Simplicity
4. Recursive Chunking — Splitting Along Document Structure
5. Semantic Chunking — Splitting at Meaning Boundaries
6. Strategy Comparison and Selection Criteria
7. Considerations for Production Environments
8. Closing Thoughts

---

## Overview

RAG (Retrieval-Augmented Generation) is an architecture where an LLM generates answers by referencing external documents. One of the most critical factors determining retrieval quality in this system is **chunking** — the criteria and granularity by which you split the source documents. A poor chunking strategy will structurally degrade retrieval accuracy no matter how good the embedding model or LLM is. Especially when dealing with documents where context continuity matters — contracts, technical docs, research papers — the choice of chunking method determines the overall trustworthiness of the RAG system.

### Background

In early RAG implementations, Fixed-Size splitting at 512 tokens or 500 characters became the de facto standard. It has clear advantages — it's fast and predictable — but it frequently cuts sentences in the middle or scatters a single logical concept across multiple chunks. This leads to repeated situations where vector search misses the relevant chunk, or only partial information reaches the LLM and answer quality suffers. As awareness has grown that chunking is not mere preprocessing but the actual design of retrievability, Recursive and Semantic chunking have attracted attention.

### Limitations of the Existing Approach

The core problem with Fixed-Size is that it completely ignores the semantic structure of text. When a sentence is cut at a chunk boundary — like "G1GC divides the heap into Regions to make pause times predictable. To accomplish this, each Region—" — both chunks carry incomplete information. Neither chunk fully explains "the purpose and mechanism of G1GC Region partitioning," so even a directly relevant query won't retrieve the right chunk. Recursive and Semantic each try to overcome this limitation in different ways, and their effectiveness varies based on document characteristics and operational constraints.

---

## Why Chunking Determines RAG Quality

### How Vector Search Works

In a RAG system, documents are converted into embedding vectors at the chunk level and stored in a vector DB. At retrieval time, the query is also vectorized with the same embedding model, and the nearest chunks are found using cosine similarity or dot product. For this to work well, each chunk must contain a complete "unit of meaning" so that similarity to the query vector is computed accurately.

An embedding model maps input text into a fixed-dimensional vector space. If you turn a 3-page document on "Java GC algorithms" into a single chunk, the resulting vector sits somewhere in a broad semantic region around "Java GC." A chunk containing only "G1GC's Region partitioning mechanism" generates a much more tightly concentrated vector on that topic, yielding higher similarity scores against queries on the same subject. Chunking directly determines retrieval precision.

```diagram
en/2026-10-12-73776053-01
```

The more completely a chunk captures a unit of meaning, the more accurately similarity to the query vector is computed, and the higher the retrieval quality.

### The Relationship Between Chunk Size and Retrieval Accuracy

Chunk size has a nonlinear relationship with retrieval accuracy. There is empirical evidence that many document types perform best in the 128–512 token range, but that is just an average guideline. For legal documents where a single clause can run hundreds of tokens, a 256-token chunk cuts through the middle of the clause and destroys the essential context. Conversely, for FAQ documents where question-answer pairs are within 50 tokens, a 512-token chunk mixes several QA pairs together and blurs the embedding vector.

Chunk size also affects how efficiently the LLM's context is used. A RAG system inserts the top-K retrieved chunks into the LLM prompt. If chunks are too large, K must be reduced, which limits the diversity of information provided. If chunks are too small, K must be increased, but the practical amount of information may actually decrease due to context window limits.

| Chunk size | Retrieval precision | Context sufficiency | Suitable document types |
|---|---|---|---|
| 64–128 tokens | High | Low | FAQ, short Q&A |
| 256–512 tokens | Medium | Medium | Technical docs, blog posts |
| 512–1024 tokens | Low | High | Papers, legal clauses |

### The Tradeoff Between Meaning Loss and Noise

Two problems to avoid in chunking are **meaning loss** and **noise injection**. Meaning loss occurs when a single logical concept is split across multiple chunks so it is never fully captured in any of them. Noise occurs when unrelated content is included in the same chunk, contaminating the embedding vector. The two problems are in tension — making chunks larger reduces meaning loss but increases noise, while making chunks smaller reduces noise but increases the risk of meaning loss.

Overlap, Recursive splitting, and Semantic splitting are the approaches designed to resolve this tradeoff. Each attempts to locate meaning boundaries in a different way, and their effectiveness varies based on document characteristics and operational cost constraints. Rather than the simplistic conclusion that "Semantic is always best," a practical approach that weighs document type and cost together produces more reliably stable results over time.

---

## Fixed-Size Chunking — The Power and Limits of Simplicity

### How It Works and How to Implement It

Fixed-Size chunking sequentially splits text into fixed-length pieces (by token count or character count). It is the most intuitive approach and works immediately without any NLP processing or embedding API calls. In LangChain for Python, `CharacterTextSplitter` handles this, accepting `chunk_size` (maximum chunk length) and `chunk_overlap` (overlap between adjacent chunks).

The core weakness of Fixed-Size is that it does not respect sentence or paragraph boundaries. When a sentence is cut in the middle — like "Java's GC manages memory automatically. This lets developers—" — both chunks carry incomplete information. To mitigate this, variants exist that split by token rather than character, or that use specific delimiters (newlines, periods) as the primary split points.

```python
from langchain.text_splitter import CharacterTextSplitter

# Fixed-size split with chunk_size=500, chunk_overlap=50
splitter = CharacterTextSplitter(
    separator="\n\n",       # Use paragraph boundaries as the primary delimiter
    chunk_size=500,
    chunk_overlap=50,
    length_function=len,
)

text = """
Java's garbage collector (GC) automatically reclaims objects that are no longer referenced.
G1GC divides the heap into fixed-size Regions to make GC pause times predictable.

ZGC is designed to achieve sub-millisecond pauses even on heaps larger than 1 TB.
It uses load barriers to perform GC work concurrently with application threads.
"""

chunks = splitter.split_text(text)
# Result: 2 chunks — split at the paragraph boundary ("\n\n")
# chunks[0]: "Java's garbage collector ... pause times predictable."
# chunks[1]: "ZGC is designed ... application threads."
```

Specifying `separator="\n\n"` uses paragraph boundaries as the preferred split point, which reduces the risk of meaning loss compared to pure Fixed-Size. If a segment still exceeds the target size after splitting on the delimiter, it is force-split by character.

### The Overlap Technique

`chunk_overlap` is the primary mitigation for Fixed-Size chunking. By repeating the end of chunk A at the beginning of chunk B, it reduces retrieval failures caused by context breaks at boundaries. With `chunk_size=500, overlap=50`, the last 50 characters of chunk A are identical to the first 50 characters of chunk B.

```diagram
en/2026-10-12-73776053-02
```

Overlap mitigates context loss near boundaries but increases storage and embedding costs. At `overlap=50`, roughly 10% of the total text is stored redundantly, so 10–15% is the commonly recommended range.

### When to Choose Fixed-Size

Fixed-Size remains a valid choice under the following conditions. First, when documents are structurally homogeneous. For something like a product description catalog where each entry has similar length and format, fixed-size splitting has a high chance of naturally aligning with meaning boundaries. Second, when indexing speed matters. Semantic chunking requires an embedding API call per sentence, which can be tens of times slower. If you need to index large volumes of documents in real time, Fixed-Size is the practical choice. Third, when you need to validate quickly in the prototype phase. Chunking strategy can be changed later, so starting with simple Fixed-Size to build the system and then upgrading the strategy after performance bottlenecks surface reduces risk.

---

## Recursive Chunking — Splitting Along Document Structure

### The Mechanism of Recursive Splitting

Recursive chunking defines a prioritized list of delimiters and descends to the next delimiter recursively only when a chunk exceeds the target size. LangChain's `RecursiveCharacterTextSplitter` tries delimiters in the default order `["\n\n", "\n", " ", ""]`. It first tries to split on double newlines (paragraph boundaries), then on single newlines (sentence boundaries) if the chunk is still too large, then on spaces, and finally on individual characters as a last resort.

The advantage of this approach is that it **preserves the largest possible semantic unit while fitting the target size**. Unlike Fixed-Size, the delimiters can be customized to match the document's structure. For Markdown documents you can use `["## ", "### ", "\n\n", "\n"]`, and for Python code you can use `["\nclass ", "\ndef ", "\n\n", "\n"]`.

```diagram
en/2026-10-12-73776053-03
```

Splitting preserves semantic units as much as possible according to delimiter priority, with character-level splitting used only as a last resort.

### LangChain's RecursiveCharacterTextSplitter

`RecursiveCharacterTextSplitter` is currently one of the most widely used chunking implementations. The barrier to entry is low — only two or three lines of code change compared to simple Fixed-Size — and it produces better results than Fixed-Size for most text documents. The `from_language()` class method automatically selects delimiters optimized for a given programming language.

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter, Language

# For general text documents
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=512,
    chunk_overlap=64,
    separators=["\n\n", "\n", ".", " ", ""],  # In priority order
)

# Python code only — automatically uses class/function boundaries as delimiters
py_splitter = RecursiveCharacterTextSplitter.from_language(
    language=Language.PYTHON,
    chunk_size=512,
    chunk_overlap=64,
)

doc = """
## How G1GC Works

G1GC divides the entire heap into equal-sized Regions.
Each Region takes on one of the roles: Eden, Survivor, Old, or Humongous.

Each GC cycle selects which Regions to collect within the pause time target.
Regions with the highest garbage ratio are prioritized for collection.
"""

chunks = text_splitter.split_text(doc)
# Result: naturally split into H2 header + first paragraph / second paragraph
# Each chunk preserves a logical unit
```

When calling `from_language(Language.PYTHON)`, `\nclass `, `\ndef `, `\n\n`, `\n` are automatically used as delimiters, chunking code at function and class boundaries. This is particularly effective when applying RAG to a codebase or building a code search system.

### Effectiveness on Structured Documents

Recursive chunking shows a particularly strong effect on documents with explicit structure, such as Markdown, HTML, and source code. Specifying H2/H3 headers as delimiters enables section-level chunking so each chunk fully captures a single subtopic. In HTML documents, `</p>` and `</section>` tags can serve as delimiters.

On the other hand, for unstructured documents — novels, news articles, lecture transcripts — Recursive offers no meaningful advantage over Fixed-Size. In these documents the meaning boundaries lie in the content itself rather than in newlines or spaces, making embedding-based Semantic chunking more appropriate.

| Document type | Recursive effectiveness | Reason |
|---|---|---|
| Markdown / technical docs | Very high | Header delimiters enable section-level splitting |
| Python / Java source code | High | Class and function boundaries can be used directly |
| HTML web pages | Medium | Partial use of tag-based structure |
| News articles / essays | Low | Meaning boundaries are not in structure |
| Lecture transcripts | Low | Newlines have no relationship to meaning units |

---

## Semantic Chunking — Splitting at Meaning Boundaries

### Boundary Detection via Sentence Embeddings

Semantic chunking first splits text into individual sentences, then computes embedding similarity between adjacent sentences and marks points where meaning changes significantly as chunk boundaries. It is an algorithmic implementation of the intuition "if sentence A and sentence B are semantically similar, put them in the same chunk; otherwise, separate them."

The most basic implementation is **sliding-window similarity comparison**. Compute the cosine similarity of embeddings for sentences i and i+1, and mark the point as a split boundary when similarity falls below a threshold. Adjacent sentences are then merged to match the target chunk size. More sophisticated implementations compute similarity between groups of sentences rather than simple adjacent pairs, or find points where the rate of change in similarity spikes sharply.

```diagram
en/2026-10-12-73776053-04
```

Automatically creating a boundary at the point where the topic shifts to something semantically different is the core mechanism of Semantic chunking.

### Implementation and Key Parameters

LangChain's `SemanticChunker` uses `breakpoint_threshold_type` to select how boundaries are determined. `"percentile"` uses the nth percentile of the similarity distribution as the boundary; `"standard_deviation"` uses n standard deviations below the mean; `"interquartile"` treats outliers based on IQR as boundaries.

```python
from langchain_experimental.text_splitter import SemanticChunker
from langchain_openai import OpenAIEmbeddings

embeddings = OpenAIEmbeddings(model="text-embedding-3-small")

# percentile mode: split at points below the 80th percentile of similarity
semantic_splitter = SemanticChunker(
    embeddings=embeddings,
    breakpoint_threshold_type="percentile",
    breakpoint_threshold_amount=80,
)

text = """
Carbon neutrality means balancing greenhouse gas emissions with absorption.
Transitioning to renewable energy and improving energy efficiency are essential.
Solar and wind power are key technologies to replace fossil fuels.

Meanwhile, Java garbage collection is a technology for automating memory management.
G1GC and ZGC are designed to minimize pauses on large heaps.
"""

chunks = semantic_splitter.split_text(text)
# Result: 2 chunks — carbon neutrality topic / GC topic split apart
# This boundary is difficult to find with Fixed-Size
```

`breakpoint_threshold_amount=80` means split at points where similarity is below the 80th percentile. Raising this value makes boundaries easier to create, increasing chunk count; lowering it makes boundaries stricter, reducing chunk count. The optimal value differs per document type, so tuning while measuring actual query and answer quality is essential.

### The Performance-Cost Tradeoff

The biggest drawback of Semantic chunking is **cost and speed**. Every sentence in the document must be processed through the embedding API, which multiplies API call costs by tens of times compared to Fixed-Size. For a 100,000-token document, Fixed-Size completes instantly with no embeddings, while Semantic chunking requires hundreds of embedding API calls. Using a local embedding model (sentence-transformers family) eliminates API costs but can increase processing time to several minutes.

Semantic chunking quality also depends heavily on the quality of sentence splitting. For languages where sentence endings are less clear-cut, or for technical documents with many abbreviations and symbols, sentence splitting itself becomes inaccurate and throws off the subsequent similarity computation. Threshold tuning also needs to be done differently per document type, which increases operational complexity.

> Semantic chunking carries as much risk of "splitting or merging chunks badly with a wrong threshold" as it has potential for "finding the best chunk boundaries."

---

## Strategy Comparison and Selection Criteria

### Performance Characteristic Comparison

Comparing the three strategies across five dimensions makes each one's strengths and weaknesses clear. Fixed-Size is overwhelming in speed and predictability. Recursive has better meaning preservation than Fixed-Size on structured documents at no added cost. Semantic has the highest potential accuracy at meaning boundaries, but cost and operational complexity rise with it.

```diagram
en/2026-10-12-73776053-05
```

A decision flow for selecting a strategy based on document structure and the importance of meaning boundaries.

| Criterion | Fixed-Size | Recursive | Semantic |
|---|---|---|---|
| Indexing speed | Very fast | Fast | Slow |
| API cost | None | None | High |
| Meaning preservation | Low | Medium–High | High |
| Implementation complexity | Low | Low | Medium–High |
| Parameter tuning | Little | Medium | Much |
| Suitability for structured docs | Low | High | Medium |

### Comparison with Alternative Techniques

Beyond these three strategies, variations such as **Parent-Child chunking** and **Proposition chunking** are gaining attention. Parent-Child chunking generates both large chunks (Parent) and small chunks (Child) simultaneously, performs vector search with the Child chunks, and passes the full Parent to the LLM. It can achieve both retrieval precision and contextual sufficiency at the same time, and is increasingly adopted in production RAG systems.

```diagram
en/2026-10-12-73776053-06
```

Parent-Child chunking separately optimizes retrieval precision (Child) and richness of context (Parent).

Proposition chunking extracts independent factual propositions from documents and makes each one a chunk. It requires LLM-based preprocessing, making it very expensive. However, because each chunk contains a complete unit of meaning, it achieves the highest retrieval accuracy. It is increasingly applied in domains where the cost of a wrong answer is high — medical, legal, financial regulations — where the expense is justified.

### Which Situation Calls for Which Strategy

Practically, strategy selection comes down to three axes: document type, indexing frequency, and accuracy requirements. If documents are structured like Markdown or code, start with Recursive as the default. You get higher quality than Fixed-Size at no additional cost, and most corporate internal technical documentation falls into this category. For unstructured documents where retrieval accuracy is the core requirement, consider Semantic — but budget time for threshold tuning and embedding costs upfront. When real-time indexing or rapid prototyping is needed, Fixed-Size is still a reasonable starting point, and migrating to another strategy after enough real query data has accumulated reduces risk.

---

## Considerations for Production Environments

### Common Mistakes and Pitfalls

The most frequent mistake in RAG chunking is **fixing chunk size without validation**. "Traditional" values like 256 or 512 tokens get applied without any verification, and performance problems end up being blamed elsewhere (LLM model, prompt). Chunking strategy must be validated with real documents and real queries. Evaluation frameworks like RAGAS or LlamaIndex's `ResponseEvaluator` let you quantitatively compare chunking strategies using Faithfulness, Relevancy, and Context Precision metrics.

The second pitfall is **metadata loss**. If you do not store the source information (filename, URL, page number) and section context alongside chunks when creating them, you cannot trace where a retrieved chunk came from and cannot implement citation features. LangChain's `Document` object provides a `metadata` dictionary — use it.

```diagram
en/2026-10-12-73776053-07
```

Storing metadata together with chunks enables source tracing and citation, increasing the trustworthiness of the RAG system.

The third mistake is **chunk boundaries that cut through code blocks or tables**. Technical documents frequently contain Markdown code blocks (` ``` `) and tables. Chunking that does not account for them produces chunks containing only half a code block. You need to either add code block boundaries to the delimiter list or handle code blocks separately in a preprocessing step. Chunking after HTML parsing, or replacing specific patterns with markers before chunking, are approaches commonly used in real-world projects.

### Monitoring and Evaluation Metrics

After deploying a chunking strategy to production, continuous quality monitoring is necessary. **Context Precision** is the proportion of retrieved chunks that actually contributed to the answer. A low score signals that chunks contain too much noise or that retrieval is returning unrelated chunks. **Context Recall** measures whether all information needed to generate the correct answer is contained in the retrieved chunks. A low score suggests that critical information was cut off at a chunk boundary.

| Metric | Suspected problem when low | Remediation direction |
|---|---|---|
| Context Precision | Too much noise in chunks | Reduce chunk size or introduce Semantic chunking |
| Context Recall | Critical information dispersed | Increase chunk size or increase Overlap |
| Answer Relevancy | Retrieval itself inaccurate | Introduce query expansion or re-ranking |
| Faithfulness | LLM hallucination | Review chunk context sufficiency |

### Scaling and Migration

Changing chunking strategy requires re-indexing the entire vector DB. In a production system this can be a major undertaking, so a migration strategy must be designed in advance. **Blue-green re-indexing** is recommended — keep the existing vector DB intact while building a new vector DB with the new chunking strategy, then gradually shift traffic and compare quality with an A/B test. Keep the old DB for a period as a rollback option.

For large document collections (millions of records), the embedding cost of Semantic chunking can reach thousands of dollars. In these cases, rather than applying Semantic to the entire collection, a **tiered strategy** that applies Semantic only to the high-query-frequency or high-accuracy-critical subset and processes the rest with Recursive is more cost-effective. Designing the pipeline so that different chunking strategies can be applied per document type enables flexible long-term operations.

---

## Closing Thoughts

### Key Takeaways

In a RAG system, chunking is the critical step that designs retrievability. Fixed-Size chunking is fast and predictable but ignores semantic boundaries in documents, causing relevant information to be scattered across multiple chunks. Recursive chunking uses the document's structural hierarchy (paragraphs, sentences, words) as priorities to improve meaning preservation without added cost, making it the right default for most structured documents. Semantic chunking detects meaning boundaries via embedding similarity to produce potentially the most accurate chunks, but comes with preprocessing costs and parameter tuning overhead. Parent-Child and Proposition approaches can push accuracy higher still, but operational complexity and cost go up another level.

### Decision Criteria

Practically, choosing a chunking strategy starts with three questions. **"Is the document structured?"** — If it's Markdown, HTML, or source code, try Recursive first. You get higher quality than Fixed-Size at no added cost. **"Is retrieval accuracy more important than cost?"** — In domains where the cost of a wrong answer is high, such as legal review or medical information retrieval, you can justify the additional cost of Semantic chunking or Parent-Child. **"Are you still in the prototype phase?"** — Early on, validate quickly with Recursive, and once you have enough real query data, use an evaluation framework like RAGAS to quantitatively compare strategies before deciding whether to migrate. Chunking strategy has a more direct impact on RAG quality than LLM model selection, and once applied it is hard to change due to re-indexing costs. Thorough review at the initial design stage pays off in the long run.
