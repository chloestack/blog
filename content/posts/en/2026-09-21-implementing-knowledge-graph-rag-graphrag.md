---
title: "Implementing Knowledge Graph-Based RAG with GraphRAG"
date: "2026-09-21 02:28"
category: "AI"
tags: ["GraphRAG", "knowledge graph", "RAG", "LLM applications", "retrieval-augmented generation"]
excerpt: "A detailed look at how GraphRAG builds a knowledge graph from documents, why it outperforms vector RAG on global summarization queries, and what it costs in practice."
koSlug: "2026-09-21-GraphRAG로-지식-그래프-기반-RAG-구현하기"
---

## Table of Contents

1. Overview
2. GraphRAG Core Structure and How It Works
3. Knowledge Graph Construction and Entity Extraction
4. GraphRAG Search Pipeline Implementation
5. Performance Comparison with Vector RAG and Trade-offs
6. Considerations for Production Deployment
7. Closing Thoughts

---

## Overview

### Background: Limits of Existing RAG

**RAG (Retrieval-Augmented Generation)** lets LLMs incorporate recent information or internal enterprise documents that were not part of their training data, and it is currently one of the most common patterns in AI applications. However, when you apply standard vector RAG to an enterprise environment with millions of documents, you will repeatedly see degraded answer quality for certain types of questions. Representative examples are questions that require synthesizing relationships and patterns across many documents, such as "What are the core technical capabilities of this company?" or "Which departments collaborated the most on this project?" Vector similarity alone cannot capture that kind of global context.

**GraphRAG** is an approach Microsoft Research published in 2024 to address this problem. It automatically builds a knowledge graph from a document corpus and uses that graph as the foundation for retrieval. The key idea is not simply adding a graph on top of a vector index, but explicitly extracting entities and relationships and organizing them into a hierarchical community structure. This post covers GraphRAG's internal mechanics, how to implement it yourself, and what to watch out for in production.

### Limits of the Existing Approach

A standard RAG pipeline splits documents into chunks, converts each chunk into an embedding vector, retrieves the chunks with the highest cosine similarity to the query, and injects them into the LLM context. This structure works well for **local questions** — finding a specific concept or fact — but falls short in the following situations.

**First, it struggles to infer implicit relationships.** When the relationship between two entities is spread across multiple documents — for example, "How did technology A affect system B?" — a single chunk retrieval cannot capture the full picture. Even if two concepts are close in vector space, the direction and strength of their relationship is not encoded there.

**Second, it handles global summarization queries poorly.** Questions that span the entire corpus — such as "What are the most frequently recurring themes across all documents?" — are fundamentally hard to answer with a top-k chunk retrieval approach. GraphRAG addresses this with the concept of community summaries.

---

## GraphRAG Core Structure and How It Works

### The Knowledge Graph and Community Hierarchy

The foundation of GraphRAG is the **knowledge graph**. A knowledge graph is a data structure that represents real-world entities and their relationships as nodes and edges; it has been used in ontology-based systems for a long time. What sets GraphRAG apart from prior knowledge graph approaches is that it does not pre-define a static schema. Instead, **an LLM dynamically extracts entities and relationships from documents**. This makes it possible to automatically build a structured knowledge graph from large amounts of unstructured text without a domain expert.

Once the knowledge graph is built, GraphRAG applies community detection based on the **Leiden algorithm** to cluster the graph hierarchically. Communities form at multiple levels, from the finest granularity (Level 0) up to a level that covers the entire corpus (Level N). Each community gets an LLM-generated summary report, which is used during global search.

```diagram
en/2026-09-21-184d501b-01
```

The core structure of GraphRAG is that communities detected by the Leiden algorithm form a hierarchy, and each level's communities carry LLM summaries that handle global queries.

---

### Local Search and Global Search

GraphRAG provides two search modes. **Local Search** is used for questions focused on a specific entity or concept. It finds relevant entities from the query, then assembles context from the relationships directly connected to those entities, the community summaries they belong to, and the original text chunks. Because it combines vector search with graph traversal, it can supply the LLM with far richer context than simple vector RAG.

**Global Search** uses community summary reports to answer abstract questions about the entire corpus. It follows a **map-reduce pattern**: it generates an intermediate answer for every community summary (map), then aggregates them into a final answer (reduce). This is what makes global insights possible that a single top-k retrieval cannot provide.

