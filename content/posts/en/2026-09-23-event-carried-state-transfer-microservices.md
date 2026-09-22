---
title: "Breaking Synchronous Microservice Calls with Event-Carried State Transfer"
date: "2026-09-23 02:26"
category: "Architecture"
tags: ["microservices", "event-driven architecture", "Kafka", "eventual consistency"]
excerpt: "Learn how the Event-Carried State Transfer pattern replaces synchronous service-to-service calls with event-driven state replication to eliminate runtime coupling."
koSlug: "2026-09-23-Event-Carried-State-Transfer로-마이크로서비스-동기-호출-끊기"
---

## Table of Contents

1. Overview
2. Understanding the Event-Carried State Transfer Pattern
3. Coupling and Failure Propagation from Synchronous Calls
4. Implementing Event-Carried State Transfer
5. Consistency Model and Trade-offs
6. Considerations for Production
7. Closing Thoughts

---

## Overview

### Background

In a microservices architecture, cross-service data lookups naturally get implemented as HTTP API calls. The order service asks the shipping service "what's the delivery status of this order?", and the product service asks the inventory service "how much stock is left for this SKU?" This structure looks simple and clear at first, but as the number of services grows into the dozens, it produces unexpected complexity. The **Event-Carried State Transfer (ECST)** pattern is an approach that replaces exactly these synchronous call dependencies with event-driven state replication.

Event-Carried State Transfer goes beyond simply "firing events." It embeds enough data about the state change in each event so that the receiving service can process it without making a follow-up query. The publisher emits the full changed state (or the changed fields) as an event whenever state changes, and subscribers apply it to their local projections. This eliminates runtime dependencies, and each service handles its business logic using only the data it already holds.

This post looks at why synchronous calls are problematic in concrete numbers, covers the structure and implementation of the ECST pattern, the trade-offs in an eventual consistency model, and the real issues you encounter in production.

### Limitations of the Existing Approach

REST-based synchronous calls are intuitive but fundamentally **couple two services at runtime**. The caller can only function normally when the callee is alive. If the callee is slow, the caller slows down; if the callee dies, the caller fails. Circuit breakers and timeouts can partially mitigate this, but they cannot prevent the availability loss itself.

The bigger problem appears when the call chain deepens. In a four-level call chain A → B → C → D, D's 99% availability drags the entire chain's availability down to 0.99⁴ ≈ 96%. Even if each service independently offers an excellent SLA, the availability of the entire chain degrades exponentially with the number of members. ECST eliminates this runtime coupling itself, so each service operates independently of its partners' failures.

---

## Understanding the Event-Carried State Transfer Pattern

### Core Concept and How It Works

The central idea behind Event-Carried State Transfer is simple: switch from "ask when you need it" to "notify when something changes." When notifying of a change, you don't just send a signal saying "something changed" — you send the data: "here is the changed state."

This is what distinguishes it from similar patterns. The **Event Notification** pattern sends only a signal that something changed, and the receiver still calls the sender's API to fetch the detailed data. **Event Sourcing** focuses on storing and reconstructing the history of state changes; ECST can be implemented without Event Sourcing. ECST specializes in embedding enough current-state data in the event itself so that the receiver can maintain a local replica without any separate call.

In the publish-subscribe model, the producer service publishes an event to a topic whenever domain state changes. The event carries the identifier of the changed entity along with a state snapshot containing the fields the subscriber needs. Subscribers consume these events and apply them to their local database (or cache). When a subscriber later needs that data, it reads its own local replica rather than querying the publisher.

```diagram
en/2026-09-23-151ea635-01
```

Each subscriber operates independently of the publisher; the event broker is the only link between them.

### Key Components

There are three core elements that make up the ECST pattern.

The **event producer** publishes an event whenever domain state changes. The crucial point is that the event must contain the state the subscriber needs, not just a bare notification. This means the producer needs some awareness of which fields its subscribers require. Embedding too many fields increases event size and may expose unnecessary information, so it is important to define a clear published language.

