---
title: "Redis RDB vs AOF Persistence Strategies Compared"
date: "2026-09-19 07:49"
category: "Database"
tags: ["Redis", "AOF", "RDB", "data persistence", "disaster recovery"]
excerpt: "A deep dive into how Redis RDB snapshots and AOF logs work internally, when to use each, and how to run them together safely in production."
koSlug: "2026-09-19-Redis-RDB와-AOF-영속성-전략-비교"
---

## Table of Contents

1. Overview
2. Fundamentals of Redis Persistence
3. RDB Snapshots — How Point-in-Time Recovery Works
4. AOF Log — Command-Based Durability
5. RDB vs AOF: Comparison and Selection Criteria
6. Hybrid Strategy and Production Deployment
7. Closing

---

## Overview

### Problem Background

Redis is fundamentally an in-memory data store. That characteristic enables extremely fast responses, but the moment a process restarts or a server goes down, any data that existed only in memory is gone. If you're using Redis purely as a cache, this doesn't matter. But the moment you hand Redis a role that **requires data durability** — session store, distributed lock, leaderboard, event queue — whether it can recover after a restart determines the reliability of your entire system.

Redis provides two persistence mechanisms to address this. **RDB (Redis Database Backup)** writes a memory snapshot at a specific point in time to disk, and **AOF (Append Only File)** sequentially appends every write command executed to a file. The two approaches differ fundamentally in design philosophy and recovery guarantee level. Which one you choose in production significantly affects how much data you lose during a failure and how long recovery takes.

### Limitations of the Default Approach

Many teams deploy Redis with its default configuration, or just enable an RDB setting like `save 900 1` and call it done. This works fine when the server shuts down cleanly, but in an abnormal termination — an unexpected forced process kill or the OOM killer stepping in — every change since the last snapshot is lost. Even if you've enabled AOF, not understanding whether to choose `appendfsync always` or `everysec`, or how to keep the AOF file from growing indefinitely, leads to unintended performance degradation or disk exhaustion. This post covers both the internal mechanics of each approach and the selection criteria for production environments.

---

## Fundamentals of Redis Persistence

### The Gap Between Memory and Disk

Redis data lives in RAM for the lifetime of the instance. Persistence is the work of periodically or continuously reflecting that memory state to disk, so the instance can return to its previous state after a restart. There are two core questions: **when** to write to disk, and **what** to write.

RDB answers the "what" question by saving a complete binary snapshot of the entire memory. AOF takes "when" to the extreme, recording each write command as a text log entry every time it executes (or every second). Both approaches read this file when the Redis process starts to reconstruct the memory state.

```diagram
en/2026-09-19-acc35f49-01
```

RDB and AOF both move memory state out to disk, but their representation and reconstruction methods during recovery are entirely different.

### Failure Scenarios When Persistence Is Disabled

Setting both `save ""` and `appendonly no` puts Redis into pure in-memory mode. In this case, a clean `SHUTDOWN` terminates without saving the last state. If the process dies abnormally during operation, there is no last checkpoint to recover from.

For data that can be regenerated — session data, temporary queues — this mode is actually appropriate. But if you need persistence, you must understand the trade-offs of whichever approach you choose before applying it.

| Persistence mode | Data loss on failure | Restart recovery time | Primary use cases |
|---|---|---|---|
| None | Everything | Immediate (empty state) | Pure cache |
| RDB only | Since last snapshot | Fast (binary load) | Analytical snapshots |
| AOF only | 0–1 second depending on fsync setting | Slow (command replay) | Durability-first |
| RDB + AOF | 0–1 second depending on fsync setting | Medium (AOF primary, RDB fallback) | Recommended production setup |

---

## RDB Snapshots — How Point-in-Time Recovery Works

### The fork and Copy-on-Write Mechanism

The most important characteristic of RDB snapshots is that **the Redis main process is barely blocked**. When a `BGSAVE` command is issued, Redis creates a child process via the `fork()` system call. Instead of physically copying the parent's memory pages, the child process leverages the operating system's **Copy-on-Write (CoW)** mechanism. Initially both processes share the same physical memory pages, and a page is only actually copied when the parent process modifies it.