```diagram
en/2026-09-21-184d501b-02
```

The key point is that the pipeline branches between local and global search based on the query type, and both paths build rich context through the knowledge graph.

---

### Entity and Relationship Schema

The data extracted in GraphRAG consists of three core elements. **Entities** have a name, type (organization, person, location, technology, etc.), and description. **Relationships** are connections between two entities, carrying source, target, description, and weight. **Text Units** are the original paragraphs from which entities and relationships were extracted; they are bidirectionally linked to entities, making provenance tracing possible.

Because these three elements cross-reference each other, the structure lets you fully track "which entity appeared in which document in which relationship." This is directly useful for hallucination verification and citation.

| Element | Attributes | Role |
|---|---|---|
| Entity | name, type, description | Knowledge graph node, vector index target |
| Relationship | source, target, description, weight | Knowledge graph edge, relationship strength |
| Text Unit | id, text, entity_ids | Original chunk, provenance tracking |
| Community Report | level, title, summary, findings | Community summary, global search target |

---

## Knowledge Graph Construction and Entity Extraction

### LLM-Based Information Extraction

The first step in building a knowledge graph is extracting entities and relationships from the source text. GraphRAG uses an LLM for this, which is the biggest difference from traditional NER (Named Entity Recognition). It is not limited to pre-defined entity types; the LLM understands context and extracts domain-appropriate entities flexibly. For example, in legal documents it automatically recognizes "case law," "statutory provision," and "party," while in technical documents it picks up "API," "library," and "architecture pattern."

The extraction process improves quality through a technique called **gleaning**. After the first extraction pass, the LLM is asked again: "Are there any entities that were missed?" This iterative validation step meaningfully increases entity completeness compared to a simple one-shot extraction — that is what Microsoft's internal experiments found. However, because at least two LLM calls occur per chunk, token costs can accumulate significantly for large corpora.

```diagram
en/2026-09-21-184d501b-03
```

The gleaning loop extracts as many entities and relationships as possible from a single chunk, then incrementally accumulates them into the full knowledge graph.

---

### Entity Resolution and Graph Normalization

The same real-world entity frequently appears under different names in different documents. "GPT-4," "GPT4," and "OpenAI's latest model" can all refer to the same entity. If you do not handle this, duplicate nodes accumulate in the knowledge graph and degrade retrieval quality. GraphRAG handles **entity resolution** by clustering candidates based on the text embedding similarity of names and descriptions, then using an LLM to decide whether entities within the same cluster should be merged.

This process is automatic, but it can produce errors in documents with many domain-specific abbreviations or frequent homonyms. For example, "Java" in an IT context means the programming language, but in a general document it might refer to the Indonesian island. In practice, teams address this by supplying a domain-specific seed entity list (a seed ontology) in the prompt, or by adding a manual review step to the pipeline after extraction.

Relationship normalization also matters. The same relationship can be expressed in opposite directions: "A developed B" vs. "B was built by A." Whether to treat relationships as undirected or to preserve directionality depends on the domain and the expected query patterns.

> The quality of entity resolution determines the reliability of the entire knowledge graph. Errors at this stage propagate throughout downstream retrieval.

---

### Community Summary Generation

Once the knowledge graph is built, GraphRAG detects communities using the Leiden algorithm and generates a summary report for each community using an LLM. The summary reports are not simple lists of entities; they contain, in a structured form, the key themes representing the community, the main relationships among its constituent entities, and notable findings.

The level of abstraction in the summaries varies by community level. Small Level 0 communities summarize fine-grained facts and relationships, while larger communities at Level 2 and above summarize more abstract themes and patterns. Global search selects the community level that matches the abstraction level of the query, which improves retrieval efficiency.

| Community Level | Node Count Range | Summary Characteristics | Suitable Query Type |
|---|---|---|---|
| Level 0 | 3–10 | Fine-grained facts and relationships | Connections between specific concepts |
| Level 1 | 10–50 | Intermediate topic clusters | Sub-domain understanding |
| Level 2+ | 50+ | Global themes and patterns | Whole-corpus insights |

---

## GraphRAG Search Pipeline Implementation

