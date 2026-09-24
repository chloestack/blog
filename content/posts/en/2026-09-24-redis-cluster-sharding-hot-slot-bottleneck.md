---
title: "Redis Cluster Sharding Strategy and Hot Slot Bottleneck Resolution"
date: "2026-09-24 11:13"
category: "Database"
tags: ["Redis Cluster", "hot slot", "sharding", "distributed cache", "performance optimization"]
excerpt: "How hot slots form in Redis Cluster, how to detect them, and concrete strategies to fix them without just throwing more nodes at the problem."
koSlug: "2026-09-24-Redis-Cluster-샤딩-전략과-핫-슬롯-병목-해결"
---

## Table of Contents

1. Overview
2. Understanding Redis Cluster's Sharding Mechanism
3. Hot Slot Bottleneck: Causes and Detection
4. Hot Slot Resolution Strategies — Data Distribution Design
5. Slot Rebalancing in Production
6. Performance Characteristics and Trade-off Comparison
7. Closing

---

## Overview

Redis Cluster is a distributed architecture that delivers horizontal scalability and high availability at the same time. But if you design your sharding strategy poorly, you end up with a **hot slot** — traffic concentrating on a single node — and that one node becomes the bottleneck for the entire system, not the cluster as a whole. This post starts from how Redis Cluster distributes hash slots, analyzes the structural causes of hot slots, and covers concrete resolution strategies that have been validated in production.

Redis Cluster assigns 16,384 slots across nodes. Which node a key belongs to is determined by the simple formula `CRC16(key) % 16384`. The mechanism itself is solid, but if application code generates too many keys sharing the same prefix, or if certain business entities end up concentrated in the same hash slot, one node gets overloaded. What makes it worse is that due to Redis's single-threaded nature, processing delays on that node propagate to every command queued behind it.

### Background

Even after setting up a cluster, seeing one or two nodes with CPU usage above 90% in your monitoring dashboard while the rest sit at 10–20% is a textbook hot slot signal. Since Redis 7.x was widely adopted after 2022, cluster deployments have grown larger, and reports of slot distribution imbalances have become more frequent as a result.

Early on, the prevailing assumption was simply "add more nodes." But adding nodes often does nothing to fix a hot slot. Even if slots are already distributed across many nodes, write operations concentrated on one specific slot are handled exclusively by the single node that owns that slot. Without understanding this structural constraint, you can easily end up spending money on horizontal scaling while the real problem stays put.

### Limits of the Old Approach

In a traditional standalone Redis instance or a Sentinel setup there's no sharding, so the hot slot problem doesn't exist. When teams migrate to a cluster they almost always carry over their existing key design. Key structures like `{user}:{id}:session` that worked fine in a single-instance setup cause unexpected slot concentration in a cluster because of how hash tags (`{}`) work. Hash tags are a tool for multi-key operations, but using them indiscriminately is itself the cause of broken distribution.

---

## Understanding Redis Cluster's Sharding Mechanism

### How Hash Slot Distribution Works

Redis Cluster divides data into logical units called **slots**. All 16,384 slots are assigned to master nodes, and when a client reads or writes a key, Redis routes the request to the slot that key belongs to and the node responsible for that slot. With three master nodes the slots are split roughly evenly.

The slot number calculation is straightforward: apply CRC16 to the entire key and take the remainder when divided by 16384. However, if the key contains curly braces (`{…}`), only the content inside the braces is hashed. That feature is the **hash tag**, and it forces multiple keys into the same slot so that multi-key commands (`MGET`, `MSET`, pipelining) and Lua scripts can be used in a cluster.

```diagram
en/2026-09-24-22e347e3-01
```

With a hash tag, the slot is determined solely by the content inside the braces, so `{user}:1:data` and `{user}:2:data` are different keys but land in the same slot.

---

### The Two Sides of Hash Tags

Hash tags are the key feature that makes atomic multi-key operations possible in Redis Cluster. For example, when implementing a shopping cart, putting `{session:abc}:cart` and `{session:abc}:metadata` in the same slot lets a single Lua script update both keys atomically. That's a reasonable approach to approximating transactions in a distributed environment.

The problem shows up when the hash tag scope is too broad. If you use a common prefix like `{global}:` or `{app}:` as a hash tag across the whole application, millions of keys pile into a single one of the 16,384 slots. That design completely defeats the purpose of having a cluster.

| Hash Tag Design | Number of Slots | Distribution | Notes |
|---|---|---|---|
| No tag | Different slot per key | Maximum distribution | Multi-key commands unavailable |
| `{userId}:*` | 1 per user | Reasonable distribution | Scales with user count |
| `{service}:*` | 1 per service name | Highly concentrated | Hot slot risk |
| `{global}:*` | 1 slot | No distribution | Immediate bottleneck |

