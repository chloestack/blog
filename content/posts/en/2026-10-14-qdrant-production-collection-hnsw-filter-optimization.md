---
title: "Qdrant Production Deployment — Collection Design, HNSW Tuning, and Filter Optimization"
date: "2026-10-14 02:18"
updated: "2026-10-19 17:10"
category: "AI"
tags: ["Qdrant", "vector search", "HNSW", "scalar quantization", "filter index"]
excerpt: "Without payload indexes, Qdrant brute-force scans every filter query. This post covers collection design, HNSW ef tuning, and filter index selection with memory math for 1 million vectors."
koSlug: "2026-10-14-Qdrant-프로덕션-배포-—-컬렉션-설계·HNSW-튜닝·필터-최적화"
---

## Table of Contents

1. Overview
2. Collection Design Principles
3. Understanding and Tuning HNSW Parameters
4. Filter Index Optimization
5. Memory Calculation and Capacity Planning
6. Considerations for Production
7. Closing Thoughts

---

## Overview

### The Problem

Without payload indexes declared, Qdrant brute-force scans the entire collection on every filtered query. This post covers collection design, HNSW ef tuning, and filter index selection, with concrete memory numbers for 1 million vectors. Qdrant is a high-performance vector search engine written in Rust that works well enough with default settings in a local development environment. But the story changes the moment you start handling millions of vectors, complex metadata filters, and dozens of concurrent requests in a real service. Response latency can suddenly jump to hundreds of milliseconds, or memory usage can balloon to more than twice what you expected.

This post covers three core areas for running Qdrant reliably in production: collection design, HNSW index tuning, and filter index optimization. We look at memory calculations for 1 million vectors, performance trade-offs for each parameter, and the traps you commonly hit in production.

### Limits of the Default Approach

Many teams copy the official Qdrant quickstart example directly into production. Because that example is intentionally simplified, parameters that must be adjusted for production are left at their defaults. For example, the default `ef_construct` of 100 is a middle-ground choice between index quality and build speed — it is not a value optimized for any particular query load pattern. Filtering by category or date range without payload indexes causes Qdrant to do a brute-force scan across all vectors, which makes latency grow linearly as data grows.

The more fundamental problem is how vectors are stored. The default configuration operates in `Vectors` mode, which loads all vectors into memory. With OpenAI `text-embedding-3-large` at 3072 dimensions and float32, each vector is about 12 KB. 1 million vectors need about 12 GB just for vector data; 10 million need 120 GB. Without a quantization or on-disk storage strategy, costs quickly reach an unsustainable level.

```diagram
en/2026-10-14-71367d11-01
```

On the path to production, the defaults create several traps. If you miss even one of the three areas — index redesign, filter strategy, memory optimization — a bottleneck remains.

---

## Collection Design Principles

### Vector Configuration and Distance Metric Selection

A collection is the top-level data unit in Qdrant. The vector dimensions, distance metric, and storage mode you choose when creating a collection are difficult or expensive to change later. The first thing to consider is the distance metric recommended by your embedding model.

OpenAI embeddings are already normalized, so cosine similarity and Dot Product behave identically. In that case, `Dot` has lower compute cost than `Cosine`, because Cosine performs one extra normalization step internally. On the other hand, for models like some `sentence-transformers` variants where normalization is not guaranteed, `Cosine` gives more accurate results. `Euclid` is for cases where absolute distance is meaningful, such as image search — it is not appropriate for general text similarity search.

Vector dimensions also involve trade-offs. `text-embedding-3-large` supports up to 3072 dimensions, but OpenAI uses Matryoshka Representation Learning and states that reducing dimensions to 256 or 512 causes little quality loss. Halving the dimensions halves memory usage. In practice, starting at 256 dimensions, measuring search quality (recall@10), and incrementally increasing dimensions is an efficient approach.

| Distance metric | Normalization required | Compute cost | Recommended use |
|---|---|---|---|
| `Dot` | Yes | Low | OpenAI, Cohere embeddings |
| `Cosine` | No | Medium | Models without guaranteed normalization |
| `Euclid` | No | Medium | Image search, absolute distance |
| `Manhattan` | No | Medium | Sparse vectors, anomaly detection |

### Payload Schema and Explicit Index Declarations