### Environment Setup and Indexing

Using Microsoft's `graphrag` package, you can build a GraphRAG pipeline fairly quickly. The package is organized into two phases: indexing and query. The indexing phase builds the knowledge graph and community summaries; the query phase runs local or global search.

The indexing pipeline is controlled by a configuration file (`settings.yaml`) where you specify chunk size, the LLM model to use, the embedding model, and the level of parallelism. Input data goes into the `./input` directory as text files; `.txt` and `.csv` formats are supported.

Here is an example of the initial setup and indexing run. The `graphrag init` command generates the default configuration files and directory structure.

```bash
# Install the package and initialize the project
pip install graphrag
mkdir my-graphrag && cd my-graphrag
python -m graphrag init --root .

# Place documents in the input directory, then run indexing
python -m graphrag index --root .
# Sample output:
# ⠸ GraphRAG Indexer
# ├── Loading Input (text) - 42 files loaded.
# ├── create_base_text_units         ✓ (00:00:02)
# ├── create_base_extracted_entities ✓ (00:12:35) ← Heavy LLM calls here
# ├── create_summarized_entities     ✓ (00:04:12)
# ├── create_base_entity_graph       ✓ (00:00:08)
# ├── create_community_reports       ✓ (00:08:44) ← Additional LLM calls
# └── generate_text_embeddings       ✓ (00:02:31)
```

When indexing finishes, Parquet artifacts are written to the `output` directory. The key files are `entities.parquet`, `relationships.parquet`, `communities.parquet`, and `community_reports.parquet`.

---

### Local Search Implementation

Local search is optimized for entity-centric questions. It finds relevant entities via vector search, then assembles context from those entities' relationships, their community summaries, and linked text chunks. The proportion of context each component contributes can be tuned in configuration, and this directly affects retrieval quality.

Below is an example of running local search with the Python SDK. When initializing the search engine, you decide what data to include in the context.

```python
import pandas as pd
from graphrag.query.context_builder.entity_extraction import EntityVectorStoreKey
from graphrag.query.indexer_adapters import (
    read_indexer_entities, read_indexer_relationships,
    read_indexer_reports, read_indexer_text_units,
)
from graphrag.query.llm.oai.chat_openai import ChatOpenAI
from graphrag.query.llm.oai.embedding import OpenAIEmbedding
from graphrag.query.structured_search.local_search.mixed_context import LocalSearchMixedContext
from graphrag.query.structured_search.local_search.search import LocalSearch

INPUT_DIR = "./output"
COMMUNITY_LEVEL = 2  # Community level to reference in local search

# Load artifacts
entity_df = pd.read_parquet(f"{INPUT_DIR}/entities.parquet")
rel_df = pd.read_parquet(f"{INPUT_DIR}/relationships.parquet")
report_df = pd.read_parquet(f"{INPUT_DIR}/community_reports.parquet")
text_unit_df = pd.read_parquet(f"{INPUT_DIR}/text_units.parquet")

entities = read_indexer_entities(entity_df, entity_embedding_df, COMMUNITY_LEVEL)
relationships = read_indexer_relationships(rel_df)
reports = read_indexer_reports(report_df, entity_df, COMMUNITY_LEVEL)
text_units = read_indexer_text_units(text_unit_df)

# Configure the search engine
context_builder = LocalSearchMixedContext(
    entities=entities,
    entity_text_embeddings=entity_embedding_store,  # vector store
    text_embedder=OpenAIEmbedding(model="text-embedding-3-small"),
    text_units=text_units,
    community_reports=reports,
    relationships=relationships,
    entity_top_size_percent=0.1,  # reference only the top 10% of entities
)

search_engine = LocalSearch(
    llm=ChatOpenAI(model="gpt-4o-mini"),
    context_builder=context_builder,
    token_encoder=tiktoken.get_encoding("cl100k_base"),
    context_builder_params={
        "use_community_summary": False,  # use summary instead of full community text
        "include_community_rank": True,
        "community_level": COMMUNITY_LEVEL,
        "max_tokens": 12_000,
    },
)

result = await search_engine.asearch("How is community detection used in GraphRAG?")
# result.response: "Community detection works through the Leiden algorithm..."
# result.context_data["entities"]: list of referenced entities
```

