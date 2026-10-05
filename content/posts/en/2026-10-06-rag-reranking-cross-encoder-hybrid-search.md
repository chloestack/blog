---
title: "RAG Re-ranking Pipeline — Improving Accuracy with Cross-Encoders and Hybrid Search"
date: "2026-10-06 02:09"
category: "AI"
tags: ["RAG", "Re-ranking", "Cross-Encoder", "hybrid search", "vector search"]
excerpt: "A practical guide to combining hybrid search (BM25 + Dense Retrieval) and Cross-Encoder re-ranking to improve retrieval quality in RAG pipelines."
koSlug: "2026-10-06-RAG-Re-ranking-파이프라인-—-Cross-Encoder와-하이브리드-검색으로-정확도-높이기"
---

## Table of Contents

1. Overview
2. Core Structure of the Re-ranking Pipeline
3. Hybrid Search — Combining BM25 and Dense Retrieval
4. Implementing Cross-Encoder Re-ranking
5. Performance Comparison and Trade-offs
6. Considerations for Production
7. Closing Thoughts

---

## Overview

### The Root of the Retrieval Quality Problem

In RAG (Retrieval-Augmented Generation) systems, generation quality depends directly on what the retrieval stage returns. No matter how capable the language model is, if low-relevance documents are included in the context, answer accuracy drops sharply and hallucinations increase. This post covers how to combine **Cross-Encoder Re-ranking** and **hybrid search** to meaningfully improve retrieval quality in a RAG pipeline, and explains concretely why the two techniques complement each other and how to wire them together.

Retrieval relevance problems show up in two main ways. The first is when documents that are semantically similar but do not actually contain the information needed to answer the question rank at the top. Dense Retrieval captures overall semantic similarity well, but tends to miss the key keywords in a question or specific numbers and proper nouns. The second is the limitation of keyword-based search (BM25): it is strong at term matching but cannot handle synonyms or context-dependent expressions. The weaknesses of the two approaches are mirror images of each other, so combining them produces a synergy.

```diagram
2026-10-06-7b33d5f3-01
```

In the RAG pipeline, hybrid search broadens the candidate set, and Cross-Encoder re-ranking then filters it down to only the highly relevant documents.

### The Limits of Single-Retrieval Approaches

The most common approach in early RAG implementations is simple vector similarity search: embed the query, compute cosine similarity against document embeddings, and return the top-k. It is easy to implement and fast even over large document collections.

In practice, though, the problem becomes visible quickly. Especially in finance, law, and medicine — domains with many specialized terms — when the embedding model has not been sufficiently trained on certain concepts, documents that look superficially similar can contain completely different information. Bi-Encoder-based embedding models encode the query and each document independently, which means they cannot directly capture the interaction between the two texts. That structural limitation is the starting point for the re-ranking strategy.

---

## Core Structure of the Re-ranking Pipeline

### Structural Difference Between Bi-Encoder and Cross-Encoder

To understand re-ranking, you first need a clear picture of how **Bi-Encoders** and **Cross-Encoders** differ. A Bi-Encoder processes the query and document through separate encoders, producing fixed-size vectors, then computes the similarity between those vectors. Because document embeddings can be pre-computed and indexed, this approach is essential for large-scale retrieval — it is how you can search millions of documents in milliseconds.

A Cross-Encoder works completely differently. It concatenates the query and document into a single input sequence, feeds the whole thing into a transformer model, and directly predicts a relevance score. The input is structured as `[CLS] query [SEP] document [SEP]`, and the model uses full token-level attention between the two texts to make its judgment. This gives much higher accuracy than a Bi-Encoder, but because inference must run separately for every (query, document) pair, it is slow.

```diagram
en/2026-10-06-7b33d5f3-02
```

The Bi-Encoder trades interaction for speed; the Cross-Encoder trades speed for accuracy. Re-ranking uses both properties in sequence.

### Why Re-ranking Improves Accuracy

The core of the re-ranking strategy is using each model's properties in a cascade. In the first stage, a fast Bi-Encoder (or hybrid search) quickly narrows the full document corpus down to a candidate set — typically the top 20 to 100. In the second stage, a Cross-Encoder scores each candidate precisely for relevance and reorders them. Only the top 3 to 5 documents are ultimately passed to the LLM.

This works because it separates the retrieval problem into two different difficulty levels. The loose judgment — "is there any chance this document is related to the question?" — is handled quickly by the Bi-Encoder. The precise judgment — "does this document actually answer the question?" — is handled by the Cross-Encoder. BEIR benchmark results show that adding re-ranking on top of BM25 or standalone Dense Retrieval produces an average improvement of 5–15% on nDCG@10.