This lets the child process obtain a memory snapshot at the time of `fork()` relatively cheaply, while the main process continues serving client requests. However, there is a hidden cost. If write requests flood in while a snapshot is in progress, CoW can cause actual memory usage to nearly double. It's not uncommon for a Redis instance using 32 GB to momentarily need over 60 GB of memory during a BGSAVE.

```diagram
en/2026-09-19-acc35f49-02
```

After `fork()`, while the child process writes the snapshot, the main process continues accepting writes, and only modified pages are copied via CoW.

### Configuring RDB Trigger Conditions

RDB uses the `save` directive in `redis.conf` to set automatic save conditions. The format is `save <seconds> <changes>`: if the specified number of key changes occur within the specified number of seconds, BGSAVE is triggered.

Below is an example with three commonly used conditions set simultaneously. Redis starts a snapshot when any one of them is met.

```conf
# redis.conf — RDB automatic save configuration
save 900 1       # snapshot if at least 1 key changed in 15 minutes
save 300 10      # snapshot if at least 10 changes in 5 minutes
save 60 10000    # snapshot if at least 10000 changes in 1 minute

dbfilename dump.rdb
dir /var/lib/redis

# refuse writes if snapshot fails
stop-writes-on-bgsave-error yes

# RDB compression (lzf algorithm, increases CPU usage)
rdbcompression yes
rdbchecksum yes
```

`stop-writes-on-bgsave-error yes` makes Redis refuse write requests when a snapshot fails. Without this setting, snapshot failures pass silently and operators may not notice that data is going unprotected.

### RDB Strengths and Limitations

An RDB file is a complete binary representation of the dataset at a specific point in time, so file size is small and load speed is fast. Even an RDB file holding millions of keys loads into memory much faster than AOF. That's why RDB is the better choice when you need fast service recovery after a restart on a large dataset.

The critical weakness of RDB, however, is that **it cannot guarantee data written after the last snapshot**. With a `save 60 10000` setting, if the server goes down immediately after a snapshot completes, all changes made in the following up to 60 seconds are gone. In a system handling thousands of writes per second, 60 seconds means hundreds of thousands of lost records. If that loss window doesn't fit your business requirements, you need to consider AOF.

---

## AOF Log — Command-Based Durability

### Sequential Recording of Write Commands

AOF appends every write command Redis processes to the end of a file in RESP (Redis Serialization Protocol) text format. Open the file and you'll see every modification command — `SET`, `HSET`, `LPUSH`, and so on — listed in execution order. When Redis restarts, it reads this file from beginning to end and replays the commands one by one to restore the memory state.

This approach is straightforward, but the AOF file grows without bound over time. If `SET` is called 1000 times on the same key, all 1000 entries remain in the AOF — even though only the last value is needed for restoration. Redis addresses this with an **AOF rewrite** mechanism.

```diagram
en/2026-09-19-acc35f49-03
```

AOF rewrite generates a minimal command set from the current memory state, drastically reducing the file size.

### fsync Policy and Durability Guarantees

The central parameter for AOF is `appendfsync`. Operating systems tend to buffer file writes rather than flushing them to disk immediately. The `fsync()` system call forces that buffer to be written to disk. The `appendfsync` setting controls how often Redis calls `fsync()`.

```conf
# redis.conf — AOF configuration
appendonly yes
appendfilename "appendonly.aof"
dir /var/lib/redis

# choose one fsync policy
# appendfsync always    # fsync on every write — safest, slowest
appendfsync everysec    # fsync every second — recommended (max 1 second loss)
# appendfsync no        # let the OS decide — fast but no durability guarantee

# AOF rewrite settings
auto-aof-rewrite-percentage 100  # rewrite when AOF grows 100% beyond its base size
auto-aof-rewrite-min-size 64mb   # only rewrite once at least 64 MB

# behavior on truncated AOF after abnormal shutdown
aof-load-truncated yes
aof-use-rdb-preamble yes
```

`always` waits until each write command is committed to disk before responding to the client, which significantly reduces throughput. Even at a few hundred writes per second, write latency becomes noticeably higher. `no` only lets the OS decide when to fsync, so there is no durability guarantee. For most production environments, `everysec` provides a reasonable balance.

