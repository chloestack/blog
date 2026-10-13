---
title: "Qdrant Production Deployment — Collection Design, HNSW Tuning, and Filter Optimization"
date: "2026-10-14 02:18"
category: "AI"
tags: ["Qdrant", "vector database", "HNSW", "RAG", "vector search"]
excerpt: "A practical guide to designing Qdrant collections, tuning HNSW parameters, and optimizing filters for production workloads."
koSlug: "2026-10-14-Qdrant-프로덕션-배포-—-컬렉션-설계·HNSW-튜닝·필터-최적화"
---

Since inconsistency is acceptable, online snapshots are sufficient.

```diagram
en/2026-10-14-71367d11-01
```

Don't keep snapshots on local disk only — move them to object storage immediately so you can recover even when a node fails.

---

### Monitoring Metrics

Qdrant exposes Prometheus-format metrics at the `/metrics` endpoint. There are three broad categories of metrics you must track in production. For **search performance**, watch `qdrant_requests_total` (request count), `qdrant_rest_response_duration_seconds` (latency distribution), and `qdrant_grpc_response_duration_seconds` (gRPC latency). When p99 latency starts exceeding your SLA, consider lowering `hnsw_ef`, introducing quantization, or adding shards to spread the load.

For **index health**, track the number of segments per collection. An unusually high segment count is a signal that optimization isn't running often enough. Qdrant runs a background optimization process that merges segments and rebuilds indexes, but under high write throughput, optimization can fall behind. In that case, increase `default_segment_number` in `optimizer_config` or adjust the optimization parallelism.

On the **resource usage** side, RAM is the most critical concern. With the default configuration that keeps both vectors and the HNSW graph in memory, running out of RAM triggers mmap swapping and causes latency to spike. Aim to keep usage below 80% of available RAM, and factor OS page cache into your memory plan for production.

| Metric | Healthy range | Warning signal | Action |
|---|---|---|---|
| p99 latency | < 100ms | > 200ms | Lower hnsw_ef, introduce quantization |
| Segment count | < 10 | > 30 | Adjust optimizer config |
| RAM usage | < 80% | > 90% | Quantization, switch to on_disk |
| indexed_vectors ratio | > 95% | < 80% | Throttle write speed |

---

### Scaling Strategy

Horizontal scaling in Qdrant works along two axes: adding shards and adding nodes. When vector data grows to the point where a single node runs out of RAM, add a new node to the cluster and either move some existing shards to it or add new shards. Shard moves happen online with no service interruption. Keep in mind that I/O load spikes on the shard being moved, so schedule moves during low-traffic windows or use the setting that limits move speed.

If query throughput is the bottleneck, adding **read-only replicas** is effective. All Qdrant replicas support reads and writes, but you can distribute read traffic by designating certain replicas as read-only in the client-side load balancer.

```diagram
en/2026-10-14-71367d11-02
```

Routing writes to the leader and reads to replicas lets you scale search throughput linearly.

---

## Things to Watch Out for in Production

### Common Mistakes and Pitfalls

The most frequent problem when first deploying Qdrant to production is underestimating the **cost of recreating a collection**. Creating a collection with the wrong dimensions or distance metric means re-indexing all your data. That process requires three steps — regenerating embeddings (which incurs external API costs), reloading the data, and rebuilding the HNSW index — so it can take several hours or more at vector counts in the millions or above. For any new system, strongly prefer validating your configuration against a 1% sample of the full dataset before loading everything.

The second pitfall is **batch upsert size**. Sending too many vectors in a single request causes memory spikes and timeouts. A batch size of 100–500 is generally stable; for parallel requests, 2–4 concurrent requests is appropriate depending on your CPU core count and available memory. Using gRPC reduces serialization overhead compared to REST, which is an advantage for bulk loads.

The third is **vector ID management**. Qdrant replaces an existing vector when you upsert with the same ID. This makes document updates easy to implement, but a bug in your ID generation logic can silently overwrite data. Generating deterministic IDs using UUID v5 (namespace + original document ID) is the safe choice for production.