---

### Cluster Topology and Redirection

When a client sends a request to the wrong node, Redis replies with `-MOVED` and tells it the address of the correct node. This redirection is handled automatically, but if a client with a stale slot map keeps sending requests to the wrong node, it doubles the network round-trips. That's why client libraries like Lettuce and Jedis cache the slot-to-node mapping table internally and only refresh it when a node change is detected.

```diagram
en/2026-09-24-22e347e3-02
```

A `-MOVED` response causes only a single redirection, but in environments where cluster topology changes frequently, how often the slot map gets refreshed affects latency.

---

## Hot Slot Bottleneck: Causes and Detection

### How the Bottleneck Forms

Redis runs on a single thread for command execution (I/O can be multi-threaded, but command processing is single-threaded). This design guarantees lock-free atomicity, but when operations concentrate on a specific slot, the event loop of the node owning that slot saturates. Other nodes in the cluster can be idle while that node's processing queue keeps growing, and P99 latency spikes sharply as a result.

The three most common hot slot scenarios are: first, operations like `INCR` or `ZINCRBY` for counters, rankings, or real-time aggregation hitting a single key tens of thousands of times per second; second, logically unrelated keys piling into the same slot because of the hash tag overuse described above; and third, a batch processing script sequentially generating a large volume of keys with the same pattern and causing a temporary write burst on a specific slot.

```diagram
en/2026-09-24-22e347e3-03
```

Horizontally scaling the cluster doesn't change which node owns the hot slot, so the bottleneck doesn't go away.

---

### How to Detect Hot Slots

Since Redis 7.0 you can use `CLUSTER SHARDS` to check key distribution per slot in addition to `LATENCY HISTORY` and `SLOWLOG`. The most direct detection tools are the `redis-cli --hotkeys` option and the `OBJECT FREQ` command. `--hotkeys` only works when `maxmemory-policy` is set to an LFU-based policy; it reads per-key access frequency and prints the top hot keys.

If you're on a Prometheus + Grafana stack, the most practical approach is comparing `redis_exporter`'s `redis_cluster_slots_ok` with per-node `redis_commands_processed_total`. If a specific node's command throughput is more than three times the average, classify it as a hot slot suspect and analyze the key distribution on that node.

```diagram
en/2026-09-24-22e347e3-04
```

Following the detect → analyze → strategize flow lets you narrow down the bottleneck and avoid unnecessary refactoring.

---

### Script for Analyzing Slot Key Distribution

Once you've pinpointed a hot slot, you need to find out which keys are packed into it. The `CLUSTER GETKEYSINSLOT` command serves this purpose.

Knowing the slot number alongside the key patterns lets you estimate the scope of key design changes before you start.

```bash
# Extract a sample of 100 keys in slot 1234
redis-cli -c CLUSTER GETKEYSINSLOT 1234 100

# Key count distribution across all slots (excerpt from a Python script)
import redis
r = redis.RedisCluster(host='localhost', port=7000)
slot_dist = {}
for node in r.get_primaries():
    for slot in node.slots:
        count = node.redis_connection.execute_command(
            'CLUSTER COUNTKEYSINSLOT', slot
        )
        slot_dist[slot] = count  # result: {1234: 892000, 1235: 1200, ...}

hot = sorted(slot_dist.items(), key=lambda x: x[1], reverse=True)[:5]
print(hot)
# result: [(1234, 892000), (5678, 410000), ...]
```

If slot 1234 holds 892,000 keys while adjacent slots have only 1,200, you should immediately suspect hash tag overuse or a specific key pattern concentration.

---

## Hot Slot Resolution Strategies — Data Distribution Design

### Load Distribution via Key Suffix Sharding

The most direct fix is **key splitting** — spreading operations concentrated on a single key across multiple keys. For example, if a `page:view:count` key is being `INCR`ed 50,000 times per second, split it into 16 keys: `page:view:count:0` through `page:view:count:15`. Each request picks a shard with `random() % 16` and runs `INCR` on it, and only when you actually need the total do you read all 16 keys with `MGET` and sum them.

This approach fits well for **counters, ranking score aggregation, and real-time statistics** where individual operations are independent and the final aggregation can happen in post-processing. The trade-off is that you add a summation step on reads, and since the split keys are scattered across different slots, atomic operations are no longer possible. For counters and statistics where a small margin of error is acceptable, that trade-off is easy to live with.

```diagram
en/2026-09-24-22e347e3-05
```

Writes distribute, reads aggregate — this pattern spreads single-key concentration proportionally across the number of nodes.