| appendfsync | Maximum data loss | Performance impact | Recommended for |
|---|---|---|---|
| `always` | ~0 (nearly none) | High (throughput drops significantly) | Financial transactions, absolute durability required |
| `everysec` | Up to 1 second | Low (recommended) | Most production environments |
| `no` | Up to OS buffer size | None | No durability needed, cache-only |

### How AOF Rewrite Works Internally

AOF rewrite creates a child process via `fork()`, similar to an RDB snapshot. The child process writes a new AOF file based on the current memory state. New write commands received by the main process during this time are saved to a separate rewrite buffer alongside the existing AOF file. Once the child finishes writing the new file, the contents of the rewrite buffer are appended to it, and the old file is atomically replaced.

The `aof-use-rdb-preamble yes` setting enables **hybrid AOF** mode, introduced in Redis 4.0. During a rewrite, the new AOF file begins with an RDB-format snapshot, followed by AOF-format commands from that point forward. This approach gives you both RDB's fast load speed and AOF's fine-grained durability at restart.

---

## RDB vs AOF: Comparison and Selection Criteria

### Recovery Performance Differences by Scenario

In a failure recovery situation, the difference between the two approaches goes beyond just how much data is lost. **Recovery time** also differs significantly. Assume you're recovering a Redis instance holding 100 million keys: RDB load takes tens of seconds, but AOF replay can take tens of minutes. The reason is simple. RDB loads into memory almost like a direct binary mapping, whereas AOF requires parsing and executing each command in memory, repeated millions of times.

However, with `aof-use-rdb-preamble yes`, this gap narrows considerably. Hybrid AOF loads quickly up to the RDB snapshot point, then only replays the commands that follow.

```diagram
en/2026-09-19-acc35f49-04
```

Each persistence mode represents a different trade-off between speed and accuracy in the recovery path.

### Selection Criteria

The choice depends on the nature of your data and your business requirements. The most important question is: "How many seconds of data loss can we tolerate in a failure?"

For data that can be regenerated after expiry — like session cache — RDB alone or no persistence at all is sufficient. For data where even a single lost record translates to a business loss — payment processing queues, inventory change events — you need AOF with `appendfsync always`. Most services fall somewhere in between, and a hybrid strategy of AOF with `appendfsync everysec` combined with RDB is the practical choice.

```diagram
en/2026-09-19-acc35f49-05
```

You must define the data characteristics and acceptable loss window first before the right persistence strategy becomes clear.

---

## Hybrid Strategy and Production Deployment

### Running RDB + AOF Together

The official Redis documentation recommends using RDB and AOF together in production environments where durability matters. When both are enabled, Redis uses the AOF file first on restart because it contains more recent data. RDB serves mainly as a fast backup restore, initial replica synchronization, and a safety net when the AOF is corrupted.

```diagram
en/2026-09-19-acc35f49-06
```

When both AOF and RDB are present, Redis prefers AOF, so keeping both files is the safest configuration.

Here is the recommended hybrid configuration for production:

```conf
# redis.conf — RDB + AOF hybrid production configuration

# --- RDB settings ---
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb
dir /var/lib/redis/data
stop-writes-on-bgsave-error yes
rdbcompression yes
rdbchecksum yes

# --- AOF settings ---
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-load-truncated yes
aof-use-rdb-preamble yes  # enable hybrid AOF

# --- Memory and logging settings ---
maxmemory 8gb
maxmemory-policy allkeys-lru
loglevel notice
logfile /var/log/redis/redis-server.log
```

`no-appendfsync-on-rewrite no` keeps `fsync` running even during AOF rewrite. Setting this to `yes` means commands buffered in the OS during a rewrite won't be flushed, temporarily reducing durability. If durability is a priority, keep the default value of `no`.

### Persistence Strategy in a Replication Environment

Running Redis Sentinel or Redis Cluster requires a more careful approach to persistence settings. Enabling persistence on the master means `fork()` costs from `BGSAVE` or AOF rewrite can affect master response latency. For this reason, some teams **disable persistence on the master and enable AOF on replicas**.

This configuration is risky, though. If the master restarts, it comes up with an empty dataset, and if automatic failover isn't configured, the replicas can sync with this empty master and lose all their data. If you disable persistence on the master, you must **always pair it with automatic failover (Sentinel/Cluster)**, and you must regularly verify that replica promotion works correctly when the master restarts.