In Qdrant, the payload is the metadata attached to each vector point. It is similar to columns on a row in a relational database, but it does not enforce a schema — any JSON can be stored. The problem is that this flexibility becomes a performance trap. Filtering on a payload field with no index causes Qdrant to iterate over the entire collection and evaluate the condition for every point.

Declaring explicit payload indexes is best done immediately after creating the collection. You can add them later, but index construction can reduce write throughput on that collection while it runs. Field types must be declared accurately for indexes to work optimally. If you store a number as a string and declare the index as `integer`, queries will return empty results.

```diagram
en/2026-10-14-71367d11-02
```

The payload index type determines query performance. `keyword` is for exact value matching such as categories or tags; `integer` and `float` are for range filters; `datetime` is optimized for time-range conditions.

### Storage Strategy: In-Memory, MMAP, On-Disk

Qdrant offers three vector storage modes. `in_memory` loads all data into RAM. `mmap` uses the OS memory-mapped file mechanism, keeping frequently accessed data in the page cache and reading the rest from disk. `on_disk` stores the HNSW graph itself on disk, minimizing memory usage.

In production, it is common to configure vectors and payload separately. Vectors are large, so setting them to `mmap` while keeping payload `in_memory` is efficient — payload is relatively small and is accessed frequently during filter evaluation. The HNSW graph plays a central role in index traversal, so keeping it in memory is better for response latency whenever possible.

> Vectors on mmap, payload in memory, HNSW graph in memory. This combination gives the best balance of cost versus latency.

---

## Understanding and Tuning HNSW Parameters

### HNSW Algorithm Structure

HNSW (Hierarchical Navigable Small World) is the approximate nearest neighbor (ANN) index algorithm Qdrant uses by default. It operates as a hierarchical graph: the top layer has few nodes with sparse connections, and lower layers have more nodes with denser connections. During search, it starts at the top layer to quickly narrow down the candidate region, then searches precisely in the lower layers.

Three parameters control performance in this structure. `m` is the maximum number of bidirectional connections each node maintains. `ef_construct` is the size of the candidate set explored during index construction. `ef` (or `hnsw_ef`) is the size of the candidate set explored during search.

```diagram
en/2026-10-14-71367d11-03
```

HNSW finds the entry point quickly in the top layer, then explores a candidate set of size `ef` at layer 0 to produce the final result.

### Setting m and ef_construct

The `m` value controls the connection density of the graph. The default is 16. Increasing it raises search accuracy (recall) but increases memory usage and index build time. In practice, `m=16` provides sufficient recall for general-purpose text search, while `m=32` or `m=64` is worth considering for recommendation systems or similar-image search that require high precision. Conversely, `m=8` is used in environments with extreme memory constraints where some recall loss is acceptable.

`ef_construct` only affects index construction, not runtime search performance, since the index is built once. However, a low value degrades index quality and therefore lowers recall at search time. The default of 100 is adequate in most cases, but for data that is densely clustered or for high-dimensional vectors above 1000 dimensions, raising it to 200 or more is a good way to secure index quality. Because index construction is a one-time batch operation, prioritizing quality over time is generally the right call.

| Parameter | Default | Higher | Lower | Recommended adjustment |
|---|---|---|---|---|
| `m` | 16 | recall↑, memory↑ | recall↓, memory↓ | 16 for general use, 32 for high precision |
| `ef_construct` | 100 | index quality↑, build time↑ | index quality↓, build time↓ | 200+ for high dimensions |
| `ef` (search) | 128 | recall↑, latency↑ | recall↓, latency↓ | Tune to target recall |
| `max_indexing_threads` | 0 (all) | build speed↑ | build speed↓ | Limit to 1-2 in production |

### Balancing ef (Search) Against Recall Targets

The `ef` value used during search can be changed dynamically per query. This is fundamentally different from `m` or `ef_construct`. Even if you set a default `ef` at collection creation time, a higher value requested in an individual query applies only to that request. You can use this to implement a two-stage search strategy: use a low `ef` for fast general searches, and use a high `ef` only during the candidate-collection stage of a reranking pass where precision matters.

Actual numbers for recall versus latency vary greatly depending on data distribution. The same `ef=128` can yield high recall on uniformly distributed random vectors but fall well short of a target on data with a clustered structure concentrated in a specific domain. Because real numbers depend heavily on data distribution, it is essential to extract a sample from your actual service data, measure recall directly, and find the minimum `ef` that meets your target (typically 0.95 or higher).

---

## Filter Index Optimization