---

### Revisiting Hash Tag Design

To correct hash tag overuse, the most common cause of hot slots, first distinguish between cases where hash tags are **genuinely necessary** and cases where they're used out of habit. Hash tags are strictly required only when you need to atomically manipulate two or more keys within a Lua script or a `WATCH`/`MULTI`/`EXEC` transaction. Using hash tags simply because "I want to query the same user's data together" cuts your distribution benefit in half.

The principle for minimizing hash tag scope is **group by the narrowest unit possible**. Using a concrete identifier as the tag — `{user:12345}:` instead of `{user}:` — means the number of distinct slots scales with the number of users, and distribution is preserved. If you have a million user IDs, hash tags structured this way can spread data across up to a million different slots (within the 16,384-slot ceiling).

| Hash Tag Pattern | Slot Variety | Atomicity Scope | Recommended |
|---|---|---|---|
| `{app}:user:*` | 1 slot | All keys | ❌ Guaranteed hot slot |
| `{user}:*` | Fixed count (~dozens) | Everything containing "user" | ⚠️ Dangerous |
| `{user:12345}:*` | Proportional to user count | That user only | ✅ Recommended |
| No tag | Varies per key | Single key only | ✅ When multi-key is unnecessary |

---

### Distribute Read Load to Replicas

Key splitting addresses the problem of write operations concentrated on a specific slot, but when it's read operations that are concentrated, **replica reads** are an effective complement. In Redis Cluster, replicas don't serve read requests by default. If a client sends a `READONLY` command to a replica first, subsequent reads are handled by that replica directly.

With the Lettuce client you can enable this behavior simply by setting `ReadFrom.REPLICA_PREFERRED`. Note that replica reads only guarantee **eventual consistency**. If you write to a master and immediately read from a replica, replication lag (typically within a few milliseconds) means you might get the previous value. That means replica reads must not be applied to cases requiring strong consistency, such as session data or inventory counts.

```java
// Lettuce replica read activation example
RedisClusterClient client = RedisClusterClient.create("redis://localhost:7000");
ClusterClientOptions options = ClusterClientOptions.builder()
    .readFrom(ReadFrom.REPLICA_PREFERRED) // replicas preferred, fall back to master
    .build();
client.setOptions(options);

StatefulRedisClusterConnection<String, String> conn = client.connect();
// subsequent read requests are distributed to replicas
// result: master read load reduced by ~50-66% (with 2 replicas)
```

Replica reads are the simplest hot slot mitigation strategy available — one line of configuration can cut master read load by half or more.

---

## Slot Rebalancing in Production

### How Slot Migration Works

Another way to resolve a hot slot is to move the slot itself to a less busy node. Redis Cluster can migrate slots online using the `CLUSTER SETSLOT` and `MIGRATE` commands, and `redis-cli --cluster rebalance` automates this process. This procedure is called **slot migration**.

During migration, the affected slot enters `-ASK` redirect state. Unlike `-MOVED`, `-ASK` signals a temporary condition: the client must send an `ASKING` command before issuing the request to the new node. Most Redis client libraries handle this transition transparently, but if migration runs too fast, clients may see transient latency spikes or errors. In production, set `--cluster-migration-barrier` and `--cluster-node-timeout` conservatively to control migration speed.

```diagram
en/2026-09-24-22e347e3-06
```

Migration is a four-phase state transition; at each phase the cluster maintains consistency by responding with `-ASK`.

---

### Zero-Downtime Rebalancing Strategy

The biggest risk when rebalancing slots in a live environment is **request errors on slots being migrated**. Because `MIGRATE` moves keys one at a time, migrating a slot with hundreds of thousands of keys can take minutes to tens of minutes. During that window, features using that slot may experience latency spikes.

The recommended procedure for safe rebalancing is: choose the lowest-traffic time window first; validate cluster health upfront with `redis-cli --cluster check`; limit the number of slots moved at once (`--cluster-slots`); monitor `instantaneous_ops_per_sec` from `INFO stats` during the migration to catch anomalies immediately; and after migration completes, re-verify the slot distribution and confirm latency has normalized.

| Step | Command / Action | Notes |
|---|---|---|
| Pre-validation | `redis-cli --cluster check` | No existing errors allowed |
| Rebalancing | `--cluster rebalance --use-empty-masters` | Run during minimum-traffic window |
| Monitoring | `INFO stats`, `LATENCY HISTORY` | Use P99 as the baseline |
| Completion check | `CLUSTER INFO`, `CLUSTER SHARDS` | Confirm even slot distribution |

---

### Slot Reassignment Without Adding Nodes