```diagram
en/2026-09-19-acc35f49-07
```

In a replication environment you can offload persistence overhead to replicas, but automatic failover must be in place first.

---

## Operational Considerations

### Common Mistakes and Pitfalls

**fork() latency spikes** are one of the most frequently encountered problems in practice. The moment `BGSAVE` or AOF rewrite starts, the `fork()` system call itself can consume tens to hundreds of milliseconds. During that time the Redis main process is blocked. The cause is almost always Transparent HugePages (THP). On Linux servers with THP enabled, the page table copying cost during `fork()` increases significantly. The official Redis documentation explicitly recommends disabling THP on production servers.

```bash
# Disable THP (takes effect immediately)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Persist across reboots — add to /etc/rc.local or a systemd service
# Verify: cat /sys/kernel/mm/transparent_hugepage/enabled
# Expected output: always madvise [never]  -> [never] is selected
```

**AOF file corruption** is another risk. During a full disk or a forced server shutdown, the end of the AOF file may be written incompletely. `aof-load-truncated yes` (the default) ignores the last incomplete command in this case and proceeds with restoration. You can also validate and repair the file manually with `redis-check-aof --fix appendonly.aof`.

### Monitoring and Debugging

Persistence-related metrics are available via the `INFO persistence` command. These are the key metrics to monitor regularly in production:

| Metric | How to check | Alert threshold |
|---|---|---|
| Time of last successful snapshot | `rdb_last_save_time` | Elapsed time more than 2x the configured save interval |
| RDB save status | `rdb_last_bgsave_status` | Any value other than `ok` |
| AOF last rewrite status | `aof_last_rewrite_status` | Any value other than `ok` |
| AOF buffer size | `aof_buffer_length` | Abnormally large value (in MB) |
| fork() latency | `latest_fork_usec` | Exceeds several hundred ms |

`rdb_last_save_time` is returned as a Unix timestamp. You can convert it for readability with `$(date -d @<timestamp>)`. In a Prometheus-based monitoring setup, `redis_exporter` collects these metrics automatically and you can visualize them in a Grafana dashboard.

```diagram
en/2026-09-19-acc35f49-08
```

Connecting persistence metrics to an external monitoring stack lets you detect snapshot failures or AOF rewrite errors in real time.

### Considerations for Scaling and Migration

As dataset size grows, the burden of RDB snapshots and AOF rewrites grows with it. On a Redis instance holding tens of gigabytes, a single `BGSAVE` can take several minutes, during which CoW-driven memory usage can far exceed the actual dataset size. At this scale, **data partitioning** is worth examining. Introducing Redis Cluster and reducing the size of individual shards distributes the persistence burden across instances.

When changing persistence settings, you can apply them at runtime with `CONFIG SET`, but to survive a restart you must also update `redis.conf`. When enabling AOF for the first time, after issuing `CONFIG SET appendonly yes`, Redis automatically generates an AOF file from the current memory state. This can cause a temporary spike in disk I/O, so apply it during a low-traffic period.

---

## Closing

### Key Takeaways

The heart of Redis persistence strategy is **defining your RPO (Recovery Point Objective) and RTO (Recovery Time Objective) first**. RDB provides fast recovery via binary snapshot but cannot guarantee data written after the last snapshot. AOF records write commands in real time or at one-second intervals to minimize data loss, but restart recovery takes longer. Hybrid AOF via `aof-use-rdb-preamble yes` combines the advantages of both and is the most balanced option in practice. fork() latency, THP deactivation, AOF corruption handling, and persistence metric monitoring are all things you must get right for operational stability.

### Decision Framework

When choosing a persistence configuration, working through these steps in order is effective. First, determine whether the data this Redis instance holds can be regenerated. Sessions, temporary computed results, and pure cache data don't need persistence — enabling it for them only causes a performance penalty. If the data can't be regenerated, agree with the business team on how many seconds of loss are acceptable in a failure. If up to one second of loss is acceptable, AOF with `appendfsync everysec` combined with RDB satisfies most requirements. If any loss at all is unacceptable, you must accept the performance cost of `appendfsync always`, and that decision must be validated with load testing. In a replication environment, using replicas for persistence is safer than disabling it on the master, but automatic failover configuration must come first.