```python
import uuid
from qdrant_client.models import PointStruct

NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # URL namespace

def stable_id(doc_id: str) -> str:
    """Convert an original document ID to a deterministic UUID v5 — guarantees the same ID on re-load"""
    return str(uuid.uuid5(NAMESPACE, doc_id))

def upsert_batch(docs: list[dict], vectors: list[list[float]]):
    points = [
        PointStruct(
            id=stable_id(doc["id"]),
            vector=vec,
            payload={
                "tenant_id":  doc["tenant_id"],   # indexed field
                "category":   doc["category"],
                "created_at": doc["created_at"],
                "title":      doc["title"],
                "source_url": doc["url"],          # non-indexed display field
            },
        )
        for doc, vec in zip(docs, vectors)
    ]
    # wait=True: wait for the upsert to complete before returning (prevents data loss)
    client.upsert(collection_name="documents", points=points, wait=True)
    # result: batch complete, return value is UpdateResult(status='completed')
```

Omitting `wait=True` makes the call asynchronous and faster, but you have no way to confirm whether an upsert failed in the event of a failure. In production, either use `wait=True`, or if you choose async, implement separate logic that tracks the `operation_id` from the response and verifies completion.

---

### Monitoring and Debugging

When search quality is lower than expected, the first thing to check is the `hnsw_ef` value. In many cases, `hnsw_ef` is not larger than `limit`, which severely degrades recall. Setting `with_payload: false` and `with_vectors: false` in Qdrant's REST API reduces response size and improves latency. It's a common mistake to include vectors in the response even when they aren't needed.

If latency is high only under certain filter conditions, check whether an index exists for that condition and how selective it is. The `GET /collections/{name}/info` API returns segment count, indexing status, and optimization progress for a collection. If `indexed_vectors_count` is significantly lower than `vectors_count`, the index build is still in progress or the optimizer is falling behind. Running filter queries in this state causes segments without an index to be processed via sequential scan.

```diagram
en/2026-10-14-71367d11-03
```

Going through this checklist in order will let you identify the root cause of most search performance problems quickly.

---

### Scaling and Migration

When you need to change collection settings, Qdrant supports some changes online and requires recreation for others. **Adding a payload index** can be done online; the index is built over existing data in the background. **Adding quantization settings** can also be changed online; the optimizer applies quantization to existing segments sequentially in the background. However, **changing vector parameters (dimensions, distance metric) is not possible** — you must create a new collection.

For migrations, the **blue-green approach** is the safe choice. Create a collection with the new settings, load all existing data into it, then gradually shift query traffic over. During the transition, writing to both collections simultaneously is simple; if the data volume is in the tens of millions or more, minimize downtime by syncing only the delta after the initial load finishes. Since Qdrant 1.9, the **named vectors** feature has stabilized, allowing you to store vectors from multiple embedding models in a single collection, which makes gradual model migrations considerably easier.

---

## Conclusion

### Key Takeaways

Running Qdrant successfully in production requires three areas of design decisions to work together. First, in **collection design**, choose vector dimensions, distance metric, and data types carefully, and create appropriate indexes on every payload field used for filtering. Dimensions and distance metric cannot be changed after creation, so the initial design determines the operational cost of everything that follows. Second, in **HNSW tuning**, set an upper bound for `m` within your memory budget first, set `ef_construct` to 2–4x `m`, and adjust `hnsw_ef` at search time according to your service SLA. Third, in **filter optimization**, create indexes on all filter fields and place high-selectivity conditions at the front of the `must` array.

### Decision Criteria

Qdrant is a good fit when vector search is the core workload, when you have data residency requirements or need tight cost control, and when you need to search millions of vectors or more together with payload filters. If you're already running Elasticsearch and vector search is a small fraction of your workload, trying Elasticsearch's kNN first is the lower-complexity choice. If you need to handle hundreds of millions of vectors or more, it's worth exploring the combination of Binary quantization and on-disk indexes to cut memory costs by an order of magnitude. Since Qdrant 1.9, **sparse vector** support has stabilized, so a hybrid search architecture that stores both dense and sparse vectors in a single cluster is now operationally viable. The most practical starting point is `float16` + Scalar quantization + `m=32` — deploy that, observe real traffic patterns, then tune from there.