The **event broker** is a messaging system — Kafka, Pulsar, RabbitMQ, etc. — responsible for durability guarantees and publish-subscribe routing. Brokers like Kafka that persist messages to disk are particularly well-suited to ECST because they can replay history when a new subscriber joins or an existing one needs to reprocess events.

The **local projection** is the local data replica that a subscriber maintains by consuming events. It is not a full copy of the publisher's data, but a **contextualized view** that extracts only the fields relevant to that subscriber's service context. For example, the order service may only need product name, price, and whether VAT applies, while the search service may need product name, category, and keywords. Even though both consume the same event, each subscriber's local schema can differ to match the service's needs.

### Comparison with Other Event Patterns

Having a clear comparison with patterns that are easy to confuse with ECST helps when making design decisions.

| Pattern | State in event | Follow-up call after receipt | Local replica | Primary purpose |
|---|---|---|---|---|
| Event Notification | Signal only | Required | Optional | Change notification |
| **ECST** | **Sufficient state** | **Not required** | **Required** | **Eliminate runtime coupling** |
| Event Sourcing | Change delta | Not required | Reconstructed by replay | Preserve state history |
| CQRS Read Model | Latest state | Not required | Required | Read optimization |

ECST has a similar purpose to the CQRS read model pattern, but differs in that replication crosses service boundaries. A CQRS read model separates reads and writes within a single service; ECST replicates state across service boundaries. This difference creates fundamental distinctions in how you manage event contracts and schema evolution strategies.

---

## Coupling and Failure Propagation from Synchronous Calls

### Dependency Chains and Failure Dominoes

The danger of synchronous call chains doesn't really sink in until you've experienced it firsthand. In a structure where service A calls B and B calls C, a response delay in C exhausts B's thread pool, which in turn blocks A's thread pool. Even if you have a circuit breaker, the moment it opens, A can no longer perform its function without B — because B depends on C's response.

This phenomenon is called a **cascading failure**: the failure of one service brings down upstream services in sequence. In a microservices environment, this risk grows in proportion to the number of services. If dozens of services are connected in a web of synchronous calls, a failure in any one of them can destabilize the entire system.

```diagram
en/2026-09-23-151ea635-02
```

Failures propagate upward through the chain, bringing the entire chain to a halt sequentially.

### Calculating Availability Loss

Looking at the numbers makes the problem with synchronous call chains even clearer. Suppose each service maintains 99.9% monthly availability (roughly 43 minutes of downtime). When these services are connected in a synchronous call chain, the overall availability of the chain becomes the product of the individual availabilities.

| Chain depth | Calculation | Composite availability | Monthly downtime |
|---|---|---|---|
| 1 | 99.9% | 99.9% | ~43 min |
| 2 | 99.9% × 99.9% | 99.8% | ~86 min |
| 4 | 99.9%⁴ | 99.6% | ~173 min |
| 6 | 99.9%⁶ | 99.4% | ~259 min |

With six services in the chain, even though each individually offers an excellent 99.9% SLA, the overall availability of the chain drops to 99.4%. ECST eliminates this availability loss entirely. A subscriber service continues operating from its local replica even when the publisher service is temporarily down. Once the publisher recovers, processing the backlogged events restores consistency eventually.

### Latency Accumulation

Beyond availability, latency accumulation is another problem with synchronous calls. If each service delivers a P99 latency of 20 ms, a six-level chain's P99 is already 120 ms by simple addition. In practice, because the tail latencies of independent services add up, the overall P99 of the chain can be far higher than the sum of each service's P99.

Factor in network round-trip costs, serialization and deserialization overhead, and HTTP connection pool contention, and the actual cost of a call is considerably higher than the pure processing latency. With ECST, each service processes events asynchronously, and on the request path it queries the local store. A local database or in-memory cache lookup completes in a few milliseconds, so request-response latency drops significantly.

```diagram
en/2026-09-23-151ea635-03
```

Request handling based on local lookups can reduce latency to single-digit milliseconds compared to a synchronous chain.

---

## Implementing Event-Carried State Transfer

### Designing the Event Schema