The `max_tokens` setting in `context_builder_params` has a large impact on response quality. If it is too small, relevant context gets truncated and you get incomplete answers. If it is too large, the LLM loses focus among irrelevant context. Adjust within the 8,000–16,000 token range depending on your domain and document characteristics.

---

### Global Search and the Map-Reduce Flow

Global search is structurally completely different from local search. Instead of finding specific entities, it collects all highly relevant community summaries, generates an intermediate answer for each, then consolidates them into a final answer. Because the number of LLM calls in this process grows with the number of communities, **global search has noticeably higher response latency than local search.**

```diagram
en/2026-09-21-184d501b-04
```

In the map phase of global search, LLM calls are issued in parallel — one per community — so async processing and a caching strategy are essential for any service with strict response-time SLAs.

---

## Performance Comparison with Vector RAG and Trade-offs

### Performance Characteristics by Query Type

In Microsoft Research's paper ("From Local to Global: A Graph RAG Approach to Query-Focused Summarization," 2024), GraphRAG showed meaningful quality improvements over naive RAG on global sensemaking questions. In particular, **comprehensiveness** and **diversity** metrics improved substantially for broad questions like "What are the most important themes in this document set?"

However, GraphRAG does not outperform for every type of question. For simple fact lookup or local questions that search for a specific sentence, vector RAG is faster and more cost-efficient. Understanding the differences between the two and choosing appropriately is what matters.

| Comparison Dimension | Standard Vector RAG | GraphRAG (Local) | GraphRAG (Global) |
|---|---|---|---|
| Indexing cost | Low (embedding only) | High (LLM extraction) | High (LLM + summaries) |
| Query latency | Low (~1 s) | Medium (~3–5 s) | High (~10–30 s) |
| Global summarization quality | Low | Medium | High |
| Specific fact retrieval quality | High | High | Low |
| Relationship reasoning quality | Low | High | Medium |
| Operational cost | Low | Medium | High |

---

### Indexing Cost and Token Consumption

The biggest practical constraint with GraphRAG is **indexing cost**. Indexing one million tokens of documents can cost tens of times more in OpenAI API fees than standard vector RAG, because entity extraction, gleaning, and community summary generation all require LLM calls.

According to Microsoft's official documentation, indexing roughly 300 pages of text (about one million tokens) with GPT-4o-mini costs approximately $1–2. Doing the same with GPT-4o costs more than ten times as much. A **tiered model strategy** is therefore effective for cost optimization: use a small model for repetitive tasks like entity extraction, and apply a large model only for quality-critical steps like community summary generation.

```diagram
en/2026-09-21-184d501b-05
```

Splitting models across indexing stages can reduce cost by 30–60% while maintaining quality.

---

### Alternative Approaches and Selection Criteria

Beyond GraphRAG, there are several other graph-based RAG variants. **KG-RAG** queries pre-built knowledge graphs (Wikidata, DBpedia, etc.) via SPARQL, which is advantageous when the domain is well-defined and the knowledge is structured. **HippoRAG** takes inspiration from human memory structures to strengthen contextual connections, and it excels at QA that requires complex reasoning chains. **LightRAG** is an open-source alternative similar to GraphRAG but focused on reducing indexing cost.

The choice ultimately comes down to **the intersection of your query patterns and operational constraints**. If global summarization and relationship reasoning are central, go with GraphRAG. If fast fact retrieval is the primary use case, standard vector RAG is the right call. If cost is the priority, consider LightRAG or a hybrid strategy.

---

## Considerations for Production Deployment

### Common Mistakes and Pitfalls

The problem teams most frequently encounter when first adopting GraphRAG is **misconfiguring chunk size**. The default chunk size (1,200 tokens) is tuned for general-purpose documents and is not optimal for short news articles or long legal documents. If chunks are too small, relationships that span a single sentence get cut at chunk boundaries and extraction fails. If they are too large, one chunk contains too many entities and extraction quality drops. Depending on the domain, you need to experiment to find the sweet spot — roughly 300–600 tokens for short documents and 1,500–2,000 tokens for long reports.