```diagram
en/2026-10-06-7b33d5f3-03
```

Ranking the entire corpus directly with a Cross-Encoder is not realistic; this two-stage pipeline is the practical balance between quality and speed.

### Pipeline Design Principles

There are key principles to keep in mind when designing a re-ranking pipeline. First, **separate Recall and Precision**. The goal of stage-one retrieval is to maximize recall — not missing relevant documents is the priority, and including a few low-relevance ones is acceptable. The re-ranking stage, by contrast, is about improving precision: selecting only the genuinely relevant documents from the candidates.

Second, **the trade-off between candidate count and quality**. The more candidates you pull in stage one, the greater the burden on the Cross-Encoder and the higher the latency. Too few candidates risks missing relevant documents. In practice, 20 to 50 tends to be a reasonable balance. Third, **model selection**. The Cross-Encoder model must account for the task domain and language. For a Korean RAG system, use a multilingual or Korean-specific model. Language mismatch is the most common cause of significantly degraded re-ranking quality.

---

## Hybrid Search — Combining BM25 and Dense Retrieval

### How Sparse and Dense Search Complement Each Other

**BM25** is a classic keyword-based retrieval algorithm that improves on TF-IDF. It computes relevance from the frequency of words appearing in a document and their inverse document frequency. When a specific keyword is in the query and that keyword appears exactly in the document, BM25 performs well — especially when exact term matching matters, such as with proper nouns, product names, code snippets, and version numbers.

**Dense Retrieval**, on the other hand, uses BERT-based embedding models to map text into a high-dimensional vector space. It handles synonyms, paraphrases, and semantically similar concepts well. Searching "myocardial infarction" will still return results about "heart attack," and searching "automobile" will return results about "vehicle." But it is weak on domain-specific terms and concepts the embedding model was not adequately exposed to during pre-training.

| Property | BM25 (Sparse) | Dense Retrieval | Hybrid |
|---|---|---|---|
| Exact keyword matching | ✅ Strength | ❌ Weakness | ✅ |
| Semantic similarity | ❌ Weakness | ✅ Strength | ✅ |
| New domain-specific terms | ✅ Strength | ❌ Weakness | ✅ |
| Multilingual handling | ❌ Requires per-language morphological analysis | ✅ Multilingual embeddings | ✅ |
| Indexing cost | Low | High | Medium |
| Search latency | 2–5ms | 10–50ms | 10–60ms |

### Merging Scores with Reciprocal Rank Fusion

**Reciprocal Rank Fusion (RRF)** is the simplest and most effective way to combine results from the two retrieval methods. RRF computes a combined score using only the rank of each document in each retrieval result, not the raw score values. Because it does not use absolute scores, there is no need to normalize scores across different scales — a significant advantage.

The RRF score is computed as `RRF(d) = Σ 1 / (k + rank_i(d))`, where `k` is typically 60 and serves to dampen the influence of low-ranked documents. For example, a document ranked 1st by BM25 and 5th by Dense Retrieval gets an RRF score of `1/(60+1) + 1/(60+5) = 0.0164 + 0.0154 = 0.0318`. This gives a higher score to documents that rank near the top in both retrieval methods than to documents that rank high in only one.

```diagram
en/2026-10-06-7b33d5f3-04
```

Because RRF uses only the ranks from both retrieval results, it merges them stably without any score normalization.

### Hybrid Search Implementation — RRF Code Example

The code below implements hybrid search using the `rank_bm25` library and `sentence-transformers`, focusing on the core logic that merges BM25 and Dense retrieval results with RRF.

```python
from rank_bm25 import BM25Okapi
from sentence_transformers import SentenceTransformer
import numpy as np
from typing import List, Tuple

def reciprocal_rank_fusion(
    ranked_lists: List[List[int]],
    k: int = 60
) -> List[Tuple[int, float]]:
    """Merge multiple ranked lists using RRF."""
    scores: dict[int, float] = {}
    for ranked in ranked_lists:
        for rank, doc_id in enumerate(ranked):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank + 1)
    # Sort by score descending and return
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)

class HybridRetriever:
    def __init__(self, documents: List[str]):
        self.documents = documents
        # BM25: whitespace tokenization (replace with a morphological analyzer for Korean)
        tokenized = [doc.split() for doc in documents]
        self.bm25 = BM25Okapi(tokenized)
        # Dense: multilingual embedding model (supports Korean)
        self.encoder = SentenceTransformer("BAAI/bge-m3")
        self.doc_embeddings = self.encoder.encode(documents, normalize_embeddings=True)

    def retrieve(self, query: str, top_k: int = 20) -> List[Tuple[int, float]]:
        # Compute BM25 ranking
        bm25_scores = self.bm25.get_scores(query.split())
        bm25_ranked = np.argsort(bm25_scores)[::-1][:top_k].tolist()

        # Compute Dense ranking (dot product = cosine similarity when normalized)
        query_emb = self.encoder.encode(query, normalize_embeddings=True)
        dense_scores = self.doc_embeddings @ query_emb
        dense_ranked = np.argsort(dense_scores)[::-1][:top_k].tolist()

        # Merge with RRF and return top top_k
        fused = reciprocal_rank_fusion([bm25_ranked, dense_ranked])
        return fused[:top_k]
        # Result: [(doc_id, rrf_score), ...] in descending order
```