A good ECST event schema must satisfy three conditions. First, it must include enough state for the receiver to process the event without making additional calls. Second, it must not expose unnecessary sensitive information or internal implementation details. Third, it must account for backward compatibility so that existing consumers are not broken when the schema evolves.

Choose a format that can integrate with a schema registry — Avro, Protobuf, or JSON Schema. When used with Kafka, Confluent Schema Registry is widely used because it automates schema evolution and backward-compatibility validation.

Below is an example Avro schema for an ECST event published by a product service. Only the fields that subscribers need are included as the public interface; internal implementation details (such as internal cost structures and supplier information) are excluded.

```json
{
  "type": "record",
  "name": "ProductStateChanged",
  "namespace": "com.example.product.events",
  "fields": [
    {"name": "eventId",    "type": "string"},
    {"name": "occurredAt", "type": "long", "logicalType": "timestamp-millis"},
    {"name": "productId",  "type": "string"},
    {"name": "version",    "type": "long"},
    {"name": "name",       "type": "string"},
    {"name": "priceKrw",   "type": "long"},
    {"name": "taxable",    "type": "boolean"},
    {"name": "category",   "type": "string"},
    {"name": "status",     "type": {
      "type": "enum",
      "name": "ProductStatus",
      "symbols": ["ACTIVE", "DISCONTINUED", "OUT_OF_STOCK"]
    }},
    {"name": "stockQty", "type": ["null", "long"], "default": null}
  ]
}
// version field: used for optimistic locking so subscribers can ignore stale events
// stockQty: nullable — subscribers that don't need this field simply ignore null
```

Including a `version` field is important. Order within a Kafka partition is guaranteed, but when consuming across multiple partitions or replaying events, a stale event may be processed after a more recent one. Subscribers can avoid this by comparing `version` values and ignoring events with a lower version than the current local state. `eventId` can also be used for separate deduplication tracking.

### Setting Up the Consumer-Side Local Store

The subscriber service consumes events and applies them to its own local database. This local projection table is not a copy of the publisher service's table; it is an independent schema with only the columns relevant to that service's business context.

Let's look at a local projection table that the order service maintains by consuming product events, along with a Kafka consumer implementation.

```java
// Product projection entity in the order service — keeps only the fields needed for orders
@Entity
@Table(name = "product_projection")
public class ProductProjection {

    @Id
    private String  productId;
    private String  name;
    private long    priceKrw;
    private boolean taxable;
    private String  status;
    private long    version;
    private Instant lastUpdated;

    public boolean applyEvent(ProductStateChanged event) {
        // Optimistic version check: ignore stale or duplicate events
        if (event.getVersion() <= this.version) {
            return false; // skip — caller logs a warning
        }
        this.name        = event.getName();
        this.priceKrw    = event.getPriceKrw();
        this.taxable     = event.getTaxable();
        this.status      = event.getStatus().name();
        this.version     = event.getVersion();
        this.lastUpdated = Instant.ofEpochMilli(event.getOccurredAt());
        return true;
    }
}

// Kafka consumer — @KafkaListener based
@KafkaListener(topics = "product-state-changes", groupId = "order-service")
public void consume(ProductStateChanged event) {
    productProjectionRepository.findById(event.getProductId())
        .ifPresentOrElse(
            proj -> {
                boolean updated = proj.applyEvent(event);
                if (updated) productProjectionRepository.save(proj);
                // if updated == false, skip save (idempotent handling)
            },
            () -> productProjectionRepository.save(
                      ProductProjection.from(event)) // newly seen product
        );
}
// Result: successful processing updates the local DB; duplicate or stale events are automatically ignored
```

The version comparison inside `applyEvent` is the heart of idempotent processing. Under Kafka's at-least-once delivery guarantee, the same event can be delivered more than once, so the design must ensure that reprocessing the same version of an event does not change the final state. If the result would be identical, you can also skip the save call itself to reduce DB load.

### Event Publishing and the Transactional Outbox