### Two Paths for Filtered Search

Filtered vector search in Qdrant internally chooses between two paths. The first is the **HNSW-first** path: traverse the HNSW graph to collect nearest-neighbor candidates, then apply payload conditions. The second is the **filter-first** path: use the payload index to build the set of points matching the condition, then compute vector similarity within that set.

Qdrant decides which path to take automatically via internal cardinality estimation. If only a small fraction of points pass the filter, it takes the filter-first path; if most points pass, it takes HNSW-first. The exact threshold depends on Qdrant's internal configuration and version, so it is better to focus on always having payload indexes rather than memorizing specific numbers. Payload indexes must exist for this decision to be made correctly. Without them, cardinality estimation is impossible and Qdrant always takes the HNSW-first path, which causes recall to drop sharply when few candidates survive the filter.

```diagram
en/2026-10-14-71367d11-04
```

Without payload indexes, Qdrant cannot estimate cardinality, always takes the HNSW-first path, and recall drops on selective filters.

### Choosing Payload Index Types

Qdrant requires payload indexes to be declared with the matching field type. The `keyword` type uses an inverted index structure, making it efficient for exact value matching and multi-value (array) fields alike. It is appropriate for fields with a limited set of values such as categories, tags, and status codes.

`integer` and `float` use a B-tree-based index. Range queries using `gt`, `gte`, `lt`, and `lte` are handled in O(log n). Storing timestamps as Unix epoch integers and declaring an `integer` index makes time-range filters efficient. The `datetime` type lets you compare ISO 8601 strings directly for convenience, but timezone handling requires care.

The `text` type supports BM25-based full-text search. It is limited to checking for keyword presence and is useful when combining vector search with full-text search for a hybrid search setup. However, `text` indexes take longer to build and use more memory than other types, so apply them only to fields where full-text search is actually needed.

> Attaching indexes to every field is counterproductive. Write throughput drops and memory usage increases. Declare indexes only for fields you actually use in filter conditions.

### Compound Filters and Index Strategy

Real queries almost always combine multiple conditions. In a compound filter nesting `must`, `should`, and `must_not`, the order in which conditions are evaluated affects performance. Qdrant applies an optimization that evaluates the most selective condition (lowest cardinality) first to narrow the candidate set. For this optimization to work correctly, each condition's field must have an index.

For example, if you use a compound filter on `tenant_id` (hundreds of distinct values) and `status` (3 values: active, inactive, deleted), Qdrant narrows candidates by `tenant_id` first, then evaluates `status`. Both fields need a `keyword` index for this optimization to kick in.

In multi-tenant services, `tenant_id` often appears as a required condition on every query. In that case, it is also worth considering Qdrant's **named vectors** combined with **sparse vectors**, or splitting collections per tenant. Splitting collections improves data isolation and manageability, but when the number of collections exceeds several thousand the memory overhead in Qdrant grows significantly, so choose a strategy based on tenant scale.

---

## Memory Calculation and Capacity Planning

### Vector Memory Usage Formula

Before provisioning a Qdrant cluster, accurately calculating the memory you need is critical. Estimate vector memory with the following formulas.

**Raw vectors:** `point count × dimensions × 4 bytes (float32)`  
**HNSW graph:** `point count × m × 8 bytes × 2 (bidirectional connections)`  
**Payload:** Varies by number of fields and value sizes  

For 1 million vectors with OpenAI `text-embedding-3-small` (1536 dimensions) indexed at `m=16`:
- Raw vectors: 1,000,000 × 1,536 × 4 = **6 GB**
- HNSW graph: 1,000,000 × 16 × 8 × 2 = **256 MB**
- Total: approximately **6.3 GB** (payload separate)

Raising to `m=32` under the same conditions increases the HNSW graph to 512 MB, but its share of total memory remains small. The majority of memory pressure comes from the raw vectors.

```diagram
en/2026-10-14-71367d11-05
```

At 1 million points, raw vectors dominate memory, and applying scalar quantization can reduce memory by 75%.

### Quantization Strategies and Recall Trade-offs

Qdrant supports three quantization methods. **Scalar Quantization** compresses float32 (4 bytes) to int8 (1 byte), reducing memory by about 75%. **Product Quantization** splits vectors into sub-vectors and compresses each with a codebook, achieving a higher compression ratio but with greater recall loss. **Binary Quantization** compresses each dimension to 1 bit, reducing memory by 96%, but you must set `rescore: true` to use the original vectors for secondary scoring in order to maintain recall.