**The second pitfall is encoding mismatch.** GraphRAG uses `tiktoken`'s `cl100k_base` encoding internally to count tokens. Languages with many multi-byte characters, such as Korean and Japanese, consume 2–4 times more tokens per character than English, so the same chunk-size setting can result in very short text segments in practice. When processing Korean documents, it is recommended to set the chunk size to 1.5–2 times larger than you would for English.

```diagram
en/2026-09-21-184d501b-06
```

For Korean documents, the chunk size should be set 1.5–2 times larger than the default to achieve extraction quality comparable to English documents.

---

### Monitoring and Debugging

Because a GraphRAG pipeline passes through multiple stages, it is hard to trace which stage caused a quality problem. Systematically monitoring the output of each stage is essential in production.

For **entity extraction quality metrics**, track the average number of entities and relationships per chunk. If a chunk produces 1–2 entities or fewer, there may be a problem with the extraction prompt or the LLM choice. Conversely, if a chunk produces 30 or more, meaningless entities (articles, numbers, etc.) are probably being over-extracted. The right range varies by domain, but 5–15 entities per chunk is generally appropriate.

**Community summary quality** is better assessed through sample-based human review than automated metrics. Randomly sample 5–10% of all communities and verify that the summaries accurately reflect the community's core topics. If summaries are overly generic ("this community covers a variety of topics") or skewed toward specific entities, adjust the community size parameters or the summary generation prompt.

| Monitoring Metric | Normal Range | Anomaly Signal | Action |
|---|---|---|---|
| Average entities per chunk | 5–15 | <3 or >25 | Adjust prompt or chunk size |
| Entity resolution rate | 10–30% | >50% | Provide domain-specific entity list |
| Average nodes per community | 5–50 by level | Too many single-node communities | Adjust resolution parameter |
| Local search response time | 2–5 s | >10 s | Reduce context token count |
| Global search cost per query | $0.01–0.05 | >$0.20 | Tighten community level filtering |

---

### Incremental Updates and Scaling

Because GraphRAG indexing is expensive, re-indexing everything whenever documents are added or changed is not realistic. There are two main ways to handle this.

**First, a batch update strategy.** Periodically collect new documents, build them into a separate index, and merge that index with the existing one at query time. This is simple to implement, but new documents' entities will not be linked to entities in the existing index — a **disconnection problem**.

**Second, a streaming update strategy.** Extract entities and relationships from new documents, then incrementally add them to the existing graph. Restrict community re-detection to the neighborhood of the changed subgraph rather than the full graph. This approach is more accurate, but it requires integration with a graph database such as Neo4j or Neptune.

```diagram
en/2026-09-21-184d501b-07
```

Choosing an incremental update strategy is a trade-off between data change frequency and implementation complexity. A batch strategy is practical for monthly updates; a streaming strategy makes sense for daily updates.

---

## Closing Thoughts

### Key Takeaways

GraphRAG delivers meaningful quality improvements on **global summarization queries** and **multi-entity relationship reasoning** — exactly the areas where vector RAG has struggled. Three mechanisms are central. LLM-based automatic entity and relationship extraction lets you build a knowledge graph without a domain schema. Hierarchical community construction via the Leiden algorithm handles queries at varying levels of abstraction. And the dual pipeline of local and global search routes each query to the optimal path.

All of these advantages, however, come with substantial indexing cost and implementation complexity. Indexing can cost 10–50 times more than standard vector RAG, and for languages with lower token efficiency such as Korean, additional parameter tuning — chunk size in particular — is required.

### Decision Criteria for Adoption

GraphRAG is a good fit in the following situations. **When you need insights that span the entire corpus** — for example, identifying recurring patterns across thousands of pieces of customer feedback, or tracing the lineage of decisions across a large internal document set. **When relationships between entities are the core of the answer** — it is effective when you need explicit relationship reasoning, like "What is the connection between this technology and that one?"

On the other hand, you should reconsider adopting it in these situations. If the document set is small (under 10,000 documents) or changes frequently, the cost-to-benefit ratio of indexing is poor. If your response SLA is under two seconds, global search latency will be a problem. If the primary use case is simple FAQ lookup or specific fact retrieval, standard vector RAG is the smarter choice.

GraphRAG is not "a single solution that solves every RAG problem." In real-world projects, a **hybrid architecture** that dynamically selects between vector RAG and GraphRAG based on query type is proving to be the most balanced approach.