Making the DB update and event publishing a single atomic unit in the producer service is a core reliability concern for ECST. If you simply execute the DB update and then publish to Kafka in sequence, a failure in the Kafka publish after the DB commit results in a lost event. Publishing to Kafka first is equally problematic: if the DB commit fails, a state change that never happened goes out as an event.

The **Transactional Outbox** pattern solves this. Instead of publishing directly to Kafka, you write the event to an `outbox_events` table within the same DB transaction. A separate relay process (a CDC tool such as Debezium) watches this table and publishes to Kafka. Because the DB write and event publishing are bound to the same transaction, both loss and duplicate publishing are prevented.

```diagram
en/2026-09-23-151ea635-04
```

Because the DB and the outbox table are bound in a single transaction, event loss is structurally impossible.

---

## Consistency Model and Trade-offs

### Accepting Eventual Consistency

The fundamental trade-off in ECST is **eventual consistency**. After the producer service's state changes, it takes time for the subscriber to consume the event and apply it to the local projection. During this window, the subscriber sees the old state. Under normal operation this lag is in the range of tens to hundreds of milliseconds, but it can stretch to minutes when a consumer group is slow or the broker has a problem.

How much lag is acceptable depends on the business domain. ECST is the wrong fit when strong consistency on the order of milliseconds is required, as with chat message ordering. On the other hand, it is an excellent choice for cases where a lag of seconds to minutes is tolerable — product information, user profiles, shipping addresses. In practice, many e-commerce systems accept a few minutes of propagation delay for product pricing.

> Forcing ECST onto a requirement that cannot tolerate lag will leave synchronous calls in the parts that need strong consistency, diluting the benefits of the pattern.

A scenario that comes up frequently when accepting eventual consistency is the **"can't immediately read what I just created"** problem. For example, if you register a new product and immediately try to place an order, the product may not yet exist in the order service's local projection. In such cases, you can work with the UI design to show the page only after event propagation, or consider applying the Read-Your-Writes pattern in a limited scope.

### Schema Evolution and Backward Compatibility

Another important trade-off in ECST is **schema management**. When a producer adds a new field or changes an existing field in an event schema, all subscribers already consuming that event are affected. In a synchronous API, changing one endpoint changes the contract with one client; in ECST, changing one topic's schema affects all subscribers. If there are 10 subscribers, you need to coordinate a migration schedule with all 10 teams.

With schema registry-integrated formats like Avro or Protobuf, you can enforce a policy that allows only **backward-compatible changes**. The standard approach is to add new fields with a default value, and to avoid removing existing fields — or to mark them deprecated and allow a sufficient migration window before removal.

| Change type | Backward compatible | Recommended approach |
|---|---|---|
| Adding an optional field (with default) | Compatible | Allow |
| Adding a required field | Incompatible | Split into a new topic version |
| Changing an existing field's type | Incompatible | Add a new field and migrate gradually |
| Removing an existing field | Conditionally compatible | Deprecate, then remove after subscriber migration is complete |
| Adding an enum value | Conditionally compatible | Subscribers must handle UNKNOWN |

### Duplicate Events and Idempotent Processing

Kafka's at-least-once delivery guarantee means the same event can be consumed more than once. If a consumer crashes after processing an event but before committing the offset, the same event will be reprocessed on restart. Event processing logic must therefore be **idempotent**.

Optimistic locking using the version field is the simplest approach. Applying an update only when the incoming event's version is greater than the current local state's version ensures that reprocessing the same event does not produce a different result. If you truly need exactly-once processing, you can record `eventId` in a separate table to track whether it has been handled — but version comparison is sufficient in most situations.

```diagram
en/2026-09-23-151ea635-05
```

Stale and duplicate events are ignored via version comparison, and the offset is always committed so the consumer does not stall.

---

## Considerations for Production

### Snapshots and New Subscriber Onboarding

In ECST, when a new service starts subscribing to an existing topic, it must replay all events from the beginning of that topic to build the current state. If the service is old and the event history is large, this initial replay can take hours. During the time it takes to process millions of events sequentially, the service either cannot accept traffic or must start serving with stale state — a dilemma.