Setting `normalize_embeddings=True` makes the dot product (`@`) equivalent to cosine similarity, so no separate normalization is needed. For Korean documents, replacing BM25's tokenizer with a morphological analyzer (`kiwipiepy`, `konlpy`, etc.) rather than whitespace splitting is important. Without morphological analysis, inflected forms of the same word are treated as different tokens, which degrades BM25 matching quality significantly.

---

## Implementing Cross-Encoder Re-ranking

### Criteria for Choosing a Cross-Encoder Model

The choice of Cross-Encoder model affects both accuracy and latency. The most commonly used options today are:

| Model | Parameters | Language Support | Accuracy | Inference Time (20 candidates, GPU) |
|---|---|---|---|---|
| `BAAI/bge-reranker-v2-m3` | 568M | Multilingual | High | ~300ms |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | 22M | English | Medium | ~50ms |
| `Cohere Rerank API` | Undisclosed | Multilingual | Very High | ~500ms (includes API latency) |
| `mixedbread-ai/mxbai-rerank-large-v1` | 435M | Multilingual | High | ~250ms |

For a multilingual RAG system that includes Korean, `BAAI/bge-reranker-v2-m3` is currently one of the best open-source options. In environments without a GPU, a lightweight model is the practical alternative. Managed services like the Cohere Rerank API eliminate model management overhead, but you need to account for API call costs, latency, and the implications of sending data to an external service.

The most important criterion when choosing a Cross-Encoder is **the target domain and language**. There are large performance differences between general-domain text and specialized domains like law, finance, or medicine. Whenever possible, run a small evaluation on your actual production data and compare models directly.

```diagram
en/2026-10-06-7b33d5f3-05
```

GPU availability and language requirements are the two key decision points when selecting a Cross-Encoder model.

### Re-ranking Pipeline Implementation

The following is the complete pipeline that applies a Cross-Encoder to the candidate documents returned by hybrid search, including batch processing and score-based reordering.

```python
from sentence_transformers import CrossEncoder
from typing import List, Tuple

class CrossEncoderReranker:
    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3"):
        # The Cross-Encoder takes (query, document) pairs and directly predicts a relevance score
        self.model = CrossEncoder(model_name, max_length=512)

    def rerank(
        self,
        query: str,
        candidate_docs: List[str],
        top_n: int = 5
    ) -> List[Tuple[int, float, str]]:
        # Build (query, document) pairs — the Cross-Encoder input format
        pairs = [(query, doc) for doc in candidate_docs]
        # Batch inference: adjust batch_size based on GPU memory
        scores = self.model.predict(pairs, batch_size=16, show_progress_bar=False)
        indexed = [(i, float(scores[i]), candidate_docs[i]) for i in range(len(scores))]
        reranked = sorted(indexed, key=lambda x: x[1], reverse=True)
        return reranked[:top_n]
        # Example result: [(2, 0.923, "Relevant document content..."), (0, 0.871, "..."), ...]

def run_rag_pipeline(query: str, retriever: HybridRetriever, reranker: CrossEncoderReranker):
    # Stage 1: collect 20 candidates via hybrid search
    candidates = retriever.retrieve(query, top_k=20)
    candidate_docs = [retriever.documents[doc_id] for doc_id, _ in candidates]
    # Stage 2: reorder to top 5 with Cross-Encoder
    reranked = reranker.rerank(query, candidate_docs, top_n=5)
    return [doc for _, _, doc in reranked]
```

`batch_size` needs to be tuned based on GPU memory and candidate document length. `max_length=512` is in tokens, so long documents must be split into appropriately sized chunks before this step. Chunks that are too small lose context; chunks that are too large reduce the Cross-Encoder's ability to judge relevance accurately. In general, chunks of 256–512 tokens with a 50–100 token overlap work well.