In practice, scalar quantization is the most balanced choice. For large-dimension vectors like OpenAI embeddings, the recall loss from scalar quantization tends to be small and is often acceptable in most services. That said, the magnitude of loss varies with data distribution, so measure recall@10 on your service data and decide. Using the `oversampling` + `rescore` pattern — collect candidates quickly with quantized vectors, then re-score the top k with original vectors — can recover recall to near the original level.

```python
# Example collection creation combining scalar quantization and rescore
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams, Distance,
    ScalarQuantizationConfig, ScalarType,
    ScalarQuantization
)

client = QdrantClient(host="localhost", port=6333)

client.create_collection(
    collection_name="documents",
    vectors_config=VectorParams(
        size=1536,           # OpenAI text-embedding-3-small
        distance=Distance.DOT,
        on_disk=True,        # Store vectors via mmap
    ),
    quantization_config=ScalarQuantization(
        scalar=ScalarQuantizationConfig(
            type=ScalarType.INT8,
            quantile=0.99,   # Clip top 1% outliers
            always_ram=True, # Keep quantized vectors in memory
        )
    ),
    hnsw_config={
        "m": 16,
        "ef_construct": 200,  # Set to 200 for high dimensions
        "on_disk": False,     # Keep HNSW graph in memory
    },
)
# With this configuration, raw vectors are on mmap, quantized vectors are in memory,
# and the HNSW graph stays in memory.
# Latency reduction will vary significantly depending on the config combination,
# hardware, and data distribution.
```

In the quantization config, `quantile=0.99` clips the top and bottom 0.5% of the value distribution to prevent scale distortion from outliers. `always_ram=True` keeps the compressed quantized vectors always in memory to maintain index traversal speed.

### Payload Index Declaration and Search Query Examples

The pattern for declaring payload indexes immediately after collection creation and then running filtered searches.

```python
from qdrant_client.models import (
    PayloadSchemaType,
    Filter, FieldCondition, MatchValue, Range
)

# Declare payload indexes (right after collection creation)
client.create_payload_index(
    collection_name="documents",
    field_name="tenant_id",
    field_schema=PayloadSchemaType.KEYWORD,
)
client.create_payload_index(
    collection_name="documents",
    field_name="category",
    field_schema=PayloadSchemaType.KEYWORD,
)
client.create_payload_index(
    collection_name="documents",
    field_name="created_at",
    field_schema=PayloadSchemaType.INTEGER,  # Unix epoch integer
)

# Filter + vector search (oversampling + rescore pattern)
results = client.search(
    collection_name="documents",
    query_vector=query_embedding,  # list[float], 1536 dimensions
    query_filter=Filter(
        must=[
            FieldCondition(key="tenant_id", match=MatchValue(value="acme-corp")),
            FieldCondition(key="category",  match=MatchValue(value="finance")),
            FieldCondition(
                key="created_at",
                range=Range(gte=1700000000, lt=1730000000),
            ),
        ]
    ),
    limit=10,
    search_params={
        "hnsw_ef": 128,
        "quantization": {
            "ignore": False,
            "rescore": True,    # Re-score top candidates with original vectors
            "oversampling": 2.0 # Collect 20 candidates for a limit of 10, then rerank
        }
    }
)
# results: list of ScoredPoint, accessible via .id / .score / .payload
# Enabling rescore + oversampling recovers most of the recall lost to quantization
# (measure actual values with your service data)
```

`oversampling=2.0` collects twice the final `limit` as candidates, re-scores them with the original vectors, and returns the top 10. Latency increases slightly, but most of the recall loss from quantization is recovered.

---

## Considerations for Production

### Common Mistakes and Traps

**Not setting `max_indexing_threads` during index construction** is the most common trap. By default, Qdrant uses all available CPU cores for index construction. During initial data load this helps build the index quickly, but if a large upsert happens in production, index reconstruction causes CPU utilization to spike, multiplying query response time several times over. In production, limiting this to `max_indexing_threads: 2` leaves the remaining cores available for query processing.

**Misunderstanding collection optimization timing** is another thing to watch. Qdrant automatically merges segments and rebuilds indexes when data reaches certain thresholds. During this optimization, disk usage temporarily doubles. If you provision disk exactly to fit the vector storage size, the disk will fill up during optimization and Qdrant will return errors. Because disk usage can temporarily double during optimization, provision disk at twice the expected data size plus a buffer.