The solution is a **snapshot** strategy. The producer service periodically writes the full current state to a snapshot topic or a separate object store. A new subscriber first loads the latest snapshot, then replays only the incremental events after the snapshot point to catch up to the current state. Without snapshots, you must replay millions of events from scratch; combining a snapshot with incremental replay can reduce initial onboarding time to within a few minutes.

```diagram
en/2026-09-23-151ea635-06
```

Combining snapshots with incremental event replay keeps initial onboarding cost manageable.

### Monitoring and Consumer Lag

The most important metric to watch when running ECST in production is **consumer lag**. High lag means the subscriber's local projection is far behind the publisher's current state. Under normal operation it should be within a few seconds; if it grows to minutes or tens of minutes due to a failure or processing delay, business logic will be reading stale data.

Looking at consumer lag as a raw number (message count) alone is misleading. A lag of 100 on a low-throughput topic can be serious, while a lag of 10,000 on a high-throughput topic may represent only a two-second delay. It is therefore important to also track **lag in time**. By combining Kafka's `__consumer_offsets` topic with message timestamps, you can calculate how many seconds ago the currently-in-flight message was published.

| Metric | Meaning | Recommended alert threshold |
|---|---|---|
| consumer-group-lag | Number of unprocessed messages per partition | When it exceeds the business-acceptable lag |
| consumer-lag-time | Time difference between the latest event and the message currently being processed | Sustained above 60 seconds |
| event-processing-error-rate | Ratio of processing failures | 0.1% or more |
| projection-last-updated-age | Time elapsed since the last update of a local projection | Per-domain SLA |

For business-critical projections, set up a `projection-last-updated-age` alert so you are immediately notified when any record goes unupdated beyond a certain time. Configuring a Kafka consumer group lag dashboard in Grafana with Prometheus, or in Datadog, is standard practice.

### Incremental Migration Strategy

When transitioning existing synchronous call code to ECST, an **incremental migration** is safer than a big bang. You can apply a strangler fig pattern that temporarily keeps both paths alive during the transition. Keep a rollback path open at each stage and validate stability sufficiently before moving to the next.

In **stage 1**, the producer service starts publishing events in parallel with its existing API responses. At this point, a failure in event publishing does not affect the existing API. In **stage 2**, subscriber services start consuming events and building local projections, but the projections are not yet used in actual business logic — instead, the projection data is compared against existing API responses to validate consistency. In **stage 3**, once the local projection data is confirmed to be sufficiently stable, the business logic is switched to read from the local projection instead of the synchronous API. In **stage 4**, after a sufficient monitoring period, the legacy synchronous API call code is removed entirely.

```diagram
en/2026-09-23-151ea635-07
```

A rollback path is open at each stage, so you can revert to the previous stage if a problem arises.

---

## Closing Thoughts

### Summary

The Event-Carried State Transfer pattern eliminates runtime coupling by replacing synchronous calls between microservices with event-driven state replication. There are three core principles. First, embed enough state in the event so that the receiver can process it without additional calls. Second, each service maintains the data it needs as a local projection — not a copy of the publisher's schema, but a view tailored to the service's context. Third, accept eventual consistency while defining a clear acceptable lag range for the business requirements.

In implementation, use the Transactional Outbox pattern to prevent event loss, use the version field to guarantee idempotent processing, and use a snapshot strategy to reduce initial onboarding cost for new subscribers. In production, monitor consumer lag time as the primary metric and minimize transition risk through incremental migration.

### When to Apply ECST

ECST is a strong choice when the following conditions are met: you are experiencing failure propagation or availability loss from synchronous calls between services; the data freshness requirement for queried data tolerates delays on the order of seconds to minutes; and you are already running or planning to adopt an event broker such as Kafka.

On the other hand, in domains that require strong consistency within tens of milliseconds, cases where state changes are so infrequent that the cost of maintaining a projection is unnecessary, or situations where the team has no experience operating a message broker, the operational complexity of ECST may outweigh its benefits. The realistic approach is not to eliminate all synchronous calls at once, but to selectively apply the pattern starting with the calls that are causing real availability and performance problems.