### Interaction Between Chunking Strategy and Re-ranking

How you chunk documents directly affects re-ranking performance. When you embed and search at the chunk level, multiple chunks from the same document can end up in the candidate set. In that case, when assembling the context to pass to the LLM after re-ranking, it is worth considering **Parent Document Retrieval**: judge relevance at the chunk level, but include the broader passage from the original document that the chunk belongs to in the final context.

You can also run re-ranking at the full document level. In that case, the Dense Retrieval stage uses chunk embeddings, but the re-ranking stage feeds the Cross-Encoder the broader context of the original document the chunk came from. However, if the original document is long, it will hit the Cross-Encoder's `max_length` limit, so you will need an intermediate step to summarize the document or extract only the relevant chunks. Whatever strategy you choose, verifying the **alignment between chunk boundaries and the Cross-Encoder's input length limit** up front is the foundation of a stable pipeline.

---

## Performance Comparison and Trade-offs

### Benchmarking Retrieval Quality

The effectiveness of a re-ranking pipeline can be verified quantitatively through benchmark data. The BEIR (Benchmarking Information Retrieval) dataset is the standard benchmark for measuring retrieval performance across diverse domains. The primary metric is **nDCG@10** (Normalized Discounted Cumulative Gain at 10), which expresses the relevance quality of the top-10 results as a value between 0 and 1.

Looking at typical results: Dense Retrieval improves on BM25 alone by an average of 5–10%; hybrid search (BM25 + Dense + RRF) adds another 3–7%; and adding Cross-Encoder re-ranking on top yields up to a 15–25% improvement over BM25 alone. These numbers vary considerably by domain and question type, so building your own evaluation set is essential for any real service.

```diagram
en/2026-10-06-7b33d5f3-06
```

Each stage incrementally improves retrieval quality over the previous approach, with the highest accuracy achieved when re-ranking is applied at the end.

### Latency vs. Accuracy Trade-off

Adding pipeline stages increases latency. Approximate figures measured in real production environments are as follows.

| Stage | Latency (ms) | nDCG@10 Improvement | Notes |
|---|---|---|---|
| BM25 only | 2–5 | Baseline | Includes morphological analysis |
| Dense Retrieval (FAISS) | 10–30 | +8% | GPU embedding |
| Hybrid (BM25+Dense+RRF) | 15–50 | +13% | Both searches run in parallel |
| + Cross-Encoder Re-ranking (GPU) | 200–500 | +22% | Based on 20 candidates |
| + Cross-Encoder Re-ranking (CPU) | 1000–3000 | +22% | CPU-only server |

The majority of end-to-end latency comes from Cross-Encoder inference. With a GPU, it is on the order of a few hundred milliseconds; on CPU only, it can reach several seconds. For services where real-time response matters, you must measure this latency in advance and confirm it is within an acceptable range. Key strategies for reducing latency include reducing the candidate count (20→10), using a lighter-weight model, quantizing the model (INT8), and asynchronous processing. **Model quantization** in particular can improve inference speed 2–4× with minimal quality loss, making it effective in CPU environments.

### Which Combination to Use in Which Situation

Not every RAG system needs the same pipeline. Choose the right stages for your service's requirements.

```diagram
en/2026-10-06-7b33d5f3-07
```

Your response latency requirement is the first constraint to resolve; within that constraint, choose the combination that meets your accuracy target.

If the document domain is general text (news, Wikipedia, etc.), Dense Retrieval alone is often sufficient. When the domain contains many specialized terms, or when exact numbers, dates, or product names are likely to appear in queries, hybrid search is essential. Re-ranking's benefit is most pronounced for fact-based QA with a single correct answer. For creative generation or summarization tasks, re-ranking tends to add relatively less value.

---

## Considerations for Production

### Common Mistakes and Pitfalls

Here are the problems teams most often run into when introducing a re-ranking pipeline for the first time. The first pitfall is **deploying without evaluation**. It is easy to assume that adding re-ranking will always help, but if the Cross-Encoder model is a poor fit for the domain, it can actually make ranking worse. Always run a before/after comparison on real data and measure retrieval metrics like nDCG, MRR (Mean Reciprocal Rank), and Recall@k.

The second pitfall is **a mismatch between chunk length and the Cross-Encoder's `max_length`**. If you chunk documents at 1000 tokens but the Cross-Encoder's max_length is 512, the second half of each document gets cut off. The re-ranking is then based on only the first part of the document, so accuracy comes out lower than expected. Either size your chunks to fit within the Cross-Encoder's processing limit or use a model that supports a larger context.