You can distribute a hot slot by reassigning slots among existing nodes without adding new ones. The key is moving the hot slot to a relatively idle node. For example, if node A owns slots 0–5460 and slot 1234 among them is hot, you can move just slot 1234 to node B or node C. This redistributes the load at no additional cost.

For this to be effective, though, the hot slot's load must be isolated at the slot level rather than at the node level. If a single hot slot is receiving hundreds of thousands of operations per second, whichever node you move it to becomes the new bottleneck. In that case, apply key splitting or replica read distribution first rather than moving slots.

```diagram
en/2026-09-24-22e347e3-07
```

The right strategy depends on the cause of the hot slot. Root cause analysis first — not a one-size-fits-all fix.

---

## Performance Characteristics and Trade-off Comparison

### Cluster Behavior from a Benchmark Perspective

In theory, Redis Cluster throughput scales linearly with the number of master nodes. Benchmarking a 3-node cluster against a single instance with `redis-benchmark` — when keys are evenly distributed — yields roughly 2.8–3x the throughput. But even a single hot slot caps the entire cluster's throughput at the limit of that one node.

Numbers commonly seen in real production scenarios: with a single master node maxing out at around 100,000 ops/sec (mixed get/set), a 3-master setup with even slot distribution delivers roughly 280,000–300,000 ops/sec. But if one hot slot handles 70% of total traffic, the whole cluster saturates at around 140,000 ops/sec. Doubling the number of nodes without fixing the hot slot produces almost no improvement in throughput.

```diagram
en/2026-09-24-22e347e3-08
```

Slot distribution — not node count — determines actual throughput. The throughput gain from resolving a hot slot dwarfs the gain from adding nodes.

---

### Comparison with Alternative Technologies

Distributed cache and store technologies similar to Redis Cluster include **Memcached clusters**, **Apache Ignite**, **Hazelcast**, and client-side sharding approaches (Twemproxy, Envoy Proxy-based). Each handles the hot slot problem differently.

Memcached's client-side sharding has no cluster awareness on the server side, so hot node problems can still occur, but the lack of a slot concept means there's also no flexibility to reassign anything. Putting Twemproxy (Nutcracker) in front of Redis simplifies client code but can make the proxy layer itself a bottleneck, and it isn't compatible with the Redis Cluster protocol.

| Technology | Hot Node Mitigation | Online Reassignment | Cluster Awareness | Best For |
|---|---|---|---|---|
| Redis Cluster | Slot migration | Supported | Native | General-purpose cache/sessions |
| Memcached | Client-side rehashing | Not supported | Not supported | Simple caching |
| Twemproxy | Proxy round-robin | Requires restart | Proxy layer | Legacy environments |
| Hazelcast | Near-cache, partition moves | Supported | Native | JVM-based applications |

---

### When to Choose Redis Cluster

Consider Redis Cluster when you're entering a scale that a single instance or Sentinel can't handle (100 GB+ memory, hundreds of thousands of ops/sec), or when you need high availability that prevents a single node failure from affecting the whole service. That said, a cluster raises operational complexity significantly compared to a single node. Lua scripts can't span keys on different nodes, `SCAN` must be run per node, and client libraries must support the cluster protocol.

If your data fits in a few gigabytes and your current Sentinel setup is stable, migrating to a cluster only adds operational burden. The decision should factor in not just performance numbers but also the team's operational capabilities, client library support, and the migration cost of your existing key design.

---

## Closing

### Key Takeaways

Redis Cluster achieves horizontal scalability by distributing 16,384 slots across nodes, but when operations concentrate on a specific slot, a single node becomes the bottleneck rather than the cluster as a whole. The main causes of hot slots are hash tag overuse and concentrated writes to a single key; you can detect them with `redis-cli --hotkeys` and `CLUSTER COUNTKEYSINSLOT`. The right resolution strategy depends on the cause: replica reads for read concentration, key suffix sharding for write concentration, and slot rebalancing for structural imbalance.

Apply hash tags only to the minimum scope where multi-key atomicity is genuinely needed, and narrow the tag to a concrete identifier (`{user:12345}:`) — that's the most fundamental design principle for maintaining slot distribution.

### Decision Criteria for Applying This

If specific nodes consistently run above 80% CPU after setting up Redis Cluster while the rest have headroom, analyze slot distribution and hot keys before reaching for horizontal scaling. Adding nodes is a scaling measure for after the hot slot is resolved. When designing a new system as a cluster, document your hash tag policy upfront, and design high-frequency write keys — counters, aggregations — with suffix sharding from day one. That's the most effective way to prevent production bottlenecks. Slot rebalancing is a powerful tool, but moving slots without fixing the underlying key design just relocates the bottleneck to a different node.