**Setting a low `ef` value with no filter conditions** is a problem for queries that need high recall. Conversely, setting a high `ef` on all queries introduces unnecessary latency on simple similarity searches. Setting `hnsw_ef` differently by query type is practical: use `ef=64` for general RAG pipeline searches, and `ef=256` for semantically precise searches where accuracy matters.

```diagram
en/2026-10-14-71367d11-06
```

The three key production traps are each solved by independent configuration adjustments.

### Monitoring and Debugging Metrics

Qdrant exposes Prometheus-format metrics via the `/metrics` endpoint. Key metrics to watch in production:

`qdrant_collection_segments_count` is the number of segments in a collection. An excessively high number (dozens or more) indicates optimization is not keeping up, and latency increases as multiple segments are searched in parallel. If the ratio of `qdrant_collection_indexed_vectors_count` to `qdrant_collection_points_count` is significantly below 1, indexing is falling behind. Points that have not finished indexing are searched by brute force, directly affecting latency.

Monitor response latency distribution using p95 and p99, not p50. Outlier queries often skew the average in vector search workloads. Queries with complex filter conditions or high `ef` values are often the culprits driving up p99 latency, so log query parameters alongside latency and analyze the correlation.
The ranges below are example starting values. Normal ranges vary with hardware, vector dimensions, and filter conditions, so revisit them using the first few weeks of measurements and your service SLA.

| Monitoring metric | Normal range (example) | Warning sign (example) | Action |
|---|---|---|---|
| Segment count | 5-15 | 30+ | Trigger optimization, adjust threshold |
| Indexing ratio | 95%+ | Below 80% | Check indexing_threads, reduce write load |
| Search p99 latency | < 50ms | > 200ms | Adjust ef, check filter indexes |
| Memory utilization | < 75% | > 90% | Apply quantization, switch to on-disk |

### Scaling and Migration Strategy

To scale a Qdrant cluster horizontally, use **distributed mode**. Setting `shard_number` when creating a collection distributes data automatically across nodes. Shard count is hard to change later, so the initial design matters. In practice, 1-2 shards per node is a balanced setting, and some teams set shards to roughly twice the current node count to account for future growth.

When migrating an existing single-node Qdrant deployment to a cluster, use snapshots. Use Qdrant's snapshot API to save the current state of a collection to a file, then restore it to the new cluster for a zero-downtime migration. Note that a collection is read-only during snapshot restoration, so apply blue-green deployment to temporarily route traffic to another instance.

When replacing an embedding model, the safe strategy is to keep the existing collection and run a new collection in parallel. Re-generate vectors with the new model and incrementally populate the new collection, then use an A/B test to compare search results from both collections before deciding when to cut over. If the new model has different dimensions, do not reuse the existing collection's `hnsw_config` and `quantization_config` as-is — redesign them for the new dimensions.

```diagram
en/2026-10-14-71367d11-07
```

Replacing the embedding model means running a new collection in parallel, validating with an A/B test, then cutting over.

---

## Closing Thoughts

### Key Takeaways

The three axes that determine performance in a Qdrant production deployment are collection design, HNSW tuning, and filter indexes. At the collection design stage, choose the distance metric that matches your embedding model, and storing vectors on `mmap` while keeping payload in memory is cost-efficient. Among HNSW parameters, `ef` has a more direct impact on search response than `m`; using dynamic `ef` settings per query type lets you flexibly trade recall against latency. Filter indexes must be declared for every field used in a filter condition — omitting them breaks cardinality estimation and falls back to the brute-force path. Once you have more than 1 million vectors, scalar quantization combined with the `rescore + oversampling` pattern can cut vector memory by about 75% while keeping recall loss small. Measure the actual loss on your service data to confirm.

### When to Apply These Settings

Running Qdrant with default settings is fine if the vector count is below a few hundred thousand, you only use simple similarity search without filters, and instance memory is comfortably larger than the data size. If any one of those conditions no longer holds, apply the settings covered in this post incrementally. The lowest-friction order is: first secure filter performance by declaring payload indexes, then introduce scalar quantization when memory headroom starts shrinking, and then adjust the `max_indexing_threads` and `ef` strategy as throughput grows. After each change, measure recall@10 and p99 latency against your baseline, and move to the next step only after confirming improvement.