The third is **a mismatch between the BM25 tokenizer and the language**. For Korean, using whitespace tokenization without morphological analysis means "먹었다", "먹는다", and "먹어" are all treated as different tokens. Applying a morphological analyzer reduces them all to the same stem, which significantly improves BM25 matching quality.

> If you change the pipeline without any evaluation metrics in place, you have no way to tell whether you improved things or made them worse. Build your retrieval quality evaluation set first, then change the pipeline.

### Monitoring and Debugging

Continuously monitoring retrieval quality in a production RAG system is critical, because as models and data change, retrieval performance can degrade.

```diagram
en/2026-10-06-7b33d5f3-08
```

Monitoring the distribution of re-ranking scores is the primary way to quickly detect anomalies in the pipeline.

Key metrics to monitor: First, **the distribution of re-ranking scores**. If the Cross-Encoder score for the top-ranked document is consistently low (e.g., below 0.5), it may signal a shift in query type or insufficient coverage in the document corpus. Second, **the score gap between the 1st and 2nd ranked documents**. A large gap is a positive sign that results are clearly differentiated. A very small gap means multiple documents have similar relevance, which increases the likelihood that the LLM will be confused by the context. Third, **p95 and p99 latency**. Cross-Encoder inference varies considerably based on candidate document length, so focus on the tail of the distribution rather than the mean.

### Scaling and Cost Management

As RAG system traffic grows, the re-ranking pipeline can become a bottleneck. Plan your scaling strategy in advance. The first strategy is **separating the model serving layer**. Isolating Cross-Encoder inference as its own microservice (Triton Inference Server, TorchServe, etc.) lets you scale it out independently from the retrieval service. The second is **caching**. Caching re-ranking scores for identical (query, document) pairs eliminates inference cost on repeated requests. Use a cache key derived from a normalized query (lowercased, whitespace-trimmed, etc.).

The third is **balancing cost and accuracy**. Managed services like the Cohere Rerank API charge per request, and cost varies by document count and length. At large scale, API costs can be substantial, so calculating the cost break-even point between a self-hosted model and an API service matters. For services with hundreds of thousands of retrieval requests per month, self-hosting usually becomes the more economical option.

| Strategy | Suitable Scale | Advantages | Watch Out For |
|---|---|---|---|
| API service (Cohere, etc.) | Small to medium | No model management | External data transfer, API costs |
| Self-hosted GPU server | Medium to large | Low latency, cost savings | Infrastructure management overhead |
| CPU-only + lightweight model | Cost-constrained environments | Low cost | High latency |
| Quantized model (INT8) | GPU memory-constrained | Higher speed, lower memory | Possible minor quality degradation |

---

## Closing Thoughts

### Key Takeaways

To summarize what this post covered: a **RAG re-ranking pipeline** consists of two main stages. The first is hybrid search, which combines BM25's keyword precision and Dense Retrieval's semantic flexibility via the RRF algorithm to maximize stage-one recall. The second is Cross-Encoder re-ranking, which uses the structural property of taking both query and candidate document as joint input to judge relevance precisely and refine the final context.

The cascading design — Bi-Encoder handling speed, Cross-Encoder handling accuracy — means the full pipeline can deliver high-quality context within a few hundred milliseconds even over large document collections. Adding hybrid search on top maintains stable performance in domains where exact keyword matching matters. Building a pipeline without evaluation metrics is always risky. Having your own evaluation set and quantitative metrics in place is the most important prerequisite for the entire process.

### When to Adopt

The re-ranking pipeline is worth introducing when at least one of the following applies. **When answer accuracy has a direct business impact** — in customer support, legal information retrieval, medical information systems, and similar contexts, the cost of a wrong document appearing in the context is high, which justifies the investment in re-ranking. **When the domain contains many specialized terms** — combining BM25 with dense retrieval significantly improves recall for specialized vocabulary that simple vector search struggles with. **When retrieval accuracy is already the bottleneck in an existing RAG system** — improving the retrieval stage first is more cost-effective than upgrading to a larger LLM.

There are also situations where you should reconsider. If real-time response (under 100ms) is a hard requirement and no GPU infrastructure is available, Cross-Encoder re-ranking may not be realistic. In that case, introducing hybrid search alone or using asynchronous processing (streaming responses) to reduce perceived latency are the alternatives. Because the effectiveness of each technique varies by domain and question type, the safest and most reliable approach is always to make decisions quantitatively, based on your own evaluation data.
